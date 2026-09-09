/**
 * User data access. The only place SQL touching `users` lives.
 */

import { query } from "../config/db.js";

/**
 * The columns any caller may see.
 *
 * `password_hash` is absent, and its absence is the point: a projection that omits it
 * means no endpoint can leak it by accident, even if someone later spreads a whole row
 * into a response. `findByEmailWithHash` is the single deliberate exception, named so
 * that reaching for it by mistake is hard.
 */
const PUBLIC_COLUMNS = `
  id, name, email, phone, status, is_admin,
  email_verified_at, phone_verified_at,
  pending_email,
  accepted_terms_version, accepted_terms_at,
  created_at, updated_at
`;

/**
 * Finds a user by id.
 *
 * @param {string} id Must already be shape-checked — a non-UUID reaches Postgres as an
 *        invalid uuid literal and raises 22P02.
 * @returns {Promise<object | null>}
 * @throws {Error} On a database failure.
 */
export async function findUserById(id) {
  const { rows } = await query(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

/**
 * Finds a user by email, case-insensitively.
 *
 * @param {string} email
 * @returns {Promise<object | null>}
 * @throws {Error} On a database failure.
 */
export async function findUserByEmail(email) {
  // lower() on BOTH sides, matching uq_users_email_lower. Comparing on the raw column
  // would miss the row the index considers a duplicate.
  const { rows } = await query(
    `SELECT ${PUBLIC_COLUMNS} FROM users WHERE lower(email) = lower($1)`,
    [email]
  );
  return rows[0] ?? null;
}

/**
 * Finds a user by email, INCLUDING the password hash. Sign-in only.
 *
 * @param {string} email
 * @returns {Promise<object | null>}
 * @throws {Error} On a database failure.
 */
export async function findUserByEmailWithHash(email) {
  const { rows } = await query(
    `SELECT ${PUBLIC_COLUMNS}, password_hash FROM users WHERE lower(email) = lower($1)`,
    [email]
  );
  return rows[0] ?? null;
}

/**
 * Inserts a user.
 *
 * Note there is no `role` and no `isAdmin` parameter. `is_admin` defaults to false in
 * the schema and is not settable from here at all — the registration path must have no
 * route to creating platform staff, however malformed the request body.
 *
 * @param {object} user
 * @param {string} user.name
 * @param {string} user.email
 * @param {string} user.passwordHash Already hashed. This function never hashes.
 * @param {string|null} [user.phone]
 * @param {string} user.acceptedTermsVersion
 * @returns {Promise<object>} The created user, without the hash.
 * @throws {Error} With `code === "23505"` if the email is taken — the caller decides
 *         what that means. Letting the index arbitrate rather than checking first is
 *         what makes registration correct under concurrency: two simultaneous requests
 *         would both pass a check-then-insert.
 */
export async function insertUser({ name, email, passwordHash, phone = null, acceptedTermsVersion }) {
  const { rows } = await query(
    `INSERT INTO users (name, email, password_hash, phone, accepted_terms_version)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${PUBLIC_COLUMNS}`,
    [name, email, passwordHash, phone, acceptedTermsVersion]
  );
  return rows[0];
}

/**
 * Marks an email address verified.
 *
 * Takes the ADDRESS as well as the id, and matches on both. That is the guard from
 * docs/features/01-public-registration.md §3.4: a token proves control of a specific
 * address, so if the user has since changed their email the token proves nothing about
 * the new one and must not verify it.
 *
 * Also idempotent — `email_verified_at IS NULL` means a second click updates no rows
 * rather than moving the timestamp.
 *
 * @param {string} userId
 * @param {string} email The address the token was issued for.
 * @returns {Promise<object | null>} The updated user, or null if nothing matched.
 * @throws {Error} On a database failure.
 */
export async function markEmailVerified(userId, email) {
  const { rows } = await query(
    `UPDATE users
        SET email_verified_at = now(), updated_at = now()
      WHERE id = $1
        AND lower(email) = lower($2)
        AND email_verified_at IS NULL
      RETURNING ${PUBLIC_COLUMNS}`,
    [userId, email]
  );
  return rows[0] ?? null;
}

/**
 * Updates the fields a user may edit about themselves.
 *
 * `undefined` means "leave alone" and is distinguished from `null`, which for `phone`
 * means "clear it" — `COALESCE($2, name)` cannot express that difference, so each
 * field is compared against a sentinel instead.
 *
 * Note which columns are ABSENT and unreachable from here: `email` (needs proof of the
 * new address — see setPendingEmail), `status`, `is_admin`, `email_verified_at`. A
 * self-service profile update must have no route to any of them however the body is
 * shaped.
 *
 * @param {string} id
 * @param {object} fields
 * @param {string} [fields.name]
 * @param {string|null} [fields.phone]
 * @returns {Promise<object|null>} The updated user, or null if no active row matched.
 * @throws {Error} On a database failure.
 */
export async function updateProfileFields(id, { name, phone }) {
  const { rows } = await query(
    `UPDATE users
        SET name       = CASE WHEN $2::boolean THEN $3 ELSE name END,
            phone      = CASE WHEN $4::boolean THEN $5 ELSE phone END,
            updated_at = now()
      WHERE id = $1 AND status = 'ACTIVE'
      RETURNING ${PUBLIC_COLUMNS}`,
    [id, name !== undefined, name ?? null, phone !== undefined, phone ?? null]
  );
  return rows[0] ?? null;
}

/**
 * Replaces a user's password hash.
 *
 * @param {string} id
 * @param {string} passwordHash Already hashed. This function never hashes.
 * @returns {Promise<boolean>} True if a row was updated.
 * @throws {Error} On a database failure.
 */
export async function updatePasswordHash(id, passwordHash) {
  const { rowCount } = await query(
    `UPDATE users SET password_hash = $2, updated_at = now()
      WHERE id = $1 AND status = 'ACTIVE'`,
    [id, passwordHash]
  );
  return rowCount === 1;
}

/**
 * Records an address the user wants to move to, WITHOUT touching the one they have.
 *
 * The account keeps working on its current address throughout: it still signs in, still
 * receives password resets, and is still what the unique index protects. Nothing moves
 * until someone proves control of the new address (see confirmEmailChange).
 *
 * @param {string} id
 * @param {string} pendingEmail
 * @returns {Promise<object|null>} The updated user.
 * @throws {Error} On a database failure.
 */
export async function setPendingEmail(id, pendingEmail) {
  const { rows } = await query(
    `UPDATE users SET pending_email = $2, updated_at = now()
      WHERE id = $1 AND status = 'ACTIVE'
      RETURNING ${PUBLIC_COLUMNS}`,
    [id, pendingEmail]
  );
  return rows[0] ?? null;
}

/**
 * Abandons a pending email change.
 *
 * @param {string} id
 * @returns {Promise<object|null>} The updated user.
 * @throws {Error} On a database failure.
 */
export async function clearPendingEmail(id) {
  const { rows } = await query(
    `UPDATE users SET pending_email = NULL, updated_at = now()
      WHERE id = $1 AND status = 'ACTIVE'
      RETURNING ${PUBLIC_COLUMNS}`,
    [id]
  );
  return rows[0] ?? null;
}

/**
 * Promotes a pending address to the real one, and marks it verified.
 *
 * All three changes in ONE statement, because any two of them apart is a broken state:
 * an email moved but not marked verified locks a real owner out of the verified-only
 * features, and a pending_email left behind would let the same token be replayed.
 *
 * `lower(pending_email) = lower($2)` is the guard that makes this safe to call with a
 * token's address: it can only ever promote the address the user actually asked for, so
 * a token issued for some other address matches no row.
 *
 * @param {string} userId
 * @param {string} newEmail The address the token was issued for.
 * @returns {Promise<object|null>} The updated user, or null if nothing matched.
 * @throws {Error} With `code === "23505"` if another account claimed the address first
 *         — the caller decides what that means. Letting the index arbitrate rather than
 *         checking first is what keeps this correct under concurrency.
 */
export async function confirmEmailChange(userId, newEmail) {
  const { rows } = await query(
    `UPDATE users
        SET email             = $2,
            pending_email     = NULL,
            email_verified_at = now(),
            updated_at        = now()
      WHERE id = $1
        AND lower(pending_email) = lower($2)
        AND status = 'ACTIVE'
      RETURNING ${PUBLIC_COLUMNS}`,
    [userId, newEmail]
  );
  return rows[0] ?? null;
}

/**
 * Soft-deletes an account.
 *
 * SOFT, not a DELETE, and that is forced by the data model rather than chosen for
 * convenience: a marketplace accumulates bookings, reviews and payments that reference
 * a person, and the counterparty to a completed rental is entitled to their own
 * history. A hard delete would either cascade those away or be refused by a foreign
 * key.
 *
 * `status <> 'DELETED'` makes it idempotent, so a repeated request does not keep moving
 * the timestamp.
 *
 * @param {string} id
 * @returns {Promise<boolean>} True if this call was the one that deleted it.
 * @throws {Error} On a database failure.
 */
export async function softDeleteUser(id) {
  const { rowCount } = await query(
    `UPDATE users
        SET status = 'DELETED', deleted_at = now(), pending_email = NULL, updated_at = now()
      WHERE id = $1 AND status <> 'DELETED'`,
    [id]
  );
  return rowCount === 1;
}

/**
 * The subset of a user that ANYONE may see — FR-033.
 *
 * A deliberately tiny projection rather than a filter applied to PUBLIC_COLUMNS. The
 * difference matters: with a projection, a column added to the table later cannot leak
 * here by default. `email` and `phone` are the two that must never appear, and the
 * only way to be sure of that is to never select them.
 *
 * Returns null for a suspended or deleted account — a profile page for someone who is
 * no longer on the platform has nothing to say and should read as absent.
 *
 * @param {string} id Must already be shape-checked as a UUID.
 * @returns {Promise<object|null>}
 * @throws {Error} On a database failure.
 */
export async function findPublicProfileById(id) {
  const { rows } = await query(
    `SELECT id, name, created_at, email_verified_at IS NOT NULL AS email_verified
       FROM users
      WHERE id = $1 AND status = 'ACTIVE'`,
    [id]
  );
  return rows[0] ?? null;
}

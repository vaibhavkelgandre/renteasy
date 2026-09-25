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
  session_epoch,
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
 * Overwrites an UNVERIFIED account's registration details — the fix for the
 * pre-registration takeover in authService.register.
 *
 * THE GAP THIS CLOSES: registering an email that already has an unverified account
 * used to just resend a verification link to the EXISTING row, discarding whatever
 * password the new caller had just chosen. That let anyone register a victim's
 * address first, sign in (unverified sign-in is allowed), and keep that session —
 * the victim's own later registration attempt changed nothing about the account they
 * thought they were creating. This function is what the real owner's second
 * registration attempt now does instead: it genuinely reclaims the row.
 *
 * FOUR THINGS HAPPEN IN ONE STATEMENT, and all four matter:
 *   - `password_hash` is overwritten — the caller's password is the one that counts
 *     from now on, not whatever was set first.
 *   - `session_epoch = gen_random_uuid()` rotates to a fresh value, invalidating
 *     every session token that embedded the old one (see 013's migration comment
 *     and middlewares/authMiddleware.js) — an attacker's earlier session is refused
 *     on its very next request, not twelve hours from now.
 *   - `pending_email = NULL` cancels any email-change request the previous holder
 *     had in flight. Left alone, an attacker who had queued a change to their own
 *     address could still complete it later via that now-orphaned verification
 *     token — `verifyEmail`'s own guard (authService.js) already refuses a token
 *     whose proven address no longer matches `pending_email`, so clearing this one
 *     column is sufficient; there is no separate token row to hunt down and kill.
 *   - `name`/`phone`/`accepted_terms_version`/`accepted_terms_at` are all reset to
 *     what the new caller actually submitted — from their point of view this IS how
 *     they created the account, and the row should reflect that rather than
 *     whatever the previous registration happened to type in.
 *
 * `email_verified_at IS NULL AND status = 'ACTIVE'` in the WHERE clause is the whole
 * guard: `register()` already checks both before calling this, but the check-then-
 * write gap between them is exactly where a TOCTOU bug would hide, so the same
 * conditions are repeated here as the actual authority. A verified or non-ACTIVE
 * account matches nothing and this returns null, same shape as every other
 * conditional write in this file.
 *
 * @param {string} userId
 * @param {object} input
 * @param {string} input.name
 * @param {string} input.passwordHash Already hashed. This function never hashes.
 * @param {string|null} [input.phone]
 * @param {string} input.acceptedTermsVersion
 * @returns {Promise<object | null>} The updated user, or null if the row was no
 *          longer eligible (verified or not ACTIVE) by the time this ran.
 * @throws {Error} On a database failure.
 */
export async function reclaimUnverifiedRegistration(
  userId,
  { name, passwordHash, phone = null, acceptedTermsVersion }
) {
  const { rows } = await query(
    `UPDATE users
        SET name                   = $2,
            password_hash          = $3,
            phone                  = $4,
            accepted_terms_version = $5,
            accepted_terms_at      = now(),
            pending_email          = NULL,
            session_epoch          = gen_random_uuid(),
            updated_at             = now()
      WHERE id = $1
        AND email_verified_at IS NULL
        AND status = 'ACTIVE'
      RETURNING ${PUBLIC_COLUMNS}`,
    [userId, name, passwordHash, phone, acceptedTermsVersion]
  );
  return rows[0] ?? null;
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
 * TWO MORE COLUMNS MOVE IN THE SAME STATEMENT, both there for the same reason: the
 * most likely reason somebody changes their password is that they think someone else
 * has it (see profileService.changePassword's own comment).
 *   - `session_epoch = gen_random_uuid()` signs out every OTHER session on the spot
 *     — see 013's migration comment. Without it a stolen session outlives the very
 *     change meant to lock the thief out, for up to its remaining 12-hour life.
 *   - `pending_email = NULL` cancels any email-change request in flight. If the
 *     account was compromised, an attacker may have queued a change to their own
 *     address using the (soon to be invalid) password they had — same reasoning as
 *     `reclaimUnverifiedRegistration` above, and the same guarantee: `verifyEmail`
 *     refuses a token whose proven address no longer matches `pending_email`, so
 *     clearing this column is sufficient on its own.
 *
 * RETURNS THE NEW `session_epoch`, not just a boolean — `patchMyPassword`
 * (profileController.js) needs the exact value just written so it can reissue the
 * caller's own cookie embedding it, which is what keeps that one session alive while
 * every other one fails its next check. See `signAuthToken`'s own comment.
 *
 * @param {string} id
 * @param {string} passwordHash Already hashed. This function never hashes.
 * @returns {Promise<string | null>} The new `session_epoch`, or null if no row was
 *          updated.
 * @throws {Error} On a database failure.
 */
export async function updatePasswordHash(id, passwordHash) {
  const { rows } = await query(
    `UPDATE users
        SET password_hash = $2,
            pending_email  = NULL,
            session_epoch  = gen_random_uuid(),
            updated_at     = now()
      WHERE id = $1 AND status = 'ACTIVE'
      RETURNING session_epoch`,
    [id, passwordHash]
  );
  return rows[0]?.session_epoch ?? null;
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
 * `session_epoch = gen_random_uuid()` too, same reasoning as `updatePasswordHash`
 * above — the address that can recover this account has just changed, so every
 * session token issued before this moment embeds a now-stale epoch and is signed
 * out. This is deliberately true even for the legitimate owner confirming their own
 * change: the useful side effect is that whoever holds a STOLEN session but not the
 * account's password cannot survive completing a takeover, since the very session
 * they used to get here stops working the instant it succeeds, and re-authenticating
 * needs the password they never had.
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
            session_epoch     = gen_random_uuid(),
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
 * @param {(text: string, params?: unknown[]) => Promise<import("pg").QueryResult>} [exec]
 *        Defaults to the module's own `query`. `deleteOwnAccount` (profileService.js)
 *        passes `withTransaction`'s callback so this commits atomically alongside
 *        `unpublishAllListingsForOwner` — B10's fix, so a crash between the two never
 *        leaves an account deleted with its listings still live and bookable.
 * @returns {Promise<boolean>} True if this call was the one that deleted it.
 * @throws {Error} On a database failure.
 */
export async function softDeleteUser(id, exec = query) {
  const { rowCount } = await exec(
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

/**
 * Stamps when the user's last socket disconnected — migration 012.
 *
 * Called from the socket layer's disconnect handler, and only when the LAST of a
 * user's connections goes: see ws/socketServer.js.
 *
 * NO `updated_at` TOUCH, unlike every other update in this file, and that is
 * deliberate. `updated_at` means "when did this account's own details change", and
 * closing a browser tab is not a change to the account — bumping it would make every
 * user look edited every time they went offline, destroying the one column anything
 * auditing profile changes would read.
 *
 * NO `status = 'ACTIVE'` GUARD either, for the same reason it returns nothing: this
 * records a fact about a connection that has already happened. A user suspended while
 * connected still disconnected, and refusing to record it would leave their last-seen
 * frozen at whenever they were last permitted.
 *
 * @param {string} id Must already be shape-checked as a UUID.
 * @returns {Promise<void>} Nothing. No caller can act on whether a row matched — a
 *          deleted account is a legitimate outcome of a race between a disconnect and
 *          a deletion, not an error.
 * @throws {Error} On a database failure. The caller swallows it, because losing a
 *         last-seen stamp must never take down a disconnect handler.
 */
export async function updateLastSeenAt(id) {
  await query(`UPDATE users SET last_seen_at = now() WHERE id = $1`, [id]);
}

/**
 * Just enough about somebody to say whether they are around — migration 012.
 *
 * A TINY PROJECTION RATHER THAN `findUserById`, for the same reason
 * `findPublicProfileById` is one: this is read about the OTHER party to a booking, so
 * every column it selects is a column that could be leaked to them. `findUserById`
 * would hand the caller that person's email and phone on the way to fetching one
 * timestamp, and the only reliable way not to leak them is never to select them.
 *
 * `last_seen_at` is deliberately absent from `PUBLIC_COLUMNS` for the same reason.
 *
 * @param {string} id Must already be shape-checked as a UUID.
 * @returns {Promise<{ id: string, last_seen_at: Date | null } | null>} Null for an
 *          account that is not ACTIVE — somebody who is no longer on the platform is
 *          not "offline", they are absent, and a last-seen date for them says nothing
 *          useful and discloses when they left.
 * @throws {Error} On a database failure.
 */
export async function findPresenceById(id) {
  const { rows } = await query(
    `SELECT id, last_seen_at FROM users WHERE id = $1 AND status = 'ACTIVE'`,
    [id]
  );
  return rows[0] ?? null;
}

/**
 * Password reset tokens.
 *
 * Only hashes are ever written or compared here. A raw token exists in exactly two
 * places — the return of `issueToken()` and the email built from it — and never
 * touches this file.
 */

import { query } from "../config/db.js";

/**
 * How long a reset link lives. One hour, against verification's 24.
 *
 * The asymmetry is the point: a verification link is a convenience whose worst case is
 * a confirmed address, while a reset link is a live account-takeover credential
 * sitting in an inbox. An hour is comfortably enough to walk to a laptop and short
 * enough that an old mail in a breached inbox is usually worthless.
 */
const TTL_HOURS = 1;

/**
 * How long before another reset email may be sent to the same account.
 *
 * The obvious objection — that an attacker can hammer the endpoint and lock the victim
 * out of resetting — is wrong, and worth stating so nobody "fixes" this. Every request
 * an attacker triggers delivers a WORKING link to the victim's own inbox. So a long
 * window costs a legitimate user nothing while capping abuse at ~96 emails/day/address
 * — which matters on a 300/day quota shared with another project.
 *
 * Deliberately SHORTER than TTL_HOURS, so the link already sent stays valid across the
 * whole cooldown. If this ever exceeded the TTL there would be a dead window where the
 * old link had expired and a new one could not be requested.
 */
const RESEND_COOLDOWN_MINUTES = 15;

/**
 * Issues a reset token, replacing any live one — unless the cooldown forbids it.
 *
 * ONE STATEMENT, and it does three things that must not be separated: it enforces the
 * cooldown, it replaces any live token, and it does both atomically. A
 * check-then-insert version was wrong three ways at once, all three of which are
 * recorded in 002's own comments; the short version is that two concurrent requests
 * would both send, the cooldown would compare a Postgres timestamp against a JS clock,
 * and the concurrent case would raise 23505 → 409 for registered addresses only,
 * which is an enumeration oracle.
 *
 * `DO UPDATE ... WHERE` is what folds the cooldown in: when the existing row is too
 * recent the update matches nothing, the statement returns no rows, and the caller
 * learns "not issued" without a second query and without a race.
 *
 * @param {object} input
 * @param {string} input.userId
 * @param {string} input.tokenHash SHA-256 of the raw token.
 * @param {string} input.email The address this token is issued for.
 * @returns {Promise<object | null>} The stored row, or NULL when the cooldown blocked
 *          it. Null is an ordinary outcome, not an error — the caller answers
 *          identically either way.
 * @throws {Error} On a database failure.
 */
export async function issuePasswordResetToken({ userId, tokenHash, email }) {
  const { rows } = await query(
    `INSERT INTO password_reset_tokens (user_id, token_hash, email, expires_at)
     VALUES ($1, $2, $3, now() + ($4 || ' hours')::interval)
     ON CONFLICT (user_id) WHERE used_at IS NULL
     DO UPDATE SET
       token_hash = EXCLUDED.token_hash,
       email      = EXCLUDED.email,
       expires_at = EXCLUDED.expires_at,
       created_at = now()
       -- Both sides are the DATABASE's clock. This is the cooldown.
       WHERE password_reset_tokens.created_at < now() - ($5 || ' minutes')::interval
     RETURNING id, user_id, email, expires_at, created_at`,
    [userId, tokenHash, email, String(TTL_HOURS), String(RESEND_COOLDOWN_MINUTES)]
  );
  return rows[0] ?? null;
}

/**
 * Finds a reset token by its hash, WHATEVER its state.
 *
 * Unfiltered, so the caller can tell the states apart. Note that unlike verification,
 * the caller does NOT expose that difference — every failure answers identically. The
 * distinction exists for the logs and for the tests, not for the response.
 *
 * @param {string} tokenHash
 * @returns {Promise<object | null>}
 * @throws {Error} On a database failure.
 */
export async function findResetTokenByHash(tokenHash) {
  const { rows } = await query(
    `SELECT id, user_id, email, expires_at, used_at, created_at
       FROM password_reset_tokens
      WHERE token_hash = $1`,
    [tokenHash]
  );
  return rows[0] ?? null;
}

/**
 * Consumes a reset token AND sets the new password, in one statement.
 *
 * THIS FUNCTION DELIBERATELY SPANS TWO TABLES, which is the one place in this codebase
 * where `users` is written outside userRepository. The reason is that there is no
 * transaction helper here, and the two-statement version is wrong in both possible
 * orders:
 *
 *   consume, then update  →  a failure between them burns the token and leaves the old
 *                            password, so the user is stuck with a dead link
 *   update, then consume  →  a failure between them changes the password and leaves the
 *                            token LIVE, so the link can be replayed by anyone holding
 *                            the email
 *
 * The second is a security bug, not an inconvenience. A single statement with a CTE has
 * neither window: the token is claimed and the password is set, or neither happens.
 *
 * `AND used_at IS NULL` inside the CTE is the atomic claim — if two requests race,
 * exactly one updates a row and the loser gets nothing back.
 *
 * The `lower(u.email) = lower(c.email)` join condition is the §3.5 guard: the token
 * proves control of the address it was mailed to, so it must not set a password on an
 * account whose address has since changed.
 *
 * @param {object} input
 * @param {string} input.tokenId
 * @param {string} input.passwordHash Already hashed. This function never hashes.
 * @returns {Promise<object | null>} The updated user's id and email, or null when the
 *          claim failed — lost race, already used, or the address changed. The caller
 *          must not distinguish those in its response.
 * @throws {Error} On a database failure.
 */
export async function consumeTokenAndSetPassword({ tokenId, passwordHash }) {
  const { rows } = await query(
    `WITH claimed AS (
       UPDATE password_reset_tokens
          SET used_at = now()
        WHERE id = $1
          AND used_at IS NULL
        RETURNING user_id, email
     )
     UPDATE users u
        SET password_hash = $2,
            updated_at    = now()
       FROM claimed c
      WHERE u.id = c.user_id
        AND lower(u.email) = lower(c.email)
        -- A suspended or deleted account must not be recoverable by whoever holds an
        -- old reset email. Checked HERE as well as at request time, because the two
        -- can be up to an hour apart.
        AND u.status = 'ACTIVE'
      RETURNING u.id, u.email`,
    [tokenId, passwordHash]
  );
  return rows[0] ?? null;
}

/**
 * Invalidates every live reset token for a user, without consuming one.
 *
 * Not called by the reset flow itself — `consumeTokenAndSetPassword` already burns the
 * token it used, and the partial unique index means there is never a second live one.
 * This exists for the profile email-change path (FR-031), which must kill an
 * outstanding token rather than rely on the address-match guard alone.
 *
 * @param {string} userId
 * @returns {Promise<number>} How many were invalidated.
 * @throws {Error} On a database failure.
 */
export async function invalidateResetTokensForUser(userId) {
  const { rowCount } = await query(
    `UPDATE password_reset_tokens SET used_at = now()
      WHERE user_id = $1 AND used_at IS NULL`,
    [userId]
  );
  return rowCount;
}

/** Exported for the docs and the tests, so no number here is guessed at twice. */
export const resetTokenPolicy = {
  ttlHours: TTL_HOURS,
  resendCooldownMinutes: RESEND_COOLDOWN_MINUTES,
};

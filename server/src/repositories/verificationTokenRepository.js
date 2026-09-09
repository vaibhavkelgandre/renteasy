/**
 * Email verification tokens.
 *
 * Only hashes are ever written or compared here. A raw token exists in exactly two
 * places — the response from `issueToken()` and the email built from it — and never
 * touches this file.
 */

import { query } from "../config/db.js";

/** How long a link lives. */
const TTL_HOURS = 24;

/**
 * Issues a token for a user, replacing any live one.
 *
 * ONE STATEMENT, not select-then-delete-then-insert, and the difference is
 * correctness rather than tidiness: two concurrent "resend" clicks would both pass a
 * check and mint two working links. `ON CONFLICT` against `uq_evt_active_user` (the
 * partial unique index on `user_id WHERE used_at IS NULL`) makes that impossible.
 *
 * Replacing rather than accumulating is also what a user expects from "resend" — the
 * link in the older email stops working immediately.
 *
 * @param {object} input
 * @param {string} input.userId
 * @param {string} input.tokenHash SHA-256 of the raw token.
 * @param {string} input.email The address this token is issued FOR.
 * @returns {Promise<object>} The stored row.
 * @throws {Error} On a database failure.
 */
export async function issueVerificationToken({ userId, tokenHash, email }) {
  const { rows } = await query(
    `INSERT INTO email_verification_tokens (user_id, token_hash, email, expires_at)
     VALUES ($1, $2, $3, now() + ($4 || ' hours')::interval)
     ON CONFLICT (user_id) WHERE used_at IS NULL
     DO UPDATE SET
       token_hash = EXCLUDED.token_hash,
       email      = EXCLUDED.email,
       expires_at = EXCLUDED.expires_at,
       created_at = now()
     RETURNING id, user_id, email, expires_at, created_at`,
    [userId, tokenHash, email, String(TTL_HOURS)]
  );
  return rows[0];
}

/**
 * Finds a token by its hash, WHATEVER its state.
 *
 * Deliberately unfiltered. An earlier version filtered out used and expired tokens,
 * which read as safer and made a real case unreachable: a second click on a
 * verification link cannot find its own token once the first click consumed it, so an
 * idempotent "already confirmed" answer was impossible and every second click became a
 * 410. Mail clients prefetch links, so that was not a rare path.
 *
 * The caller decides what each state means — see authService.verifyEmail. Keeping the
 * decision there rather than in the query is what makes it possible to distinguish
 * "already done" from "no".
 *
 * @param {string} tokenHash
 * @returns {Promise<object | null>}
 * @throws {Error} On a database failure.
 */
export async function findTokenByHash(tokenHash) {
  const { rows } = await query(
    `SELECT id, user_id, email, expires_at, used_at, created_at
       FROM email_verification_tokens
      WHERE token_hash = $1`,
    [tokenHash]
  );
  return rows[0] ?? null;
}

/**
 * Marks a token used.
 *
 * `AND used_at IS NULL` makes this the atomic claim: if two requests race — a mail
 * client prefetching the link while the user also clicks it — exactly one updates a
 * row, and the loser sees zero.
 *
 * @param {string} id
 * @returns {Promise<boolean>} True if this call was the one that consumed it.
 * @throws {Error} On a database failure.
 */
export async function consumeToken(id) {
  const { rowCount } = await query(
    `UPDATE email_verification_tokens SET used_at = now()
      WHERE id = $1 AND used_at IS NULL`,
    [id]
  );
  return rowCount === 1;
}

/**
 * When a user last had a token issued. Drives the resend cooldown.
 *
 * @param {string} userId
 * @returns {Promise<Date | null>}
 * @throws {Error} On a database failure.
 */
export async function lastIssuedAt(userId) {
  const { rows } = await query(
    `SELECT created_at FROM email_verification_tokens
      WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
  return rows[0]?.created_at ?? null;
}

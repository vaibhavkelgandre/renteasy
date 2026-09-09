/**
 * Password hashing.
 *
 * bcrypt, and nothing else in the codebase touches a password. A plain password
 * exists in exactly two places — the request body and the argument to these two
 * functions — and never in a variable that outlives the call, never in a log line,
 * never in a database column.
 */

import bcrypt from "bcrypt";
import { env } from "../config/env.js";

/**
 * bcrypt work factor.
 *
 * 10 in production; 4 under test, and that gap is worth understanding rather than
 * treating as a hack.
 *
 * bcrypt is SLOW ON PURPOSE — that is the entire security property. Each increment
 * of the cost factor DOUBLES the work, so cost 10 is ~64× cost 4. An integration
 * suite makes hundreds of hash-and-compare calls (every fixture user, every login),
 * and at cost 10 that is minutes of a test run spent being deliberately slow for an
 * attacker who is not there.
 *
 * Safe because bcrypt embeds the cost inside the hash string itself, so
 * `verifyPassword` validates a hash of ANY cost without being told which. A
 * production hash and a test hash are both just verifiable.
 *
 * Do NOT raise the test value "for realism", and do NOT lower the production value
 * to match. The production number is the security control; the test number exists
 * because the suite has no adversary.
 */
const COST = env.isTest ? 4 : 10;

/**
 * Hashes a plain password.
 *
 * @param {string} plain The password as typed. Never logged, never stored.
 * @returns {Promise<string>} A bcrypt hash — includes the algorithm, cost and salt,
 *          which is why no separate salt column exists.
 * @throws {Error} If bcrypt fails (only on invalid input, e.g. a non-string).
 */
export async function hashPassword(plain) {
  return bcrypt.hash(plain, COST);
}

/**
 * Checks a plain password against a stored hash.
 *
 * @param {string} plain The password as submitted.
 * @param {string} hash The stored `password_hash`.
 * @returns {Promise<boolean>} True on match.
 * @throws Never. A malformed hash returns false rather than throwing, so a corrupt
 *         row is a failed login rather than a 500 that reveals the row is corrupt.
 */
export async function verifyPassword(plain, hash) {
  try {
    // bcrypt's own compare is constant-time with respect to the hash, so it does not
    // leak how much of the password matched via timing.
    return await bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
}

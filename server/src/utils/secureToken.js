/**
 * Single-use credentials that travel in a URL.
 *
 * One module for issuing and hashing, so nothing else in the codebase decides how a
 * token is generated or compared. Used by email verification now; password reset and
 * any future magic link go through the same functions.
 */

import { createHash, randomBytes } from "node:crypto";

/** 32 bytes = 256 bits. Guessing is not a threat model at this size. */
const TOKEN_BYTES = 32;

/**
 * Mints a new token.
 *
 * @returns {{ raw: string, hash: string }} `raw` goes in the email and nowhere else;
 *          `hash` is what gets stored.
 */
export function issueToken() {
  // randomBytes, from the OS CSPRNG. NEVER Math.random (predictable), never a UUID
  // (fewer random bits, and v4 encodes its version in the value), never anything
  // derived from the user id (guessable from a known account).
  const raw = randomBytes(TOKEN_BYTES).toString("base64url");
  return { raw, hash: hashToken(raw) };
}

/**
 * Hashes a token for storage or lookup.
 *
 * Plain SHA-256, NOT bcrypt, and the difference matters. bcrypt is deliberately slow
 * to defend a low-entropy secret a human chose; a 256-bit random token has nothing to
 * defend against - brute force is already impossible - and a slow hash here would
 * only make every verification click cost 60ms.
 *
 * Unsalted, deliberately: the same input must produce the same hash, or a lookup by
 * token would be impossible without scanning every row.
 *
 * @param {string} raw
 * @returns {string} Hex SHA-256.
 */
export function hashToken(raw) {
  return createHash("sha256").update(raw).digest("hex");
}

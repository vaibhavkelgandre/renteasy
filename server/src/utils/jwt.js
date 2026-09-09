/**
 * Session tokens.
 *
 * A JWT carrying only the user's id, delivered in an httpOnly cookie.
 *
 * IT CARRIES NO ROLE AND NO VERIFICATION STATE, and in this application that is more
 * than the usual caution. A JWT is frozen at signing time, so a token issued before
 * verification would still say "unverified" for its full 12-hour life - meaning
 * someone who confirms their email would be unable to list anything until they signed
 * out and back in. Both facts are read from the database on every request instead.
 *
 * A JWT is signed, not encrypted: anyone holding it can base64-decode the middle
 * segment. So it carries nothing worth reading either.
 */

import jwt from "jsonwebtoken";
import { env } from "../config/env.js";

const EXPIRES_IN = "12h";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Signs a session token.
 *
 * @param {string} userId
 * @returns {string} A signed HS256 JWT.
 * @throws {Error} If JWT_SECRET is unset - unreachable in a running process, because
 *         config/env.js refuses to boot without it. That guard exists because the
 *         alternative fails only on a SUCCESSFUL sign-in: a wrong password returns a
 *         clean 401 from the bcrypt compare, so only a correct one reaches the
 *         signing call.
 */
export function signAuthToken(userId) {
  return jwt.sign({ sub: userId }, env.jwtSecret, { algorithm: "HS256", expiresIn: EXPIRES_IN });
}

/**
 * Verifies a session token and returns its subject.
 *
 * @param {string} token
 * @returns {string | null} The user id, or null if the token is unusable for ANY
 *          reason. Collapsing every failure to null means no code path can
 *          accidentally treat a specific failure as authenticated.
 * @throws Never.
 */
export function verifyAuthToken(token) {
  try {
    // `algorithms` is PINNED. For a STRING secret, jsonwebtoken's default allowlist is
    // the whole HMAC family - so a token signed HS384 or HS512 with our own secret
    // would verify fine: a valid session created with an algorithm this app never
    // issues. Pinned on VERIFY specifically, because verify is the side where an
    // attacker-supplied header gets a vote.
    const payload = jwt.verify(token, env.jwtSecret, { algorithms: ["HS256"] });

    // Shape-checked before it is ever used in a query. A non-UUID reaches Postgres as
    // an invalid uuid literal and raises 22P02, which no error branch handles - so it
    // surfaces as a 500 with a stack trace instead of a 401.
    if (typeof payload.sub !== "string" || !UUID_PATTERN.test(payload.sub)) return null;

    return payload.sub;
  } catch {
    return null;
  }
}

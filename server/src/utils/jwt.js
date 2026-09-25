/**
 * Session tokens.
 *
 * A JWT carrying the user's id and their current session epoch, delivered in an
 * httpOnly cookie.
 *
 * IT CARRIES NO ROLE AND NO VERIFICATION STATE, and in this application that is more
 * than the usual caution. A JWT is frozen at signing time, so a token issued before
 * verification would still say "unverified" for its full 12-hour life - meaning
 * someone who confirms their email would be unable to list anything until they signed
 * out and back in. Both facts are read from the database on every request instead.
 *
 * A JWT is signed, not encrypted: anyone holding it can base64-decode the middle
 * segment. So it carries nothing worth reading either — including the session epoch,
 * which is an opaque marker, not a secret.
 */

import jwt from "jsonwebtoken";
import { env } from "../config/env.js";

const EXPIRES_IN = "12h";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Signs a session token.
 *
 * @param {string} userId
 * @param {string} sessionEpoch The user's CURRENT `session_epoch` (013's migration) —
 *        embedded so `requireAuth`/`authenticateSocket` can tell a token issued
 *        before an invalidating write (password change/reset, an email-change
 *        confirmation, a reclaimed unverified registration) from one issued after,
 *        by EXACT match rather than a timestamp comparison. See 013's migration
 *        comment for why exact-match replaced an earlier timestamp-based design.
 * @returns {string} A signed HS256 JWT.
 * @throws {Error} If JWT_SECRET is unset - unreachable in a running process, because
 *         config/env.js refuses to boot without it. That guard exists because the
 *         alternative fails only on a SUCCESSFUL sign-in: a wrong password returns a
 *         clean 401 from the bcrypt compare, so only a correct one reaches the
 *         signing call.
 */
export function signAuthToken(userId, sessionEpoch) {
  return jwt.sign({ sub: userId, se: sessionEpoch }, env.jwtSecret, {
    algorithm: "HS256",
    expiresIn: EXPIRES_IN,
  });
}

/**
 * Verifies a session token and returns its subject and embedded session epoch.
 *
 * @param {string} token
 * @returns {{ userId: string, sessionEpoch: string } | null} Null if the token is
 *          unusable for ANY reason. Collapsing every failure to null means no code
 *          path can accidentally treat a specific failure as authenticated.
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

    // `se` is this app's own claim (not JWT-standard), so its absence means either a
    // token signed before 013's migration shipped or a hand-built/forged one — either
    // way, unusable, same as every other malformed case. Shape-checked as a UUID for
    // the same reason `sub` is: it is compared against a database column, never
    // interpolated into SQL, but a consistent shape check costs nothing and catches a
    // corrupt token earlier.
    if (typeof payload.se !== "string" || !UUID_PATTERN.test(payload.se)) return null;

    return { userId: payload.sub, sessionEpoch: payload.se };
  } catch {
    return null;
  }
}

/**
 * Whether a session token's embedded epoch is still the user's CURRENT one.
 *
 * ONE FUNCTION, used by every reader of `session_epoch`
 * (middlewares/authMiddleware.js's `requireAuth`/`attachUserIfPresent`,
 * ws/socketAuth.js's `authenticateSocket`), so the comparison cannot drift into three
 * slightly different implementations.
 *
 * EXACT STRING EQUALITY, not a timestamp comparison — see 013's migration comment
 * for the full reasoning. In short: a JWT's `iat` is second-resolution while
 * Postgres's `now()` is microsecond-resolution, and comparing the two produced two
 * different failures depending on which side got rounded which way — one rejecting a
 * legitimately reissued token, the other accepting a merely-coincidental one. An
 * opaque, randomly-generated marker sidesteps the whole class of bug: two values are
 * either the same or they are not, with no clock, no rounding and no time window
 * anywhere in the comparison.
 *
 * @param {string} tokenEpoch From `verifyAuthToken`.
 * @param {string} userEpoch From the user row (`session_epoch`, never null — every
 *        row has one, including those that predate 013's migration; see its own
 *        comment on why the column is `NOT NULL DEFAULT gen_random_uuid()`).
 * @returns {boolean}
 */
export function isSessionEpochCurrent(tokenEpoch, userEpoch) {
  return tokenEpoch === userEpoch;
}

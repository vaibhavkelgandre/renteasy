/**
 * The session cookie.
 *
 * WHY A COOKIE AND NOT A HEADER: an httpOnly cookie cannot be read by JavaScript, so
 * a cross-site-scripting bug anywhere in the frontend cannot steal the session. A
 * token in `localStorage` and sent as an `Authorization` header is readable by any
 * script on the page — which means one bad dependency, one injected string rendered
 * as HTML, and the token is gone. The cost of the cookie approach is having to think
 * about CSRF, which `sameSite` below handles.
 */

import { env } from "../config/env.js";

/** One name, in one place, so a typo can't silently create a second session cookie. */
export const AUTH_COOKIE = "re_session";

/** Must match the JWT's own lifetime, or one outlives the other. 12 hours. */
const MAX_AGE_MS = 12 * 60 * 60 * 1000;

/**
 * Cookie options, shared by set and clear.
 *
 * They MUST match on both — a browser only replaces a cookie when the name, path and
 * domain all agree, so a clear with different options leaves the original in place
 * and logout silently does nothing.
 */
const options = {
  // Unreadable from JavaScript. The whole reason for using a cookie.
  httpOnly: true,

  // HTTPS only, in production. Omitted locally because there is no TLS on
  // http://localhost and the browser would simply refuse to store it.
  secure: env.isProduction,

  // "strict" — the cookie is not sent on ANY cross-site request, which eliminates
  // CSRF outright rather than mitigating it.
  //
  // Affordable here only because of a deployment decision: Nginx serves the frontend
  // and proxies /api on the SAME origin (one origin behind a reverse proxy), so no legitimate
  // request to this API is ever cross-site. Split the frontend and backend across two
  // domains and this would have to become "none", which needs CSRF protection added
  // back by hand.
  //
  // Public browsing is unaffected — it needs no session at all.
  sameSite: "strict",

  // Sent for every path under the app, including /api.
  path: "/",
};

/**
 * Sets the session cookie.
 *
 * @param {import("express").Response} res
 * @param {string} token A signed JWT from utils/jwt.js.
 * @returns {void}
 */
export function setAuthCookie(res, token) {
  res.cookie(AUTH_COOKIE, token, { ...options, maxAge: MAX_AGE_MS });
}

/**
 * Clears the session cookie.
 *
 * Note there is no server-side session to destroy — a JWT is stateless, so "logout"
 * is entirely "stop sending the cookie". A token already copied out of the browser
 * stays valid until it expires. That is the accepted trade for statelessness; the
 * mitigation is the 12-hour lifetime, plus the fact that authMiddleware re-reads the
 * employee's status on every request, so a DEACTIVATED employee is locked out
 * immediately even while holding a valid token.
 *
 * @param {import("express").Response} res
 * @returns {void}
 */
export function clearAuthCookie(res) {
  res.clearCookie(AUTH_COOKIE, options);
}

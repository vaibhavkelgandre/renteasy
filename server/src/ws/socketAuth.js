/**
 * Who is on the other end of a socket.
 *
 * This is `middlewares/authMiddleware.js`'s `requireAuth` for a transport that has no
 * middleware chain, and it deliberately makes the same three decisions: read the
 * session from the httpOnly cookie, verify the JWT, then READ THE USER FROM THE
 * DATABASE. NFR-5 — nothing about identity is trusted from a token.
 *
 * TWO THINGS ARE GENUINELY DIFFERENT FROM HTTP, and both are easy to get wrong.
 *
 * 1. THIS RUNS ONCE, NOT PER MESSAGE. An HTTP request re-authenticates every time; a
 *    socket authenticates at the handshake and may then live for hours. So this file
 *    establishes WHO connected and nothing more — it is not, and cannot be, the whole
 *    of NFR-5. The other two halves are in socketServer.js: a periodic revalidation
 *    sweep, and re-checking authorization inside every inbound event.
 *
 * 2. WEBSOCKETS ARE NOT SUBJECT TO CORS. There is no preflight and
 *    `Access-Control-Allow-Origin` means nothing to a handshake, so any page on the
 *    internet can open a socket to this server and the browser will attach the
 *    session cookie to it — Cross-Site WebSocket Hijacking. `SameSite=Strict` on the
 *    cookie already blocks it, but coupling the only defence to a cookie attribute
 *    somebody might one day relax to "none" is not a defence. Hence the Origin check
 *    below, which is the control that belongs to this layer.
 */

import cookieParser from "cookie-parser";
import { AUTH_COOKIE } from "../utils/cookies.js";
import { verifyAuthToken } from "../utils/jwt.js";
import { findUserById } from "../repositories/userRepository.js";
import { env } from "../config/env.js";
import { unauthorized } from "../utils/errors.js";

/**
 * Built once at import, not per connection. `cookieParser()` returns a middleware
 * function; constructing one per handshake would allocate on every connect for no
 * reason.
 *
 * No secret, matching app.js: the cookie's value is a JWT that is already signed and
 * verified by utils/jwt.js, so cookie signing would add a second secret and protect
 * nothing.
 */
const parseCookies = cookieParser();

/**
 * Whether a handshake's `Origin` may open a socket here.
 *
 * ABSENT ORIGIN IS ALLOWED, and that is not the hole it looks like. A BROWSER always
 * sends `Origin` on a WebSocket handshake — including a same-origin one — and page
 * JavaScript cannot forge or omit it. So the attack this check exists to stop always
 * arrives with an origin present and wrong. A request with no origin at all is a
 * non-browser client: the integration tests, curl, a future server-to-server caller.
 * Refusing those would block the suite while stopping nothing.
 *
 * THE ALLOWLIST IS ONE VALUE, `APP_URL` — the origin the frontend is served from,
 * which is also the origin every emailed link points at. In production the frontend
 * and this API are the same origin behind Nginx (see utils/cookies.js on why
 * `SameSite=Strict` is affordable), so one entry is the whole truth.
 *
 * THE FAILURE MODE TO RECOGNISE: if APP_URL does not match the port the dev client is
 * actually on, every socket is refused with an opaque error while HTTP keeps working
 * perfectly — because HTTP does not check origin. That reads as "websockets are
 * broken" rather than as one wrong environment variable. Same trap server.js already
 * prints `links point at:` for.
 *
 * @param {string | undefined} origin The handshake's `Origin` header.
 * @returns {boolean}
 */
export function isAllowedOrigin(origin) {
  if (!origin) return true;
  return origin === env.appUrl;
}

/**
 * Socket.IO middleware: authenticates a handshake, or refuses it.
 *
 * On success, attaches the user to `socket.data.user`. `socket.data` is Socket.IO's
 * own per-connection bag and is the counterpart of `req.user` — it is NOT sent to the
 * client, so a full user row here leaks nothing.
 *
 * EVERY FAILURE IS THE SAME REFUSAL: no cookie, an expired token, a tampered one, a
 * deleted account, a suspended one. Collapsing them is the same decision
 * `verifyAuthToken` makes by returning null for every cause — a client that could
 * tell "no session" from "suspended account" apart learns something about an account
 * it has just failed to prove it owns.
 *
 * @param {import("socket.io").Socket} socket
 * @param {(err?: Error) => void} next Called with no argument to accept, or with an
 *        Error to refuse — the client sees only `err.message`, which is why an
 *        `AppError` is safe to pass here: its message is client-safe by construction.
 * @returns {Promise<void>}
 * @throws Never. A database failure during the handshake refuses the connection rather
 *         than escalating, because there is no request to 500.
 */
export async function authenticateSocket(socket, next) {
  try {
    // `socket.request` is the raw Node IncomingMessage from the handshake, which never
    // passed through Express — so `cookie-parser` has not run on it. Running Express's
    // own middleware against it by hand is deliberate: it means there is exactly ONE
    // implementation of "how this application reads a cookie", rather than a second
    // hand-rolled parser here that could disagree with the first about encoding.
    //
    // `{}` as the response object is safe: cookie-parser reads `req.headers.cookie`
    // and writes `req.cookies`. It never touches the response.
    await new Promise((resolve) => parseCookies(socket.request, {}, resolve));

    const token = socket.request.cookies?.[AUTH_COOKIE];
    if (!token) return next(unauthorized());

    const userId = verifyAuthToken(token);
    if (!userId) return next(unauthorized());

    const user = await findUserById(userId);
    if (!user || user.status !== "ACTIVE") return next(unauthorized());

    socket.data.user = user;
    next();
  } catch {
    next(unauthorized());
  }
}

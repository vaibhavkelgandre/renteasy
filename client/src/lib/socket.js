/**
 * The single socket for the whole app — the realtime counterpart of `api.js`.
 *
 * Nothing else imports `socket.io-client`, for the same four reasons that file gives
 * for owning `fetch`: the path, the credentials, the error shape and the lifecycle are
 * decided once rather than per screen. It is also the one module a test needs to mock,
 * instead of every component that happens to want a live update.
 *
 * ONE CONNECTION, NOT ONE PER COMPONENT. A socket is expensive to open and the server
 * counts people by it — five screens each opening their own would report one visitor
 * as five, and would pay five handshakes to do it. The thread, and later the bell,
 * share this.
 *
 * IT IS OPENED LAZILY AND CLOSED ON SIGN-OUT. `getSocket()` connects on first use,
 * which is always from behind the authenticated part of the app; `closeSocket()` is
 * called by `AuthContext` on logout, because a socket that outlives the session is an
 * authenticated connection belonging to somebody who has left.
 */

import { io } from "socket.io-client";
import { ApiError } from "./api.js";

/**
 * Must match `SOCKET_PATH` in the server's `ws/socketServer.js`.
 *
 * Under `/api` so the one proxy rule that already forwards the API — Vite's in
 * development, Nginx's in production — carries the handshake too, with nothing new to
 * configure in either. A mismatch here is silent on the client and shows only as a
 * connection that never establishes.
 */
const SOCKET_PATH = "/api/socket.io";

/**
 * How long to wait for an acknowledgement before giving up.
 *
 * Needed because an `emit` with a callback has NO timeout of its own: if the server
 * never answers, the promise below would never settle and the composer would sit
 * disabled forever with no error. Generous, because this only fires when something is
 * actually wrong.
 */
const ACK_TIMEOUT_MS = 10_000;

let socket = null;

/**
 * The shared socket, connecting it if this is the first caller.
 *
 * @returns {import("socket.io-client").Socket}
 */
export function getSocket() {
  if (socket) return socket;

  // No URL: connect to the page's own origin. That is what makes the session cookie a
  // first-party cookie on the handshake, exactly as `api.js` relies on being
  // same-origin — and it is also what satisfies the server's Origin allowlist.
  socket = io({
    path: SOCKET_PATH,

    // Explicit rather than relying on the default, because the whole authentication
    // story depends on it: a browser cannot set headers on a WebSocket, so the cookie
    // riding along with the handshake is the only way the server learns who this is.
    withCredentials: true,

    // Reconnection is left at Socket.IO's defaults on purpose: it already retries with
    // exponential backoff AND a randomisation factor. The jitter is the part worth
    // keeping — without it every client dropped by one deploy would retry in the same
    // instant, and a restarting server would be hit by its whole user base at once.
  });

  return socket;
}

/**
 * Closes the socket, if one is open. Called on sign-out.
 *
 * The reference is cleared as well as closed, so the next sign-in builds a fresh
 * connection rather than reviving one that authenticated as the previous user.
 *
 * @returns {void}
 */
export function closeSocket() {
  socket?.close();
  socket = null;
}

/**
 * Emits an event and waits for the server's acknowledgement.
 *
 * DELIBERATELY SHAPED LIKE `api.js`: it returns the envelope's `data` and throws an
 * `ApiError` on failure, so a component handles a socket failure and an HTTP failure
 * with the same `catch` — and switching a call between the two transports changes one
 * line rather than the error handling around it.
 *
 * @param {string} event
 * @param {object} [payload]
 * @returns {Promise<unknown>} The acknowledgement's `data`.
 * @throws {ApiError} When the server refuses, or when nothing answers in time.
 */
export function request(event, payload = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      // Status 0, the same code `api.js` uses for "the request never completed" — from
      // a caller's point of view an unanswered emit and an unreachable server are the
      // same problem, and neither has an HTTP status to report.
      () => reject(new ApiError(0, "The server did not respond. Check your connection.")),
      ACK_TIMEOUT_MS
    );

    getSocket().emit(event, payload, (reply) => {
      clearTimeout(timer);

      if (!reply?.success) {
        reject(new ApiError(reply?.status ?? 0, reply?.message ?? "Something went wrong", reply?.errors ?? {}));
        return;
      }

      resolve(reply.data);
    });
  });
}

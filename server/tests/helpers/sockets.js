/**
 * Realtime test harness.
 *
 * WHY THIS EXISTS AT ALL, and it is the one real cost of adding this transport.
 * Every other test in this suite drives `app` through Supertest in-process, with no
 * port bound — see the long comment at the top of `src/app.js`. A WebSocket cannot be
 * driven that way: it needs a real TCP listener to upgrade, and a real client to speak
 * frames. So these tests are the only ones in the project that bind a port.
 *
 * PORT 0, ALWAYS. The operating system assigns a free one, which is what keeps this
 * from reintroducing exactly the collision `app.js` avoids — a hardcoded port would
 * fight the dev server, and CI, and the next test file.
 *
 * `stop()` MUST BE CALLED, from an `afterEach`. Three things outlive a test otherwise:
 * the listener, the connection registry (module state, which `tests/setup.js` does not
 * truncate because it is not in the database), and any client socket — and a client
 * left connected keeps `httpServer.close()` from ever completing.
 */

import { createServer } from "node:http";
import { io as createClient } from "socket.io-client";
import { app } from "../../src/app.js";
import { createSocketServer, SOCKET_PATH } from "../../src/ws/socketServer.js";
import { connectedUserIds, resetRegistry } from "../../src/ws/connectionRegistry.js";

/** Generous: a loopback handshake is milliseconds, so anything near this is a hang. */
const CONNECT_TIMEOUT_MS = 5_000;

/**
 * Polls a condition until it holds.
 *
 * Needed because a disconnect is observed by the SERVER asynchronously: the client's
 * `disconnect()` returns immediately, while the handler that unregisters it and stamps
 * `last_seen_at` runs a tick or two later. Asserting straight after a disconnect reads
 * the state from before it — a test that passes or fails depending on machine load,
 * which is the worst kind to debug.
 *
 * @param {() => boolean | Promise<boolean>} predicate Awaited, so an asynchronous
 *        check works too — `io.in(room).fetchSockets()` is the deterministic way to
 *        observe that the SERVER has processed a disconnect, and it returns a promise.
 * @param {string} description Used in the failure message, so a timeout says which
 *        condition never came true rather than just "timed out".
 * @returns {Promise<void>}
 * @throws {Error} If the condition has not held within the timeout.
 */
export async function waitFor(predicate, description) {
  const deadline = Date.now() + CONNECT_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`Timed out waiting for: ${description}`);
}

/**
 * Emits an event and resolves with the server's acknowledgement.
 *
 * REJECTS RATHER THAN HANGING if no acknowledgement arrives. A handler that throws
 * before calling back would otherwise leave the test waiting until vitest's own
 * timeout, which reports "test timed out" and names neither the event nor the handler.
 *
 * @param {object} socket A connected client socket.
 * @param {string} event
 * @param {object} [payload]
 * @returns {Promise<{ success: boolean, status: number, message: string, data?: object, errors?: object }>}
 */
export function ask(socket, event, payload = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`No acknowledgement for "${event}"`)), CONNECT_TIMEOUT_MS);

    socket.emit(event, payload, (reply) => {
      clearTimeout(timer);
      resolve(reply);
    });
  });
}

/**
 * Resolves with the payload of the next occurrence of a server-sent event.
 *
 * THE LISTENER MUST BE ATTACHED BEFORE THE ACTION THAT TRIGGERS IT — so the call
 * pattern is to hold the promise, then act, then await it. Awaiting first would miss a
 * push that arrived while the test was still setting up, and the failure would look
 * like "the server never published" rather than "the test listened too late".
 *
 * @param {object} socket
 * @param {string} event
 * @returns {Promise<object>}
 */
export function nextEvent(socket, event) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`No "${event}" was received`)), CONNECT_TIMEOUT_MS);

    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

/**
 * Boots an HTTP server with the realtime transport attached.
 *
 * @returns {Promise<{
 *   io: import("socket.io").Server,
 *   connect: (cookie?: string, headers?: Record<string,string>) => Promise<object>,
 *   refuse: (cookie?: string, headers?: Record<string,string>) => Promise<string>,
 *   stop: () => Promise<void>
 * }>}
 */
export async function startRealtimeServer() {
  const httpServer = createServer(app);
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));

  const { io, close } = createSocketServer(httpServer);
  const url = `http://127.0.0.1:${httpServer.address().port}`;

  /** Every client this harness created, so `stop` can close them all. */
  const clients = [];

  function build(cookie, headers) {
    const socket = createClient(url, {
      path: SOCKET_PATH,

      // WebSocket only, skipping Socket.IO's HTTP long-polling handshake. Not because
      // polling is wrong — it is the fallback that makes this work behind a hostile
      // proxy — but because a test that silently ran over polling would prove nothing
      // about the transport it is meant to be testing.
      transports: ["websocket"],

      // Off, or a refused connection retries forever: the test would pass and then the
      // suite would hang with a client still backing off against a closed server.
      reconnection: false,

      // `extraHeaders` works here because this is Node. A BROWSER cannot set headers on
      // a WebSocket at all — which is exactly why this application authenticates from
      // a cookie, since the browser attaches that to the handshake by itself.
      extraHeaders: { ...(cookie ? { Cookie: cookie } : {}), ...headers },
    });

    clients.push(socket);
    return socket;
  }

  return {
    io,

    /**
     * Connects, and resolves only once the server has accepted the handshake.
     *
     * @param {string} [cookie]
     * @param {Record<string,string>} [headers]
     * @returns {Promise<object>} The connected client socket.
     */
    connect(cookie, headers = {}) {
      const socket = build(cookie, headers);

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Socket never connected")), CONNECT_TIMEOUT_MS);

        socket.on("connect", () => {
          clearTimeout(timer);
          resolve(socket);
        });

        socket.on("connect_error", (error) => {
          clearTimeout(timer);
          reject(new Error(`Connection refused: ${error.message}`));
        });
      });
    },

    /**
     * The inverse: asserts the handshake is REFUSED, and hands back why.
     *
     * A separate function rather than a try/catch around `connect`, because "it
     * connected when it should not have" has to fail the test loudly. Swallowed by an
     * `expect().rejects`, that case would look identical to a refusal.
     *
     * @param {string} [cookie]
     * @param {Record<string,string>} [headers]
     * @returns {Promise<string>} The refusal message the client received.
     */
    refuse(cookie, headers = {}) {
      const socket = build(cookie, headers);

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Neither connected nor refused")), CONNECT_TIMEOUT_MS);

        socket.on("connect", () => {
          clearTimeout(timer);
          reject(new Error("The handshake was ACCEPTED, and should not have been"));
        });

        socket.on("connect_error", (error) => {
          clearTimeout(timer);
          resolve(error.message);
        });
      });
    },

    /**
     * Closes everything, in the order that works.
     *
     * Clients first, then the socket server, then the listener: `httpServer.close()`
     * waits for open connections, and a WebSocket is a connection that never finishes
     * on its own — the same ordering `src/server.js` documents for shutdown.
     *
     * Then it WAITS FOR THE REGISTRY TO DRAIN before returning, so the disconnect
     * handlers have finished their `last_seen_at` writes. Without that wait, the final
     * test's handler can fire after `tests/setup.js` has closed the connection pool,
     * producing a "query after pool closed" error attributed to no test at all.
     *
     * @returns {Promise<void>}
     */
    async stop() {
      for (const socket of clients) socket.close();

      close();

      try {
        await waitFor(() => connectedUserIds().length === 0, "the registry to drain");
      } finally {
        // Belt and braces. A client killed without a clean close leaves an entry the
        // drain above never sees, and module state must not leak into the next test.
        resetRegistry();
      }

      await new Promise((resolve) => httpServer.close(resolve));
    },
  };
}

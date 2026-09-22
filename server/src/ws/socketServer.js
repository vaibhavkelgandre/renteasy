/**
 * The realtime transport.
 *
 * WHY THIS IS A FACTORY AND NOT A MODULE THAT STARTS ITSELF, which is the structural
 * decision that matters most here. Socket.IO attaches to an `http.Server`, and this
 * project deliberately has no `http.Server` in `app.js` — that file builds the Express
 * app and never calls `listen()`, so Supertest can drive it in-process without binding
 * a port. So this file exports `createSocketServer(httpServer)` and nothing runs at
 * import: `server.js` calls it for the real process, and the integration tests call it
 * against their own throwaway server on an ephemeral port. Exactly the split `app.js`
 * and `server.js` already describe, applied to a second transport.
 *
 * WHAT THIS FILE OWNS: accepting a connection, deciding who it belongs to (via
 * socketAuth.js), keeping the registry honest, and making sure a socket does not
 * outlive the authorization it was opened with. It owns no features — no messages, no
 * typing, no presence broadcasts. Those arrive as handlers, the way `scheduler.js`
 * takes sweeps as entries in a list rather than growing a second timer.
 *
 * ONE INSTANCE ASSUMED, the same assumption `scheduler.js` writes down. Rooms and the
 * connection registry are per process, so a second instance would deliver to only the
 * half of the connections it happens to hold. That needs `@socket.io/redis-adapter`
 * plus sticky sessions at the proxy — deferred, not forgotten, and
 * `connectionRegistry.js` is the file that changes.
 */

import { Server } from "socket.io";
import { authenticateSocket, isAllowedOrigin } from "./socketAuth.js";
import { connectedUserIds, register, unregister, userRoom } from "./connectionRegistry.js";
import { BOOKING_ROOM_PREFIX, setSocketServer } from "./socketPublisher.js";
import { registerThreadHandlers } from "./threadHandlers.js";
import { findUserById, updateLastSeenAt } from "../repositories/userRepository.js";

/**
 * Where the socket endpoint lives.
 *
 * UNDER `/api` DELIBERATELY, which is the whole reason it is not the default
 * `/socket.io`. Nginx routes to this service by the `/api` prefix and the Vite dev
 * server proxies the same prefix, so putting the handshake inside it means realtime
 * needs NO new proxy rule in either place. A default-path socket would work locally
 * and then 404 in production against a proxy that had never been told about it.
 *
 * Socket.IO claims this path on the shared server before Express sees the request, so
 * it cannot collide with a route — but nothing must ever mount `/api/socket.io` in
 * app.js either.
 */
export const SOCKET_PATH = "/api/socket.io";

/**
 * How often every live connection's account is re-checked against the database.
 *
 * THE SECOND HALF OF NFR-5. An HTTP request re-reads the user row every time; a socket
 * authenticates once at the handshake and may then sit open for twelve hours, which
 * means a suspended account keeps a live connection long after HTTP would have started
 * refusing it.
 *
 * Five minutes is chosen against what it protects: suspension is a human action taken
 * in response to a human problem, so minutes is the right unit — nobody is suspended
 * in order to stop something happening in the next second. A tighter interval would
 * multiply a query per connected user for precision nobody asked for.
 */
export const REVALIDATION_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Disconnects every socket whose account may no longer hold one.
 *
 * Exported so the tests can drive one pass directly instead of waiting five minutes
 * for a timer — the same seam `scheduler.js` gives its sweeps.
 *
 * FAILS OPEN ON A DATABASE ERROR, deliberately, and this is the one judgement call in
 * the file. Failing closed means a transient Postgres blip disconnects every connected
 * user at once: a self-inflicted outage in response to a hiccup. Failing open means a
 * suspended account keeps a socket for at most one more interval, during which it can
 * still do nothing — every inbound event re-checks authorization against the database
 * itself. This sweep is the backstop, not the gate.
 *
 * @param {import("socket.io").Server} io
 * @returns {Promise<number>} How many users were disconnected — for the log line, and
 *          for the tests to assert on.
 * @throws Never.
 */
export async function revalidateConnections(io) {
  let disconnected = 0;

  // A snapshot of the ids, not the live Map keys: the loop disconnects sockets, whose
  // handlers mutate the registry, and mutating a Map mid-iteration silently skips
  // entries.
  for (const userId of connectedUserIds()) {
    let user;
    try {
      user = await findUserById(userId);
    } catch {
      continue;
    }

    if (user && user.status === "ACTIVE") continue;

    // `true` closes the underlying connection rather than only leaving the namespace,
    // so the client's reconnect logic sees a real disconnect and backs off instead of
    // holding a socket that silently receives nothing.
    io.in(userRoom(userId)).disconnectSockets(true);
    disconnected += 1;
  }

  return disconnected;
}

/**
 * Attaches a Socket.IO server to an already-built HTTP server.
 *
 * @param {import("node:http").Server} httpServer The server `app.listen()` returned.
 * @returns {{ io: import("socket.io").Server, close: () => void }} `close` stops the
 *          revalidation timer and drops every connection. It must be called BEFORE
 *          `httpServer.close()` — see server.js for why.
 */
export function createSocketServer(httpServer) {
  const io = new Server(httpServer, {
    path: SOCKET_PATH,

    // Do NOT serve the client bundle. Socket.IO ships one and exposes it at
    // `<path>/socket.io.js` by default; the frontend installs its own from npm, so
    // serving it here is a public asset nothing fetches.
    serveClient: false,

    // The Origin check, applied to the raw handshake so it covers BOTH transports —
    // a `cors.origin` setting alone only governs the HTTP polling half, which would
    // leave a direct WebSocket handshake unchecked. See socketAuth.js on why this is
    // not CORS's job: WebSockets are not subject to CORS at all.
    allowRequest: (req, callback) => {
      callback(null, isAllowedOrigin(req.headers.origin));
    },

    // 8 KB, where the default is 1 MB.
    //
    // Nothing this socket accepts is large: the longest legal payload is a 2,000
    // character message body, and attachments stay on the multipart HTTP route where
    // file-type sniffing and size limits already live. An unbounded frame is a
    // memory-exhaustion vector no middleware sees, because a frame on an established
    // connection passes through none.
    maxHttpBufferSize: 8 * 1024,

    // Heartbeat. PINNED RATHER THAN LEFT DEFAULT, because the value is load-bearing
    // and a library upgrade must not be able to change it quietly.
    //
    // An idle TCP connection is reaped by things in the middle — Nginx and AWS ALB
    // both idle out at 60 seconds by default, and NAT tables evict sooner. A
    // 25-second ping keeps the connection inside every one of those windows; raise it
    // past 60 and connections start dying, reported as a `1006` close with no close
    // frame and no clue.
    pingInterval: 25_000,
    pingTimeout: 20_000,

    // `connectionStateRecovery` IS DELIBERATELY NOT ENABLED, and the reason is
    // authorization rather than taste. On a successful recovery Socket.IO restores the
    // connection's rooms and replays missed packets WITHOUT running the middleware
    // chain again — so `authenticateSocket` would be skipped, and a user suspended
    // during the gap would come back with their rooms intact. Catching up is done from
    // the database instead, by a client that asks for what it missed.
  });

  io.use(authenticateSocket);

  // Hand the server to the publisher, so services can push without importing it —
  // `socketPublisher.js` explains why that indirection is not ceremony but the thing
  // breaking an import cycle.
  setSocketServer(io);

  io.on("connection", (socket) => {
    const user = socket.data.user;

    // Every one of a user's sockets joins one room, so anything addressed to the
    // PERSON reaches all of their tabs and devices. Joined here rather than on
    // request: there is nothing to authorize — it is their own id — and a client that
    // has to ask is a client that can forget.
    socket.join(userRoom(user.id));
    register(user.id, socket.id);

    // What this connection is allowed to ask for. A file per feature area, registered
    // here — the same shape `scheduler.js` uses for its sweeps, so a second feature
    // adds a line rather than growing this function.
    registerThreadHandlers(socket);

    // `disconnecting`, NOT `disconnect`, and the difference is the whole reason this
    // moved. On `disconnect` the socket has already left its rooms, so there is no
    // way left to ask which conversations this person was in — and telling the other
    // party they have gone is exactly what has to happen now. On `disconnecting` the
    // rooms are still there.
    //
    // NEVER CONDITIONAL. The registry can only drift from reality if a socket it
    // accepted is never unregistered, and this handler is the only thing that
    // unregisters. `disconnecting` fires exactly once per connection, like
    // `disconnect` did.
    socket.on("disconnecting", async () => {
      const rooms = [...socket.rooms].filter((room) => room.startsWith(BOOKING_ROOM_PREFIX));
      const wentOffline = unregister(user.id, socket.id);

      // Only the LAST socket counts as leaving — for the stamp and for the
      // broadcast alike. Closing one of three tabs is not going away, and announcing
      // it would show somebody as offline while they carry on typing on their phone.
      if (!wentOffline) return;

      // Sent before the database write, and with a timestamp generated here rather
      // than read back from `now()`. The two differ by the width of one UPDATE, and
      // the value is only ever rendered as "last seen a few minutes ago" — waiting
      // for a round trip to make it exact would delay the only part anybody sees.
      const lastSeenAt = new Date().toISOString();
      for (const room of rooms) {
        socket.to(room).emit("presence:changed", {
          // Carried even though it is implied by the room, so this payload matches
          // the one `thread:join` sends. One socket serves the whole app, so a client
          // filters by conversation — and a field present on one presence event and
          // absent on the other is exactly the shape that filter gets wrong.
          bookingId: room.slice(BOOKING_ROOM_PREFIX.length),
          userId: user.id,
          online: false,
          lastSeenAt,
        });
      }

      try {
        await updateLastSeenAt(user.id);
      } catch (error) {
        // Swallowed on purpose. This is an async handler, so a rejection here is an
        // unhandled rejection — which terminates the process in Node. Losing a
        // last-seen stamp is worth nothing; killing the server because somebody closed
        // a tab while Postgres blinked is worth a great deal.
        console.error(`[ws] last_seen_at for ${user.id} failed: ${error.message}`);
      }
    });
  });

  const timer = setInterval(() => {
    void revalidateConnections(io).then((count) => {
      if (count > 0) console.log(`[ws] revalidation disconnected ${count} user(s)`);
    });
  }, REVALIDATION_INTERVAL_MS);

  // `unref` so this timer alone never keeps the process alive. Staying up is the HTTP
  // server's job; an interval that also holds the loop open is how a test that forgets
  // to close hangs vitest with no explanation — the same failure the connection pool
  // already causes in tests/setup.js.
  timer.unref();

  return {
    io,

    // `disconnectSockets`, NOT `io.close()`. `io.close()` also closes the underlying
    // HTTP server, which would reach around the ordered drain sequence in server.js
    // and close it a second time.
    close: () => {
      clearInterval(timer);

      // Released BEFORE the sockets are dropped, so a publish racing the drain finds
      // null and does nothing rather than emitting into a server that is closing.
      // `null` is a state `publishMessage` already handles, because it is the state
      // every HTTP-only test runs in.
      setSocketServer(null);
      io.disconnectSockets(true);
    },
  };
}

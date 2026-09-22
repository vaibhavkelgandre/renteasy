/**
 * The realtime transport: who may open a socket, and how long they keep it.
 *
 * Three blocks carry the weight. The first is that a handshake is a real
 * authorization boundary and not a formality — a socket opened without a session, or
 * with a session belonging to an account that is no longer active, must be refused in
 * exactly the same way an HTTP request would be. The second is that presence counts
 * PEOPLE and not connections, because closing one of three tabs is not going away.
 * The third is the one that has no HTTP equivalent at all: a socket outlives the
 * moment it was authorized, so something has to go back and check.
 */

import { describe, it, expect, afterEach } from "vitest";
import { app } from "../src/app.js";
import { query } from "../src/config/db.js";
import { env } from "../src/config/env.js";
import { verifiedUser } from "./helpers/factories.js";
import { sessionCookieFor, startRealtimeServer, waitFor } from "./helpers/sockets.js";
import { isOnline, userRoom } from "../src/ws/connectionRegistry.js";
import { revalidateConnections } from "../src/ws/socketServer.js";

/**
 * The running harness for the current test.
 *
 * Held in a variable rather than created in a `beforeEach` so each test can start one
 * only if it needs one, and torn down below either way — an `afterEach` that runs
 * unconditionally is what stops a leaked listener from breaking the NEXT test, which
 * is the failure that would look like a bug in the socket server.
 */
let realtime;

afterEach(async () => {
  await realtime?.stop();
  realtime = undefined;
});

/** A signed-in account plus the raw cookie a socket client needs. */
async function connectableUser() {
  const { email, user } = await verifiedUser(app);
  return { user, cookie: await sessionCookieFor(email), email };
}

describe("the handshake", () => {
  it("accepts a connection carrying a valid session cookie", async () => {
    realtime = await startRealtimeServer();
    const { cookie } = await connectableUser();

    const socket = await realtime.connect(cookie);

    expect(socket.connected).toBe(true);
  });

  it("refuses a connection with no cookie at all", async () => {
    realtime = await startRealtimeServer();

    const message = await realtime.refuse();

    expect(message).toBe("Authentication required");
  });

  it("refuses a cookie that is not a usable token", async () => {
    realtime = await startRealtimeServer();

    // The SAME refusal as no cookie at all, deliberately. A client that could tell
    // "no session" from "bad session" apart learns something about a session it has
    // just failed to prove it owns — the same reason `verifyAuthToken` collapses
    // every cause to null.
    const message = await realtime.refuse("re_session=not-a-jwt");

    expect(message).toBe("Authentication required");
  });

  it("refuses an account that is no longer ACTIVE, even with a genuine token", async () => {
    realtime = await startRealtimeServer();
    const { cookie, email } = await connectableUser();

    // Signed in first, THEN suspended — which is the real sequence, and the only one
    // that produces a valid token belonging to an account that may no longer connect.
    // This is what NFR-5 buys: the token still verifies, and the database says no.
    await query(`UPDATE users SET status = 'SUSPENDED' WHERE email = $1`, [email]);

    const message = await realtime.refuse(cookie);

    expect(message).toBe("Authentication required");
  });

  it("refuses a handshake from another origin, and accepts one from our own", async () => {
    realtime = await startRealtimeServer();
    const { cookie } = await connectableUser();

    // Cross-Site WebSocket Hijacking, in one line. WebSockets are not subject to
    // CORS, so without the Origin check in socketAuth.js this connection would be
    // accepted with the victim's own cookie — attached by their own browser, to a
    // socket opened by somebody else's page.
    //
    // The refusal message is not asserted: a rejected `allowRequest` is refused by
    // engine.io before any application code runs, so the wording belongs to the
    // library. That it does not connect is the assertion.
    await expect(realtime.refuse(cookie, { Origin: "https://evil.example" })).resolves.toBeTypeOf(
      "string"
    );

    // BOTH DIRECTIONS, IN ONE TEST, and the second half is the important one: if a
    // handshake carrying ANY `Origin` were refused for some unrelated reason, the
    // assertion above would pass while proving nothing about the allowlist. Sourced
    // from `env` rather than written out, because `APP_URL` differs per environment —
    // a literal here would test the allowlist on one machine and a typo on the next.
    const allowed = await realtime.connect(cookie, { Origin: env.appUrl });

    expect(allowed.connected).toBe(true);
  });

  it("puts every one of a user's sockets into their own room", async () => {
    realtime = await startRealtimeServer();
    const { cookie, user } = await connectableUser();

    await realtime.connect(cookie);
    await realtime.connect(cookie);

    // Two tabs, one person. Anything addressed to the PERSON — the notification bell,
    // an unread count — has to reach both, or the badge is right on one screen and
    // stale on the other.
    const inRoom = await realtime.io.in(userRoom(user.id)).fetchSockets();

    expect(inRoom).toHaveLength(2);
  });
});

describe("presence", () => {
  it("reports a user online while a socket is open, and offline once it closes", async () => {
    realtime = await startRealtimeServer();
    const { cookie, user } = await connectableUser();

    const socket = await realtime.connect(cookie);
    expect(isOnline(user.id)).toBe(true);

    socket.close();

    await waitFor(() => !isOnline(user.id), "the user to go offline");
  });

  it("stays online while a second tab remains open", async () => {
    realtime = await startRealtimeServer();
    const { cookie, user } = await connectableUser();

    const first = await realtime.connect(cookie);
    await realtime.connect(cookie);

    first.close();

    // Waits on the SERVER having processed the disconnect, not on a timer — asserting
    // straight after `close()` would read the state from before it and pass for the
    // wrong reason.
    await waitFor(
      async () => (await realtime.io.in(userRoom(user.id)).fetchSockets()).length === 1,
      "the first socket to be dropped"
    );

    expect(isOnline(user.id)).toBe(true);
  });

  it("stamps last_seen_at only once the last socket closes", async () => {
    realtime = await startRealtimeServer();
    const { cookie, user } = await connectableUser();

    const first = await realtime.connect(cookie);
    const second = await realtime.connect(cookie);

    first.close();
    await waitFor(
      async () => (await realtime.io.in(userRoom(user.id)).fetchSockets()).length === 1,
      "the first socket to be dropped"
    );

    // Still null: one tab of two closing is not "last seen". Were this stamped on every
    // disconnect, the column would mean "when a tab last closed" — which is not how
    // "last seen 20 minutes ago" is read by the person reading it.
    const midway = await query(`SELECT last_seen_at FROM users WHERE id = $1`, [user.id]);
    expect(midway.rows[0].last_seen_at).toBeNull();

    second.close();
    await waitFor(() => !isOnline(user.id), "the user to go offline");

    const after = await query(`SELECT last_seen_at FROM users WHERE id = $1`, [user.id]);
    expect(after.rows[0].last_seen_at).not.toBeNull();
  });
});

describe("revalidation", () => {
  it("disconnects a user suspended after their socket was opened", async () => {
    realtime = await startRealtimeServer();
    const { cookie, user, email } = await connectableUser();

    await realtime.connect(cookie);
    expect(isOnline(user.id)).toBe(true);

    // THE CASE WITH NO HTTP EQUIVALENT. An HTTP request would start refusing on the
    // very next call, because it re-reads the row every time. A socket authenticated
    // before this update and would otherwise keep its connection — and its rooms —
    // for the full twelve-hour life of the token.
    await query(`UPDATE users SET status = 'SUSPENDED' WHERE email = $1`, [email]);

    const disconnected = await revalidateConnections(realtime.io);

    expect(disconnected).toBe(1);
    await waitFor(() => !isOnline(user.id), "the suspended user to be disconnected");
  });

  it("leaves an active user's socket alone", async () => {
    realtime = await startRealtimeServer();
    const { cookie, user } = await connectableUser();

    await realtime.connect(cookie);

    // The other half of the sweep, and the one worth pinning: a backstop that
    // disconnects people it should not have is worse than no backstop, because it
    // presents as random connection drops with nothing in the log.
    const disconnected = await revalidateConnections(realtime.io);

    expect(disconnected).toBe(0);
    expect(isOnline(user.id)).toBe(true);
  });
});

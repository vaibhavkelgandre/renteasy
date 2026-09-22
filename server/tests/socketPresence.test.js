/**
 * Typing, presence and read receipts — and the notification push behind the bell.
 *
 * What these three have in common is that none of them could exist over HTTP, which
 * is the argument for the transport in the first place. What they have in common as
 * RISKS is different: each one tells somebody something about somebody else, so the
 * assertions that matter most here are the ones about who does NOT get told — a
 * stranger, an unjoined socket, or a second tab that should not count as a departure.
 */

import { describe, it, expect, afterEach } from "vitest";
import { app } from "../src/app.js";
import { verifiedUser } from "./helpers/factories.js";
import { ask, nextEvent, sessionCookieFor, startRealtimeServer, waitFor } from "./helpers/sockets.js";

const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a" +
    "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA" +
    "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
  "base64"
);

const NEXT_MONTH = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
const iso = (days) => new Date(NEXT_MONTH.getTime() + days * 86_400_000).toISOString();

async function thread() {
  const owner = await verifiedUser(app);
  const renter = await verifiedUser(app);

  const created = await owner.agent.post("/api/listings").send({
    title: "Canon EOS R6",
    description: "Full-frame mirrorless with two batteries.",
    category: "cameras",
    condition: "GOOD",
    dailyRatePaise: 80_000,
    locality: "Kothrud",
    city: "Pune",
  });
  const listingId = created.body.data.listing.id;
  await owner.agent.post(`/api/listings/${listingId}/photos`).attach("photos", JPEG, "p.jpg");
  await owner.agent.post(`/api/listings/${listingId}/publish`);

  const booking = (
    await renter.agent.post("/api/bookings").send({
      listingId,
      startsAt: iso(0),
      endsAt: iso(3),
      message: "Shooting a wedding — could collect Friday?",
    })
  ).body.data.booking;

  return {
    owner,
    renter,
    bookingId: booking.id,
    ownerCookie: await sessionCookieFor(owner.email),
    renterCookie: await sessionCookieFor(renter.email),
  };
}

/** Both parties connected and in the thread's room. */
async function bothJoined(realtime, fixture) {
  const ownerSocket = await realtime.connect(fixture.ownerCookie);
  const renterSocket = await realtime.connect(fixture.renterCookie);

  const ownerJoin = await ask(ownerSocket, "thread:join", { bookingId: fixture.bookingId });
  const renterJoin = await ask(renterSocket, "thread:join", { bookingId: fixture.bookingId });

  return { ownerSocket, renterSocket, ownerJoin, renterJoin };
}

let realtime;

afterEach(async () => {
  await realtime?.stop();
  realtime = undefined;
});

describe("typing", () => {
  it("relays to the other party, naming who is typing", async () => {
    realtime = await startRealtimeServer();
    const fixture = await thread();
    const { ownerSocket, renterSocket } = await bothJoined(realtime, fixture);

    const seen = nextEvent(ownerSocket, "thread:typing");
    renterSocket.emit("thread:typing", { bookingId: fixture.bookingId, isTyping: true });

    const payload = await seen;

    expect(payload.isTyping).toBe(true);
    expect(payload.userId).toBe(fixture.renter.user.id);
    // The name rides along from the handshake, so rendering "Rohan is typing" costs
    // the client no lookup of its own.
    expect(payload.name).toBe(fixture.renter.user.name);
  });

  it("never echoes back to the person typing", async () => {
    realtime = await startRealtimeServer();
    const fixture = await thread();
    const { ownerSocket, renterSocket } = await bothJoined(realtime, fixture);

    let echoed = null;
    renterSocket.on("thread:typing", (payload) => {
      echoed = payload;
    });

    const seen = nextEvent(ownerSocket, "thread:typing");
    renterSocket.emit("thread:typing", { bookingId: fixture.bookingId, isTyping: true });
    await seen;

    // "You are typing" is not news to you, and an echo would make a client that
    // renders every typing event show the indicator against itself.
    expect(echoed).toBeNull();
  });

  it("refuses to relay from a socket that never joined the room", async () => {
    realtime = await startRealtimeServer();
    const fixture = await thread();

    const ownerSocket = await realtime.connect(fixture.ownerCookie);
    await ask(ownerSocket, "thread:join", { bookingId: fixture.bookingId });

    // Connected, authenticated, and a genuine party — but has not joined. Typing is
    // the one event that skips the per-event database read, so room membership is
    // the whole of its authorization; without the check it would be the one way to
    // broadcast into a conversation without being let into it.
    const stranger = await verifiedUser(app);
    const strangerSocket = await realtime.connect(await sessionCookieFor(stranger.email));

    let leaked = null;
    ownerSocket.on("thread:typing", (payload) => {
      leaked = payload;
    });

    strangerSocket.emit("thread:typing", { bookingId: fixture.bookingId, isTyping: true });

    // Nothing to await — the assertion is that nothing arrives. A round trip through
    // a real event gives the relay every chance to happen first.
    await ask(ownerSocket, "thread:read", { bookingId: fixture.bookingId });

    expect(leaked).toBeNull();
  });

  it("drops a flood rather than disconnecting the client", async () => {
    realtime = await startRealtimeServer();
    const fixture = await thread();
    const { ownerSocket, renterSocket } = await bothJoined(realtime, fixture);

    let received = 0;
    ownerSocket.on("thread:typing", () => {
      received += 1;
    });

    // Well past the 20-per-10-seconds ceiling.
    for (let i = 0; i < 60; i += 1) {
      renterSocket.emit("thread:typing", { bookingId: fixture.bookingId, isTyping: true });
    }

    await ask(renterSocket, "thread:read", { bookingId: fixture.bookingId });
    await waitFor(() => received > 0, "at least one typing event");

    expect(received).toBeLessThanOrEqual(20);
    // STILL CONNECTED. Dropping the surplus is the remedy; dropping the connection
    // would turn a cosmetic feature into a way to knock somebody offline.
    expect(renterSocket.connected).toBe(true);
  });
});

describe("presence", () => {
  it("reports the other party as online when joining a thread they are in", async () => {
    realtime = await startRealtimeServer();
    const fixture = await thread();
    const { renterJoin } = await bothJoined(realtime, fixture);

    expect(renterJoin.data.otherParty.id).toBe(fixture.owner.user.id);
    expect(renterJoin.data.otherParty.online).toBe(true);
  });

  it("reports them as offline, with a last-seen, when they are not connected", async () => {
    realtime = await startRealtimeServer();
    const fixture = await thread();

    // Connect and leave, so a last-seen exists to report.
    const ownerSocket = await realtime.connect(fixture.ownerCookie);
    ownerSocket.close();
    await waitFor(async () => {
      const probe = await realtime.connect(fixture.renterCookie);
      const joined = await ask(probe, "thread:join", { bookingId: fixture.bookingId });
      return joined.data.otherParty.online === false;
    }, "the owner to be seen as offline");

    const renterSocket = await realtime.connect(fixture.renterCookie);
    const joined = await ask(renterSocket, "thread:join", { bookingId: fixture.bookingId });

    expect(joined.data.otherParty.online).toBe(false);
    // Stamped by the disconnect handler in commit 1 — the half of presence that
    // outlives the process, because "offline" alone does not say for how long.
    expect(joined.data.otherParty.lastSeenAt).not.toBeNull();
  });

  it("tells the room when somebody arrives", async () => {
    realtime = await startRealtimeServer();
    const fixture = await thread();

    const ownerSocket = await realtime.connect(fixture.ownerCookie);
    await ask(ownerSocket, "thread:join", { bookingId: fixture.bookingId });

    const arrived = nextEvent(ownerSocket, "presence:changed");
    const renterSocket = await realtime.connect(fixture.renterCookie);
    await ask(renterSocket, "thread:join", { bookingId: fixture.bookingId });

    const payload = await arrived;

    expect(payload).toMatchObject({
      bookingId: fixture.bookingId,
      userId: fixture.renter.user.id,
      online: true,
    });
  });

  it("tells the room when somebody's last connection goes", async () => {
    realtime = await startRealtimeServer();
    const fixture = await thread();
    const { ownerSocket, renterSocket } = await bothJoined(realtime, fixture);

    const left = nextEvent(ownerSocket, "presence:changed");
    renterSocket.close();

    const payload = await left;

    // Announced from `disconnecting`, not `disconnect` — by the latter the socket has
    // already left its rooms and there is nobody left to tell.
    expect(payload).toMatchObject({
      bookingId: fixture.bookingId,
      userId: fixture.renter.user.id,
      online: false,
    });
    expect(payload.lastSeenAt).toBeTruthy();
  });

  it("says nothing when one of somebody's two tabs closes", async () => {
    realtime = await startRealtimeServer();
    const fixture = await thread();
    const { ownerSocket, renterSocket } = await bothJoined(realtime, fixture);

    const secondTab = await realtime.connect(fixture.renterCookie);
    await ask(secondTab, "thread:join", { bookingId: fixture.bookingId });

    let announced = null;
    ownerSocket.on("presence:changed", (payload) => {
      if (payload.online === false) announced = payload;
    });

    renterSocket.close();
    await waitFor(
      async () => (await realtime.io.in(`booking:${fixture.bookingId}`).fetchSockets()).length === 2,
      "the first tab to be dropped"
    );

    // Presence counts PEOPLE, not connections. Announcing this would show somebody as
    // gone while they carry on typing on their phone — which is the failure that
    // makes a presence indicator worse than none.
    expect(announced).toBeNull();
  });
});

describe("read receipts", () => {
  it("tells the sender when the other party reads the thread", async () => {
    realtime = await startRealtimeServer();
    const fixture = await thread();
    const { ownerSocket, renterSocket } = await bothJoined(realtime, fixture);

    const seen = nextEvent(ownerSocket, "thread:read");
    await ask(renterSocket, "thread:read", { bookingId: fixture.bookingId });

    const payload = await seen;

    expect(payload.bookingId).toBe(fixture.bookingId);
    expect(payload.userId).toBe(fixture.renter.user.id);
    expect(payload.readAt).toBeTruthy();
  });

  it("reports how far the other party had read when joining", async () => {
    realtime = await startRealtimeServer();
    const fixture = await thread();

    // The renter opens the thread, which moves their watermark.
    const renterSocket = await realtime.connect(fixture.renterCookie);
    await ask(renterSocket, "thread:join", { bookingId: fixture.bookingId });

    const ownerSocket = await realtime.connect(fixture.ownerCookie);
    const joined = await ask(ownerSocket, "thread:join", { bookingId: fixture.bookingId });

    // Without this, a receipt would show only if you happened to be watching at the
    // moment they looked, and would be forgotten on every reload.
    expect(joined.data.otherParty.readAt).not.toBeNull();
  });

  it("refuses to move a stranger's watermark", async () => {
    realtime = await startRealtimeServer();
    const fixture = await thread();

    const stranger = await verifiedUser(app);
    const socket = await realtime.connect(await sessionCookieFor(stranger.email));

    const reply = await ask(socket, "thread:read", { bookingId: fixture.bookingId });

    // It "only" writes a timestamp, which is exactly why it would be easy to leave
    // unauthorized — and it would let anybody silently clear a stranger's unread
    // badge.
    expect(reply.status).toBe(404);
    expect(reply.message).toBe("Booking not found");
  });
});

describe("the notification push", () => {
  it("reaches the recipient's own room, not the thread's", async () => {
    realtime = await startRealtimeServer();
    const fixture = await thread();

    // Connected but deliberately NOT joined to the thread: a notification is about
    // something that happened elsewhere, so its recipient is by definition not
    // looking at the page it concerns. Addressing it to the person rather than the
    // conversation is what makes the bell work on every page.
    const ownerSocket = await realtime.connect(fixture.ownerCookie);
    const renterSocket = await realtime.connect(fixture.renterCookie);

    let notifiedSender = null;
    renterSocket.on("notification:new", (payload) => {
      notifiedSender = payload;
    });

    const pushed = nextEvent(ownerSocket, "notification:new");
    await fixture.renter.agent
      .post(`/api/bookings/${fixture.bookingId}/messages`)
      .send({ body: "Can I collect at eight?" });

    const { notification } = await pushed;

    // Published from `notify`, the one choke point every notification type goes
    // through — so this covers the six other types without wiring of their own.
    //
    // The row carries no `user_id`: `NOTIFICATION_COLUMNS` omits it because a
    // notification is only ever read by its recipient. That the OWNER's socket
    // received it, and the sender's did not, is what proves it was addressed to a
    // person rather than broadcast to the conversation.
    expect(notification.type).toBe("BOOKING_MESSAGE");
    expect(notification.entity_id).toBe(fixture.bookingId);
    expect(notification.read_at).toBeNull();
    expect(notifiedSender).toBeNull();
  });
});

/**
 * Messages over the socket.
 *
 * Two claims carry this file. The first is that the PUSH LIVES IN THE SERVICE, not in
 * the transport: a message posted over plain HTTP has to arrive on the other party's
 * socket, or the two ways of sending have drifted into two behaviours. The second is
 * that a socket is not a way around authorization — a stranger gets the same 404 here
 * that they get over HTTP, from the same line of code, and must never end up in a room
 * where a later publish would reach them.
 *
 * The booking fixture is built locally rather than shared, matching `messages.test.js`,
 * `handover.test.js` and `reviews.test.js`, which each build their own.
 */

import { describe, it, expect, afterEach } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { sessionCookieFor, verifiedUser } from "./helpers/factories.js";
import { ask, nextEvent, startRealtimeServer } from "./helpers/sockets.js";

const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a" +
    "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA" +
    "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
  "base64"
);

const NEXT_MONTH = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
const iso = (days) => new Date(NEXT_MONTH.getTime() + days * 86_400_000).toISOString();

/** A booking with both parties signed in, and a session cookie each for their sockets. */
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
    ownerCookie: await sessionCookieFor(app, owner.email),
    renterCookie: await sessionCookieFor(app, renter.email),
  };
}

/**
 * Drives a booking transition, and FAILS LOUDLY if it did not happen.
 *
 * The assertion is the whole point of the helper. An earlier version of this file
 * posted to `/accept` and `/decline`, which do not exist — the real route is
 * `/:id/actions` with the action in the body. Supertest does not mind a 404, so the
 * setup step quietly did nothing and the test failed three lines later on a message
 * that was never written, which reads as "the publish is broken".
 *
 * @param {object} agent A signed-in supertest agent.
 * @param {string} bookingId
 * @param {string} action A key of `BOOKING_ACTIONS` — "ACCEPT", "DECLINE", …
 * @returns {Promise<void>}
 * @throws {Error} If the transition was refused.
 */
async function act(agent, bookingId, action) {
  const response = await agent.post(`/api/bookings/${bookingId}/actions`).send({ action });

  if (response.status !== 200) {
    throw new Error(`Fixture ${action} failed (${response.status}): ${response.body?.message}`);
  }
}

/** Posts a message over HTTP, returning it. Threads start EMPTY — a booking's own
 *  request message lives on the booking row and is not a line in the conversation. */
async function say(agent, bookingId, body) {
  const response = await agent.post(`/api/bookings/${bookingId}/messages`).send({ body });

  if (response.status !== 201) {
    throw new Error(`Fixture message failed (${response.status}): ${response.body?.message}`);
  }
  return response.body.data.message;
}

let realtime;

afterEach(async () => {
  await realtime?.stop();
  realtime = undefined;
});

describe("thread:join", () => {
  it("returns the thread and whether it is writable", async () => {
    realtime = await startRealtimeServer();
    const { bookingId, renter, renterCookie } = await thread();

    await say(renter.agent, bookingId, "Does it come with a charger?");

    const socket = await realtime.connect(renterCookie);
    const reply = await ask(socket, "thread:join", { bookingId });

    expect(reply.success).toBe(true);
    expect(reply.data.canSend).toBe(true);
    expect(reply.data.messages).toHaveLength(1);
    expect(reply.data.messages[0].body).toBe("Does it come with a charger?");
  });

  it("refuses somebody who is not a party, with the same 404 the HTTP route gives", async () => {
    realtime = await startRealtimeServer();
    const { bookingId } = await thread();

    const stranger = await verifiedUser(app);
    const socket = await realtime.connect(await sessionCookieFor(app, stranger.email));

    const reply = await ask(socket, "thread:join", { bookingId });

    // 404 and not 403: a stranger has no more reason to learn this booking exists than
    // to learn the id was wrong. `loadBookingForParty` decides this, and it is the
    // same function the HTTP route goes through.
    expect(reply.success).toBe(false);
    expect(reply.status).toBe(404);
    expect(reply.message).toBe("Booking not found");
  });

  it("answers a malformed booking id identically to an absent one", async () => {
    realtime = await startRealtimeServer();
    const { renterCookie } = await thread();

    const socket = await realtime.connect(renterCookie);
    const reply = await ask(socket, "thread:join", { bookingId: "not-a-uuid" });

    // Byte-identical to the refusal above, on purpose. A different wording for a
    // malformed id would tell a caller that ids are UUIDs — the same oracle
    // `validateParams` exists to close on the HTTP side.
    expect(reply.status).toBe(404);
    expect(reply.message).toBe("Booking not found");
    expect(reply.errors).toEqual({});
  });

  it("replays only what is newer than `since`", async () => {
    realtime = await startRealtimeServer();
    const { bookingId, renter, renterCookie } = await thread();

    await say(renter.agent, bookingId, "Does it come with a charger?");
    await say(renter.agent, bookingId, "And a tripod?");
    await say(renter.agent, bookingId, "Sorry, one more thing.");

    const socket = await realtime.connect(renterCookie);
    const first = await ask(socket, "thread:join", { bookingId });
    const newest = first.data.messages.at(-1).created_at;

    await say(renter.agent, bookingId, "Still on for Friday?");

    // THE RECONNECT PATH. A client that was offline asks the same `?since=` question
    // the 3-second poll asks, and gets back the gap — which is why moving to a socket
    // changed the transport and not the API.
    const caughtUp = await ask(socket, "thread:join", { bookingId, since: newest });
    const bodies = caughtUp.data.messages.map((message) => message.body);

    expect(bodies).toContain("Still on for Friday?");

    // ASSERTED AS "NOT THE OLD ONES" RATHER THAN AS AN EXACT COUNT, deliberately. The
    // message ON the boundary may come back again — `since` is inclusive at its edge
    // because the cursor loses microseconds in transit, which `findMessages` explains
    // at length. An exact count would be asserting a precision the contract does not
    // offer; what must hold is that catching up does not replay the whole thread.
    expect(bodies).not.toContain("Does it come with a charger?");
    expect(bodies).not.toContain("And a tripod?");
  });
});

describe("live delivery", () => {
  it("pushes a message posted over HTTP to the other party's socket", async () => {
    realtime = await startRealtimeServer();
    const { bookingId, renter, ownerCookie } = await thread();

    const ownerSocket = await realtime.connect(ownerCookie);
    await ask(ownerSocket, "thread:join", { bookingId });

    // THE ASSERTION THIS FILE EXISTS FOR. The publish is in `messageService`, beside
    // the notification, so it fires for the plain HTTP route as much as for
    // `message:send`. Were it in the socket handler instead, the two ways of sending
    // would behave differently and only one of them would be tested.
    const delivered = nextEvent(ownerSocket, "message:new");
    await say(renter.agent, bookingId, "Can I collect at eight?");

    const payload = await delivered;

    expect(payload.bookingId).toBe(bookingId);
    expect(payload.message.body).toBe("Can I collect at eight?");
    // `present()` ran, so the storage id never left the server.
    expect(payload.message).not.toHaveProperty("storage_id");
    expect(payload.message.hasAttachment).toBe(false);
  });

  it("delivers a message sent over the socket", async () => {
    realtime = await startRealtimeServer();
    const { bookingId, ownerCookie, renterCookie } = await thread();

    const ownerSocket = await realtime.connect(ownerCookie);
    const renterSocket = await realtime.connect(renterCookie);
    await ask(ownerSocket, "thread:join", { bookingId });
    await ask(renterSocket, "thread:join", { bookingId });

    const delivered = nextEvent(ownerSocket, "message:new");
    const reply = await ask(renterSocket, "message:send", { bookingId, body: "Eight works." });

    expect(reply.success).toBe(true);
    expect(reply.data.message.body).toBe("Eight works.");
    expect((await delivered).message.id).toBe(reply.data.message.id);
  });

  it("reaches the sender's other tab as well", async () => {
    realtime = await startRealtimeServer();
    const { bookingId, renterCookie } = await thread();

    const tabOne = await realtime.connect(renterCookie);
    const tabTwo = await realtime.connect(renterCookie);
    await ask(tabOne, "thread:join", { bookingId });
    await ask(tabTwo, "thread:join", { bookingId });

    // The publish deliberately goes to the WHOLE room including the sender, because
    // this is the case that would otherwise break: a message typed on a laptop has to
    // appear on the same person's phone. Clients merge by id, so the sender holding
    // both the acknowledgement and the broadcast is harmless.
    const onTabOne = nextEvent(tabOne, "message:new");
    await ask(tabTwo, "message:send", { bookingId, body: "Sent from my phone." });

    expect((await onTabOne).message.body).toBe("Sent from my phone.");
  });

  it("pushes the system line a booking transition writes", async () => {
    realtime = await startRealtimeServer();
    const { bookingId, owner, renterCookie } = await thread();

    const renterSocket = await realtime.connect(renterCookie);
    await ask(renterSocket, "thread:join", { bookingId });

    const delivered = nextEvent(renterSocket, "message:new");
    await act(owner.agent, bookingId, "ACCEPT");

    const payload = await delivered;

    // "Booking accepted." appears in an open thread without a reload. It is still not
    // a notification — the transition already sent one of those.
    expect(payload.message.kind).toBe("SYSTEM");
    expect(payload.message.body).toBe("Booking accepted.");
  });
});

describe("message:send authorization", () => {
  it("refuses somebody who is not a party", async () => {
    realtime = await startRealtimeServer();
    const { bookingId } = await thread();

    const stranger = await verifiedUser(app);
    const socket = await realtime.connect(await sessionCookieFor(app, stranger.email));

    const reply = await ask(socket, "message:send", { bookingId, body: "Hello?" });

    expect(reply.status).toBe(404);
    expect(reply.message).toBe("Booking not found");
  });

  it("never lets a refused join put a stranger in the room", async () => {
    realtime = await startRealtimeServer();
    const { bookingId, renter, ownerCookie } = await thread();

    const stranger = await verifiedUser(app);
    const strangerSocket = await realtime.connect(await sessionCookieFor(app, stranger.email));
    await ask(strangerSocket, "thread:join", { bookingId });

    let leaked = null;
    strangerSocket.on("message:new", (payload) => {
      leaked = payload;
    });

    // The ordering claim in `threadHandlers.js`: the room is joined only AFTER
    // `listMessages` has authorized the caller. Joining first would deliver one
    // message to a stranger before the refusal landed — and the refusal above would
    // still have looked correct.
    const ownerSocket = await realtime.connect(ownerCookie);
    await ask(ownerSocket, "thread:join", { bookingId });

    const delivered = nextEvent(ownerSocket, "message:new");
    await say(renter.agent, bookingId, "Private.");
    await delivered;

    expect(leaked).toBeNull();
  });

  it("refuses a message once the booking has closed the thread", async () => {
    realtime = await startRealtimeServer();
    const { bookingId, owner, renterCookie } = await thread();

    await act(owner.agent, bookingId, "DECLINE");

    const socket = await realtime.connect(renterCookie);
    const joined = await ask(socket, "thread:join", { bookingId });

    // Reading is never restricted — the conversation stays visible to both parties
    // permanently, because half the reason to keep it on the platform is that it is
    // evidence. Only writing closes.
    expect(joined.success).toBe(true);
    expect(joined.data.canSend).toBe(false);

    const reply = await ask(socket, "message:send", { bookingId, body: "Let me back in." });

    // 409, not 403: the request is fine and the caller is a party. It is the booking's
    // STATE that refuses — and the same `canMessage` rule the HTTP route uses, since
    // both go through `sendMessage`.
    expect(reply.status).toBe(409);
  });

  it("refuses an empty message with a field-level 400", async () => {
    realtime = await startRealtimeServer();
    const { bookingId, renterCookie } = await thread();

    const socket = await realtime.connect(renterCookie);
    const reply = await ask(socket, "message:send", { bookingId, body: "   " });

    // NFR-6 does not get an exception for a second transport. The field is named, the
    // same way the HTTP validator names it, so a client can mark the input.
    expect(reply.status).toBe(400);
    expect(reply.errors).toHaveProperty("body");
  });
});

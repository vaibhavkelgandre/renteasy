/**
 * Messages between the two parties to a booking.
 *
 * Three blocks carry the weight. The first is the safety rule — a declined booking
 * must not leave a channel open, or "request an item, get declined, keep messaging"
 * is a harassment vector anybody can open with one button. The second is the burst
 * dedupe, without which a chatty thread buries every other notification. The third
 * is that a stranger gets 404 everywhere.
 */

import { describe, it, expect } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { query } from "../src/config/db.js";
import { verifiedUser } from "./helpers/factories.js";
import { CHAT_OPEN_STATUSES, canMessage } from "../src/services/bookingStateMachine.js";

const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a" +
    "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA" +
    "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
  "base64"
);

/** Not an image at all, whatever it claims to be called — same fixture as listings.test.js. */
const NOT_AN_IMAGE = Buffer.from("<?php system($_GET['c']); ?>                    ");

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

  return { owner, renter, listingId, bookingId: booking.id };
}

const act = (agent, id, action) => agent.post(`/api/bookings/${id}/actions`).send({ action });
const send = (agent, id, body) => agent.post(`/api/bookings/${id}/messages`).send({ body });
const read = async (agent, id) => (await agent.get(`/api/bookings/${id}/messages`)).body.data;
const bell = async (agent) =>
  (await agent.get("/api/notifications")).body.data.notifications.filter(
    (n) => n.type === "BOOKING_MESSAGE"
  );

describe("the thread opens with the request", () => {
  it("lets both parties talk while the booking is only REQUESTED", async () => {
    // The point of opening chat at request rather than at accept: the questions that
    // DECIDE whether to accept all happen before anybody has agreed to anything.
    const { owner, renter, bookingId } = await thread();

    expect((await send(renter.agent, bookingId, "Does it come with a charger?")).status).toBe(201);
    expect((await send(owner.agent, bookingId, "Yes, and two batteries.")).status).toBe(201);

    const forRenter = await read(renter.agent, bookingId);
    expect(forRenter.messages.map((m) => m.body)).toEqual([
      "Does it come with a charger?",
      "Yes, and two batteries.",
    ]);
    expect(forRenter.canSend).toBe(true);
  });

  it("writes a neutral system line when the booking moves", async () => {
    const { owner, renter, bookingId } = await thread();
    await act(owner.agent, bookingId, "ACCEPT");

    const { messages } = await read(renter.agent, bookingId);
    const system = messages.filter((m) => m.kind === "SYSTEM");

    expect(system).toHaveLength(1);
    // Neutral, not addressed: both parties read this one, unlike the notification.
    expect(system[0].body).toBe("Booking accepted.");
    expect(system[0].sender_id).toBeNull();
  });
});

describe("the thread closes with the booking — the safety rule", () => {
  it("refuses new messages once a request is DECLINED, but still shows the history", async () => {
    // WITHOUT THIS, anybody can open a permanent channel to any lister by requesting
    // their item and being refused. This is the test that stops that.
    const { owner, renter, bookingId } = await thread();
    await send(renter.agent, bookingId, "Is it available?");
    await act(owner.agent, bookingId, "DECLINE");

    const refused = await send(renter.agent, bookingId, "Please reconsider. Hello? Hello?");
    expect(refused.status).toBe(409);
    expect(refused.body.message).toMatch(/closed/i);

    // Reading is never restricted — the conversation stays as a record for both.
    const { messages, canSend } = await read(renter.agent, bookingId);
    expect(canSend).toBe(false);
    expect(messages.map((m) => m.body)).toContain("Is it available?");
  });

  it("refuses the owner too — the rule is about the booking, not about who asks", async () => {
    const { owner, renter, bookingId } = await thread();
    await act(owner.agent, bookingId, "DECLINE");

    expect((await send(owner.agent, bookingId, "Actually, are you free next week?")).status).toBe(409);
    expect((await send(renter.agent, bookingId, "?")).status).toBe(409);
  });

  it("stays open through every live state", () => {
    // A pure check of the predicate, so a future state added to the machine without
    // a decision here shows up as a failure rather than as a silently closed thread.
    for (const status of CHAT_OPEN_STATUSES) {
      expect(canMessage({ status }), `${status} should be writable`).toBe(true);
    }
    for (const status of ["DECLINED", "CANCELLED", "EXPIRED"]) {
      expect(canMessage({ status }), `${status} should be closed`).toBe(false);
    }
  });

  it("gives a completed rental a grace window, then closes it", () => {
    const justEnded = { status: "COMPLETED", ends_at: new Date().toISOString() };
    expect(canMessage(justEnded)).toBe(true);

    // Measured from the booking's END, not from when it was marked complete — an
    // owner who confirms three weeks late must not thereby extend the channel.
    const longOver = {
      status: "COMPLETED",
      ends_at: new Date(Date.now() - 20 * 86_400_000).toISOString(),
    };
    expect(canMessage(longOver)).toBe(false);
  });
});

describe("the bell rings once per burst, not once per message", () => {
  it("does not ring again while the first message is still unread", async () => {
    const { owner, renter, bookingId } = await thread();

    await send(renter.agent, bookingId, "One");
    await send(renter.agent, bookingId, "Two");
    await send(renter.agent, bookingId, "Three");

    // Four lines in twenty seconds is what a chat looks like. Four rings turns the
    // bell into something people learn to ignore — and it stops working for the
    // booking notifications too, which are the ones that need answering.
    expect(await bell(owner.agent)).toHaveLength(1);
  });

  it("rings again once they have read the thread", async () => {
    const { owner, renter, bookingId } = await thread();

    await send(renter.agent, bookingId, "One");
    expect(await bell(owner.agent)).toHaveLength(1);

    // Opening the thread is what resets it.
    await read(owner.agent, bookingId);
    await send(renter.agent, bookingId, "Two");

    expect(await bell(owner.agent)).toHaveLength(2);
  });

  it("never rings the sender", async () => {
    const { owner, renter, bookingId } = await thread();
    await send(renter.agent, bookingId, "Hello");

    expect(await bell(renter.agent)).toHaveLength(0);
  });

  it("carries the sender and the item, never the message body — FR-987", async () => {
    const { owner, renter, bookingId } = await thread();
    await send(renter.agent, bookingId, "My address is 42 Example Road, flat 3");

    const [notification] = await bell(owner.agent);
    // A chat line could contain anything, and this is read on a lock screen.
    expect(notification.message).not.toMatch(/Example Road/);
    expect(notification.message).toMatch(/Canon EOS R6/);
  });
});

describe("unread counts", () => {
  it("counts the other party's messages, not your own", async () => {
    const { owner, renter, bookingId } = await thread();
    await send(renter.agent, bookingId, "One");
    await send(renter.agent, bookingId, "Two");

    const forOwner = await owner.agent.get("/api/bookings/messages/unread-count");
    expect(forOwner.body.data.total).toBe(2);
    expect(forOwner.body.data.byBooking[bookingId]).toBe(2);

    // The sender has nothing unread in their own thread.
    expect((await renter.agent.get("/api/bookings/messages/unread-count")).body.data.total).toBe(0);
  });

  it("clears when the thread is opened, and not when paging back through history", async () => {
    const { owner, renter, bookingId } = await thread();
    await send(renter.agent, bookingId, "One");

    // Scrolling up to re-read old messages must not mark the new one seen.
    await owner.agent.get(`/api/bookings/${bookingId}/messages?before=${new Date().toISOString()}`);
    expect((await owner.agent.get("/api/bookings/messages/unread-count")).body.data.total).toBe(1);

    await read(owner.agent, bookingId);
    expect((await owner.agent.get("/api/bookings/messages/unread-count")).body.data.total).toBe(0);
  });
});

describe("attachments and contact sharing", () => {
  it("accepts a photo and serves it through this app, never a provider URL", async () => {
    const { owner, renter, bookingId } = await thread();

    const sent = await renter.agent
      .post(`/api/bookings/${bookingId}/messages`)
      .attach("attachment", JPEG, "lens.jpg")
      .field("body", "Is this the right lens?");

    expect(sent.status).toBe(201);
    expect(sent.body.data.message.hasAttachment).toBe(true);
    // The storage id must never leave the server — it is the first half of a leak.
    expect(JSON.stringify(sent.body.data.message)).not.toMatch(/storage_id|cloudinary/i);

    const file = await owner.agent.get(
      `/api/bookings/${bookingId}/messages/${sent.body.data.message.id}/file`
    );
    expect(file.status).toBe(200);
    expect(file.headers["cache-control"]).toMatch(/private/);
  });

  it("REJECTS a file that is not really an image, however it is named", async () => {
    // Same guard listings.test.js already pins for listing photos — this endpoint had
    // no such check at all until it was added: multer's own fileFilter only ever sees
    // the client-declared mimetype and extension, both attacker-supplied, so a
    // renamed script previously sailed straight through to Cloudinary.
    const { renter, bookingId } = await thread();

    const sent = await renter.agent
      .post(`/api/bookings/${bookingId}/messages`)
      .attach("attachment", NOT_AN_IMAGE, { filename: "lens.jpg", contentType: "image/jpeg" });

    expect(sent.status).toBe(400);
    expect(sent.body.message).toMatch(/not a .*image/i);

    // And no message was created at all — a rejected attachment must not leave a
    // half-sent message in the thread.
    const { messages } = await read(renter.agent, bookingId);
    expect(messages).toHaveLength(0);
  });

  it("shares a phone number as a message, not as a hidden field", async () => {
    const { owner, renter, bookingId } = await thread();
    await query(`UPDATE users SET phone = '+919876543210' WHERE id = $1`, [renter.user.id]);

    const shared = await renter.agent.post(`/api/bookings/${bookingId}/messages/share-contact`);
    expect(shared.status).toBe(201);
    expect(shared.body.data.message.kind).toBe("CONTACT_SHARED");

    // Explicit, consensual, one-directional, and permanently recorded — unlike an
    // automatic reveal on accept, which is what this replaced.
    const { messages } = await read(owner.agent, bookingId);
    expect(messages.find((m) => m.kind === "CONTACT_SHARED").body).toBe("+919876543210");
  });
});

describe("the inbox", () => {
  it("lists only threads that have messages, newest activity first", async () => {
    const a = await thread();
    const b = await thread();

    // `a` has a conversation; `b` is a booking nobody has said anything on.
    await send(a.renter.agent, a.bookingId, "First");

    const { threads } = (await a.renter.agent.get("/api/bookings/messages/threads")).body.data;

    // An inbox listing every booking you ever made, most of them empty, is a list
    // people stop reading. A conversation STARTS from the booking page.
    expect(threads).toHaveLength(1);
    expect(threads[0].booking_id).toBe(a.bookingId);
    expect(threads[0].last_body).toBe("First");
    expect(b.bookingId).not.toBe(threads[0].booking_id);
  });

  it("names the OTHER party and which side you are on", async () => {
    const { owner, renter, bookingId } = await thread();
    await send(renter.agent, bookingId, "Hello");

    const forOwner = (await owner.agent.get("/api/bookings/messages/threads")).body.data.threads[0];
    const forRenter = (await renter.agent.get("/api/bookings/messages/threads")).body.data.threads[0];

    // Resolved server-side: which of the two people the caller is decides whose
    // name to show, and making the browser work that out means every consumer
    // repeats the same conditional.
    expect(forOwner.other_party_name).toBe(renter.user.name);
    expect(forOwner.my_role).toBe("owner");
    expect(forRenter.other_party_name).toBe(owner.user.name);
    expect(forRenter.my_role).toBe("renter");
  });

  it("carries the unread count per thread, and clears it when opened", async () => {
    const { owner, renter, bookingId } = await thread();
    await send(renter.agent, bookingId, "One");
    await send(renter.agent, bookingId, "Two");

    const before = (await owner.agent.get("/api/bookings/messages/threads")).body.data.threads[0];
    expect(before.unread).toBe(2);

    await read(owner.agent, bookingId);

    const after = (await owner.agent.get("/api/bookings/messages/threads")).body.data.threads[0];
    expect(after.unread).toBe(0);
  });

  it("shows a stranger nothing at all", async () => {
    const { renter, bookingId } = await thread();
    await send(renter.agent, bookingId, "Private");

    const stranger = await verifiedUser(app);
    // No id goes into this endpoint, so there is nothing to scope — the query only
    // ever returns bookings the caller is a party to.
    expect((await stranger.agent.get("/api/bookings/messages/threads")).body.data.threads).toEqual([]);
  });
});

describe("a stranger sees nothing", () => {
  it("404s on every endpoint, never 403", async () => {
    const { renter, bookingId } = await thread();
    await send(renter.agent, bookingId, "Private");

    const stranger = await verifiedUser(app);

    // 404 rather than 403: a stranger has no more reason to learn this booking
    // exists than to learn the id was wrong.
    expect((await stranger.agent.get(`/api/bookings/${bookingId}/messages`)).status).toBe(404);
    expect((await send(stranger.agent, bookingId, "Hello")).status).toBe(404);
    expect((await stranger.agent.post(`/api/bookings/${bookingId}/messages/share-contact`)).status).toBe(404);
    expect((await request(app).get(`/api/bookings/${bookingId}/messages`)).status).toBe(401);
  });
});

describe("the thread is append-only", () => {
  it("refuses an UPDATE and a DELETE at the database", async () => {
    const { renter, bookingId } = await thread();
    await send(renter.agent, bookingId, "What was agreed");

    // Half the reason to keep the conversation on the platform is that it is
    // evidence when the two parties later disagree. A thread either of them can
    // quietly edit is not evidence, and a convention is worth nothing here.
    await expect(
      query(`UPDATE booking_messages SET body = 'rewritten' WHERE booking_id = $1`, [bookingId])
    ).rejects.toThrow(/append-only/);

    await expect(
      query(`DELETE FROM booking_messages WHERE booking_id = $1`, [bookingId])
    ).rejects.toThrow(/append-only/);
  });
});

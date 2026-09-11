/**
 * In-app notifications — FR-985, FR-986.
 *
 * Two of these carry more weight than the rest. The first asserts that the
 * notification map and the state machine agree, which is what stops a future
 * transition from silently telling nobody. The second proves FR-985 literally: with
 * the notifications table made unusable, accepting a booking still works.
 */

import { describe, it, expect } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { query } from "../src/config/db.js";
import { verifiedUser } from "./helpers/factories.js";
import { BOOKING_ACTIONS } from "../src/services/bookingStateMachine.js";
import { BOOKING_NOTIFICATIONS } from "../src/services/notificationService.js";

const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a" +
    "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA" +
    "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
  "base64"
);

const NEXT_MONTH = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
const iso = (days) => new Date(NEXT_MONTH.getTime() + days * 86_400_000).toISOString();

async function marketplace() {
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

  return { owner, renter, listingId };
}

const act = (agent, id, action) => agent.post(`/api/bookings/${id}/actions`).send({ action });

const book = (agent, listingId) =>
  agent.post("/api/bookings").send({ listingId, startsAt: iso(0), endsAt: iso(3) });

const inbox = async (agent) => (await agent.get("/api/notifications")).body.data.notifications;

describe("the map and the state machine agree", () => {
  it("has a rule for EVERY action, including the ones only a sweep takes", () => {
    // The failure this prevents: adding a transition and forgetting to tell anybody
    // about it. Nothing errors — the other party simply never hears, which looks
    // like the product not working rather than like a missing map entry.
    //
    // Every action, not only the ones a person can take. The first version of this
    // test excluded `system`-only actions on the assumption that nobody needs
    // telling about an automatic change, and EXPIRE is the counterexample: it is the
    // one transition where somebody is waiting on an answer that is now never
    // coming, which is precisely when a notification earns its place.
    expect(Object.keys(BOOKING_NOTIFICATIONS).sort()).toEqual(Object.keys(BOOKING_ACTIONS).sort());
  });

  it("addresses every rule to one of the two parties", () => {
    for (const [action, rule] of Object.entries(BOOKING_NOTIFICATIONS)) {
      expect(["owner", "renter"], `${action} must target a role`).toContain(rule.to);
    }
  });

  it("never puts a figure or an address in a message — FR-987", () => {
    // These are read in a list on a phone, in public. "₹80,000 camera, Kothrud" is an
    // advertisement for a burglary; the price is one tap away behind a session.
    for (const [action, rule] of Object.entries(BOOKING_NOTIFICATIONS)) {
      const message = rule.message("Canon EOS R6");
      expect(message, `${action} leaks a figure`).not.toMatch(/[₹$]|\d{3,}/);
    }
  });
});

describe("who hears about what", () => {
  it("tells the owner about a new request, and not the renter", async () => {
    const { owner, renter, listingId } = await marketplace();
    await book(renter.agent, listingId);

    const forOwner = await inbox(owner.agent);
    expect(forOwner).toHaveLength(1);
    expect(forOwner[0].type).toBe("BOOKING_REQUESTED");
    expect(forOwner[0].message).toMatch(/Canon EOS R6/);

    // THE BUG THIS FEATURE ALWAYS SHIPS WITH: telling somebody about their own
    // action. The renter just made this request; hearing about it is noise at best.
    expect(await inbox(renter.agent)).toHaveLength(0);
  });

  it("notifies the OTHER party on every transition, never the one who acted", async () => {
    const { owner, renter, listingId } = await marketplace();
    const booking = (await book(renter.agent, listingId)).body.data.booking;

    await act(owner.agent, booking.id, "ACCEPT");
    await act(owner.agent, booking.id, "START");
    await act(renter.agent, booking.id, "CONFIRM_RECEIPT");
    await act(renter.agent, booking.id, "RETURN");
    await act(owner.agent, booking.id, "COMPLETE");

    // The owner acted three times and hears about the renter's two.
    expect((await inbox(owner.agent)).map((n) => n.type)).toEqual([
      "BOOKING_RETURNED",
      "BOOKING_RECEIPT_CONFIRMED",
      "BOOKING_REQUESTED",
    ]);

    // The renter acted twice and hears about the owner's three.
    expect((await inbox(renter.agent)).map((n) => n.type)).toEqual([
      "BOOKING_COMPLETED",
      "BOOKING_HANDED_OVER",
      "BOOKING_ACCEPTED",
    ]);
  });

  it("tells the renter when nobody answered, not the owner who ignored it", async () => {
    const { owner, renter, listingId } = await marketplace();
    const booking = (await book(renter.agent, listingId)).body.data.booking;

    await query(`UPDATE bookings SET created_at = now() - interval '49 hours' WHERE id = $1`, [
      booking.id,
    ]);

    const { sweepExpiredRequests } = await import("../src/services/bookingService.js");
    await sweepExpiredRequests();

    // Telling an owner their own inaction expired something reads as a reprimand
    // from a system that could have reminded them. The renter is the one left
    // waiting on an answer that is now never coming.
    expect((await inbox(renter.agent)).map((n) => n.type)).toContain("BOOKING_EXPIRED");
    expect((await inbox(owner.agent)).map((n) => n.type)).not.toContain("BOOKING_EXPIRED");
  });

  it("points at the booking it is about", async () => {
    const { owner, renter, listingId } = await marketplace();
    const booking = (await book(renter.agent, listingId)).body.data.booking;

    const [notification] = await inbox(owner.agent);
    expect(notification.entity_type).toBe("BOOKING");
    expect(notification.entity_id).toBe(booking.id);
  });
});

describe("FR-985 — a notification failure never fails the action", () => {
  it("accepts a booking with the notifications table unusable", async () => {
    const { owner, renter, listingId } = await marketplace();
    const booking = (await book(renter.agent, listingId)).body.data.booking;

    // Break it for real rather than mocking the service: the requirement is about
    // what happens when the database says no, and a mock would prove only that the
    // code calls a function that was told to fail.
    //
    // `NOT VALID` is what makes this possible. Rows already exist — the request
    // above wrote one — so a plain ADD CONSTRAINT is refused for violating itself
    // before the test can even start. NOT VALID skips the check against existing
    // rows and applies to new ones only, which is exactly the situation being
    // simulated: a table that has stopped accepting writes.
    await query(`ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check`);
    await query(
      `ALTER TABLE notifications
         ADD CONSTRAINT notifications_type_check
         CHECK (type = 'NOTHING_MATCHES_THIS') NOT VALID`
    );

    try {
      const accepted = await act(owner.agent, booking.id, "ACCEPT");

      // The booking moved. That is the whole requirement — a bell that misses a row
      // is a nuisance, an accept that 500s because of one is a bug in the wrong
      // feature entirely.
      expect(accepted.status).toBe(200);
      expect(accepted.body.data.booking.status).toBe("ACCEPTED");
    } finally {
      await query(`ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check`);
      await query(`ALTER TABLE notifications ADD CONSTRAINT notifications_type_check CHECK (type IN (
        'BOOKING_REQUESTED','BOOKING_ACCEPTED','BOOKING_DECLINED','BOOKING_CANCELLED',
        'BOOKING_CANCELLED_BY_OWNER','BOOKING_EXPIRED','BOOKING_HANDED_OVER',
        'BOOKING_RECEIPT_CONFIRMED','BOOKING_RETURNED','BOOKING_COMPLETED'))`);
    }
  });
});

describe("reading them", () => {
  it("counts the unread, from its own endpoint", async () => {
    const { owner, renter, listingId } = await marketplace();
    await book(renter.agent, listingId);

    const count = await owner.agent.get("/api/notifications/unread-count");
    expect(count.status).toBe(200);
    // One number and nothing else — this is polled on every page, and a payload that
    // grew a list would make the cheapest request in the product the most expensive.
    expect(count.body.data).toEqual({ unread: 1 });
  });

  it("marks one read, and says so in the count", async () => {
    const { owner, renter, listingId } = await marketplace();
    await book(renter.agent, listingId);

    const [notification] = await inbox(owner.agent);
    expect((await owner.agent.post(`/api/notifications/${notification.id}/read`)).status).toBe(200);

    expect((await owner.agent.get("/api/notifications/unread-count")).body.data.unread).toBe(0);

    // Idempotent: reading twice answers 404 rather than moving the timestamp, because
    // when they first saw it is the thing worth keeping.
    expect((await owner.agent.post(`/api/notifications/${notification.id}/read`)).status).toBe(404);
  });

  it("marks everything read at once", async () => {
    const { owner, renter, listingId } = await marketplace();
    const a = (await book(renter.agent, listingId)).body.data.booking;
    await act(owner.agent, a.id, "ACCEPT");
    await act(renter.agent, a.id, "CANCEL");

    expect((await owner.agent.get("/api/notifications/unread-count")).body.data.unread).toBe(2);

    const all = await owner.agent.post("/api/notifications/read-all");
    expect(all.body.data.read).toBe(2);
    expect((await owner.agent.get("/api/notifications/unread-count")).body.data.unread).toBe(0);
  });

  it("shows nobody else's, and refuses to mark one", async () => {
    const { owner, renter, listingId } = await marketplace();
    await book(renter.agent, listingId);

    const [theirs] = await inbox(owner.agent);
    const stranger = await verifiedUser(app);

    expect(await inbox(stranger.agent)).toHaveLength(0);

    // 404 rather than 403. A stranger has no more business learning that this
    // notification exists than that the id was wrong.
    expect((await stranger.agent.post(`/api/notifications/${theirs.id}/read`)).status).toBe(404);
    expect((await request(app).get("/api/notifications")).status).toBe(401);
  });

  it("pages, and counts the whole set rather than the page", async () => {
    const { owner, renter, listingId } = await marketplace();
    const booking = (await book(renter.agent, listingId)).body.data.booking;
    await act(owner.agent, booking.id, "ACCEPT");
    await act(renter.agent, booking.id, "CANCEL");

    const page = await owner.agent.get("/api/notifications?limit=1");
    expect(page.body.data.notifications).toHaveLength(1);
    // `total` comes from the same statement as the page, so the two cannot disagree.
    expect(page.body.data.total).toBe(2);
    expect(page.body.data.limit).toBe(1);
  });
});

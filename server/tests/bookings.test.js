/**
 * Bookings — FR-500 to FR-514.
 *
 * Three blocks carry the weight:
 *
 *   FR-514  twenty concurrent accepts must produce exactly one confirmed booking. The
 *           guard is a database constraint, and this is what proves it rather than
 *           trusting that it was written correctly.
 *   FR-502  you cannot book your own listing.
 *   FR-512  a booking is private to its two parties, and a stranger gets 404 — not
 *           403, which would confirm it exists.
 */

import { describe, it, expect } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { query } from "../src/config/db.js";
import { verifiedUser, unverifiedUser } from "./helpers/factories.js";

const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a" +
    "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA" +
    "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
  "base64"
);

/** Far enough ahead that "must start in the future" is never marginal. */
const NEXT_MONTH = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
const iso = (daysFromNextMonth) =>
  new Date(NEXT_MONTH.getTime() + daysFromNextMonth * 24 * 60 * 60 * 1000).toISOString();

/** A published listing, ready to be booked. */
async function publishedListing(agent, overrides = {}) {
  const created = await agent.post("/api/listings").send({
    title: "Canon EOS R6",
    description: "Full-frame mirrorless with two batteries and a card.",
    category: "cameras",
    condition: "GOOD",
    dailyRatePaise: 80_000,
    monthlyRatePaise: 1_500_000,
    depositPaise: 500_000,
    locality: "Kothrud",
    city: "Pune",
    ...overrides,
  });
  const id = created.body.data.listing.id;
  await agent.post(`/api/listings/${id}/photos`).attach("photos", JPEG, "p.jpg");
  await agent.post(`/api/listings/${id}/publish`);
  return id;
}

/** An owner with a published listing, and a separate renter. */
async function marketplace() {
  const owner = await verifiedUser(app);
  const renter = await verifiedUser(app);
  const listingId = await publishedListing(owner.agent);
  return { owner, renter, listingId };
}

const bookingBody = (listingId, overrides = {}) => ({
  listingId,
  startsAt: iso(0),
  endsAt: iso(4),
  ...overrides,
});

/** Requests a booking and returns it, failing loudly if the fixture itself broke. */
async function requestBooking(agent, listingId, overrides = {}) {
  const response = await agent.post("/api/bookings").send(bookingBody(listingId, overrides));
  if (response.status !== 201) {
    throw new Error(`Fixture booking failed (${response.status}): ${response.body?.message}`);
  }
  return response.body.data.booking;
}

const act = (agent, id, action, comment) =>
  agent.post(`/api/bookings/${id}/actions`).send(comment ? { action, comment } : { action });

describe("FR-502 — you cannot book your own listing", () => {
  it("refuses the owner with a 403", async () => {
    const { owner, listingId } = await marketplace();

    const response = await owner.agent.post("/api/bookings").send(bookingBody(listingId));

    // 403, not 404: the caller demonstrably knows this listing exists, because they
    // wrote it. Pretending otherwise would be absurd rather than discreet.
    expect(response.status).toBe(403);
    expect(response.body.message).toMatch(/your own listing/i);
  });

  it("refuses before revealing anything about other bookings", async () => {
    const { owner, renter, listingId } = await marketplace();
    await requestBooking(renter.agent, listingId);
    const accepted = await requestBooking(renter.agent, listingId, {
      startsAt: iso(10),
      endsAt: iso(14),
    });
    await act(owner.agent, accepted.id, "ACCEPT");

    // The owner-check runs BEFORE the overlap check, so an owner probing their own
    // listing learns nothing about who else has booked it from the shape of the
    // refusal.
    const response = await owner.agent
      .post("/api/bookings")
      .send(bookingBody(listingId, { startsAt: iso(10), endsAt: iso(14) }));

    expect(response.status).toBe(403);
    expect(response.body.message).not.toMatch(/already booked/i);
  });

  it("still lets anybody else book it", async () => {
    const { renter, listingId } = await marketplace();
    const response = await renter.agent.post("/api/bookings").send(bookingBody(listingId));
    expect(response.status).toBe(201);
  });
});

describe("FR-514 — concurrency produces exactly one confirmed booking", () => {
  it("survives twenty simultaneous accepts of overlapping requests", async () => {
    const { owner, listingId } = await marketplace();

    // Twenty different renters all asking for the same four days. Requests do not
    // hold dates, so all twenty are legitimate — the collision is the owner's to
    // resolve, and this simulates them resolving it twenty times at once.
    const requests = [];
    for (let i = 0; i < 20; i += 1) {
      const renter = await verifiedUser(app);
      requests.push(await requestBooking(renter.agent, listingId));
    }

    const results = await Promise.all(
      requests.map((booking) => act(owner.agent, booking.id, "ACCEPT"))
    );

    const accepted = results.filter((r) => r.status === 200);
    const refused = results.filter((r) => r.status === 409);

    // THE GUARANTEE. Not achieved by this application — achieved by an EXCLUDE
    // constraint that makes the alternative impossible, whatever order the requests
    // arrive in.
    expect(accepted).toHaveLength(1);
    expect(refused).toHaveLength(19);

    const { rows } = await query(
      `SELECT count(*)::int AS n FROM bookings WHERE listing_id = $1 AND status = 'ACCEPTED'`,
      [listingId]
    );
    expect(rows[0].n).toBe(1);
  });

  it("tells the losers something they can act on, not an error code", async () => {
    const { owner, listingId } = await marketplace();
    const a = await requestBooking(await verifiedUser(app).then((u) => u.agent), listingId);
    const b = await requestBooking(await verifiedUser(app).then((u) => u.agent), listingId);

    await act(owner.agent, a.id, "ACCEPT");
    const second = await act(owner.agent, b.id, "ACCEPT");

    // A 23P01 reaching the generic handler would be a 500 saying "something went
    // wrong" to an owner who did nothing wrong.
    expect(second.status).toBe(409);
    expect(second.body.message).toMatch(/overlap|already/i);
  });

  it("allows back-to-back bookings — one ends exactly as the next begins", async () => {
    const { owner, renter, listingId } = await marketplace();

    const first = await requestBooking(renter.agent, listingId, { startsAt: iso(0), endsAt: iso(4) });
    const second = await requestBooking(renter.agent, listingId, { startsAt: iso(4), endsAt: iso(8) });

    expect((await act(owner.agent, first.id, "ACCEPT")).status).toBe(200);
    // The `[)` bound. With inclusive ends, every handover in the product would be
    // refused as a clash.
    expect((await act(owner.agent, second.id, "ACCEPT")).status).toBe(200);
  });

  it("does not let one listing's booking block another listing", async () => {
    const { owner, renter, listingId } = await marketplace();
    const otherListing = await publishedListing(owner.agent, { title: "A second camera" });

    const first = await requestBooking(renter.agent, listingId);
    const second = await requestBooking(renter.agent, otherListing);

    expect((await act(owner.agent, first.id, "ACCEPT")).status).toBe(200);
    expect((await act(owner.agent, second.id, "ACCEPT")).status).toBe(200);
  });
});

describe("FR-503, FR-504 — refusals before the owner is troubled", () => {
  it("refuses dates already held by an accepted booking", async () => {
    const { owner, renter, listingId } = await marketplace();
    const first = await requestBooking(renter.agent, listingId);
    await act(owner.agent, first.id, "ACCEPT");

    const other = await verifiedUser(app);
    const response = await other.agent
      .post("/api/bookings")
      .send(bookingBody(listingId, { startsAt: iso(1), endsAt: iso(3) }));

    // Does not prevent a double booking — nothing is claimed by a request. It stops a
    // renter waiting two days for an answer on dates already committed elsewhere.
    expect(response.status).toBe(409);
    expect(response.body.message).toMatch(/already booked/i);
  });

  it("allows several REQUESTED bookings on the same dates", async () => {
    const { renter, listingId } = await marketplace();
    const other = await verifiedUser(app);

    expect((await other.agent.post("/api/bookings").send(bookingBody(listingId))).status).toBe(201);
    expect((await renter.agent.post("/api/bookings").send(bookingBody(listingId))).status).toBe(201);

    // Blocking here would make the first request win by speed rather than the owner
    // choosing, which is not what a request means.
  });

  it("enforces the minimum and maximum duration", async () => {
    const owner = await verifiedUser(app);
    const renter = await verifiedUser(app);
    const listingId = await publishedListing(owner.agent, {
      minDurationHours: 48,
      maxDurationHours: 240,
    });

    const tooShort = await renter.agent
      .post("/api/bookings")
      .send(bookingBody(listingId, { startsAt: iso(0), endsAt: iso(0.5) }));
    expect(tooShort.status).toBe(409);
    expect(tooShort.body.message).toMatch(/minimum/i);

    const tooLong = await renter.agent
      .post("/api/bookings")
      .send(bookingBody(listingId, { startsAt: iso(0), endsAt: iso(20) }));
    expect(tooLong.status).toBe(409);
    expect(tooLong.body.message).toMatch(/maximum/i);
  });

  it("refuses a start in the past and an inverted range", async () => {
    const { renter, listingId } = await marketplace();

    const past = await renter.agent.post("/api/bookings").send(
      bookingBody(listingId, {
        startsAt: new Date(Date.now() - 86_400_000).toISOString(),
        endsAt: iso(2),
      })
    );
    expect(past.status).toBe(400);

    const inverted = await renter.agent
      .post("/api/bookings")
      .send(bookingBody(listingId, { startsAt: iso(4), endsAt: iso(0) }));
    expect(inverted.status).toBe(400);
  });

  it("refuses an unverified renter — FR-501", async () => {
    const owner = await verifiedUser(app);
    const listingId = await publishedListing(owner.agent);
    const { agent } = await unverifiedUser(app);

    const response = await agent.post("/api/bookings").send(bookingBody(listingId));
    expect(response.status).toBe(403);
    expect(response.body.errors.reason).toBe("EMAIL_NOT_VERIFIED");
  });

  it("refuses a draft or unpublished listing as simply absent", async () => {
    const owner = await verifiedUser(app);
    const renter = await verifiedUser(app);
    const created = await owner.agent.post("/api/listings").send({
      title: "Unfinished",
      description: "Still being written, not for rent.",
      category: "cameras",
      condition: "GOOD",
    });

    const response = await renter.agent
      .post("/api/bookings")
      .send(bookingBody(created.body.data.listing.id));
    expect(response.status).toBe(404);
  });
});

describe("the price is frozen — FR-112, FR-405", () => {
  it("records every figure from the quote at request time", async () => {
    const { renter, listingId } = await marketplace();
    const booking = await requestBooking(renter.agent, listingId);

    // Four days at ₹800 — cheaper than a month, so the daily rate applies.
    expect(booking.rent_paise).toBe(4 * 80_000);
    expect(booking.deposit_paise).toBe(500_000);
    expect(booking.renter_total_paise).toBe(4 * 80_000 + 500_000);
    expect(booking.owner_payout_paise).toBeLessThan(booking.rent_paise);
    expect(booking.quote_lines).toEqual([
      { unit: "day", quantity: 4, unitPricePaise: 80_000, subtotalPaise: 320_000 },
    ]);
  });

  it("SURVIVES the owner changing the rate card afterwards", async () => {
    const { owner, renter, listingId } = await marketplace();
    const booking = await requestBooking(renter.agent, listingId);
    const originalRent = booking.rent_paise;

    // FR-108 explicitly permits this edit; FR-112 requires the booking to be
    // unaffected. Refusing the edit would be the wrong fix — the booking carrying its
    // own copy is the right one.
    await owner.agent.patch(`/api/listings/${listingId}`).send({ dailyRatePaise: 500_000 });

    const after = await renter.agent.get(`/api/bookings/${booking.id}`);
    expect(after.body.data.booking.rent_paise).toBe(originalRent);
  });

  it("ignores any price the client tries to submit — FR-404", async () => {
    const { renter, listingId } = await marketplace();

    const response = await renter.agent.post("/api/bookings").send({
      ...bookingBody(listingId),
      rentPaise: 1,
      renterTotalPaise: 1,
      commissionPaise: 0,
      status: "ACCEPTED",
    });

    // Zod strips unknown keys, so none of these reached a service. The price is
    // recomputed from the listing and there is no field through which a caller could
    // influence it.
    expect(response.status).toBe(201);
    expect(response.body.data.booking.rent_paise).toBe(4 * 80_000);
    expect(response.body.data.booking.status).toBe("REQUESTED");
  });
});

describe("FR-505, FR-506, FR-507 — the state machine", () => {
  it("moves REQUESTED to ACCEPTED, and records who and when", async () => {
    const { owner, renter, listingId } = await marketplace();
    const booking = await requestBooking(renter.agent, listingId);

    const response = await act(owner.agent, booking.id, "ACCEPT", "See you Saturday.");
    expect(response.status).toBe(200);
    expect(response.body.data.booking.status).toBe("ACCEPTED");

    const detail = await renter.agent.get(`/api/bookings/${booking.id}`);
    const events = detail.body.data.booking.events;

    // FR-511. Every state change, with actor, timestamp and comment.
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ from_status: null, to_status: "REQUESTED" });
    expect(events[1]).toMatchObject({
      from_status: "REQUESTED",
      to_status: "ACCEPTED",
      comment: "See you Saturday.",
    });
    expect(events[1].actor_name).toBeTruthy();
  });

  it("refuses an illegal transition with 409", async () => {
    const { owner, renter, listingId } = await marketplace();
    const booking = await requestBooking(renter.agent, listingId);
    await act(owner.agent, booking.id, "DECLINE");

    // Nothing is malformed and nobody is forbidden — the booking's state simply does
    // not allow it.
    const response = await act(owner.agent, booking.id, "ACCEPT");
    expect(response.status).toBe(409);
  });

  it("refuses the WRONG PARTY with 403, not 409", async () => {
    const { owner, renter, listingId } = await marketplace();
    const booking = await requestBooking(renter.agent, listingId);

    // The renter is party to this booking, so they legitimately know it exists — they
    // are just the wrong one of the two to accept it. Different answer from a
    // stranger, who gets 404.
    const response = await act(renter.agent, booking.id, "ACCEPT");
    expect(response.status).toBe(403);
  });

  it("lets the renter cancel before handover — FR-509", async () => {
    const { owner, renter, listingId } = await marketplace();
    const booking = await requestBooking(renter.agent, listingId);
    await act(owner.agent, booking.id, "ACCEPT");

    const response = await act(renter.agent, booking.id, "CANCEL");
    expect(response.status).toBe(200);
    expect(response.body.data.booking.status).toBe("CANCELLED");
  });

  it("keeps owner cancellation a SEPARATE action from the renter's — FR-510", async () => {
    const { owner, renter, listingId } = await marketplace();
    const booking = await requestBooking(renter.agent, listingId);
    await act(owner.agent, booking.id, "ACCEPT");

    // Two actions rather than one with a different actor, so the trail records which
    // happened without anyone inferring it from an actor id later — and a reliability
    // score can be counted rather than joined.
    expect((await act(owner.agent, booking.id, "CANCEL")).status).toBe(403);

    const response = await act(owner.agent, booking.id, "CANCEL_AS_OWNER");
    expect(response.status).toBe(200);

    const detail = await renter.agent.get(`/api/bookings/${booking.id}`);
    const last = detail.body.data.booking.events.at(-1);
    expect(last.to_status).toBe("CANCELLED");
  });

  it("does not let an owner CANCEL_AS_OWNER a mere request", async () => {
    const { owner, renter, listingId } = await marketplace();
    const booking = await requestBooking(renter.agent, listingId);

    // Refusing a request is DECLINE, which costs an owner nothing. Only breaking a
    // promise counts against them.
    expect((await act(owner.agent, booking.id, "CANCEL_AS_OWNER")).status).toBe(409);
  });

  it("frees the dates again once a booking is cancelled", async () => {
    const { owner, renter, listingId } = await marketplace();
    const first = await requestBooking(renter.agent, listingId);
    await act(owner.agent, first.id, "ACCEPT");
    await act(renter.agent, first.id, "CANCEL");

    const other = await verifiedUser(app);
    const second = await requestBooking(other.agent, listingId);
    expect((await act(owner.agent, second.id, "ACCEPT")).status).toBe(200);
  });

  it("rejects an action nobody can take over HTTP", async () => {
    const { owner, renter, listingId } = await marketplace();
    const booking = await requestBooking(renter.agent, listingId);

    // EXPIRE has only a system actor, so it is filtered out of the schema entirely —
    // otherwise an owner could expire the request they are supposed to answer.
    expect((await act(owner.agent, booking.id, "EXPIRE")).status).toBe(400);
    expect((await act(owner.agent, booking.id, "TELEPORT")).status).toBe(400);
  });

  it("tells each party which actions they can actually take", async () => {
    const { owner, renter, listingId } = await marketplace();
    const booking = await requestBooking(renter.agent, listingId);

    // Derived from the state machine, so the UI cannot offer a control the server
    // refuses or hide one it would allow.
    const asOwner = await owner.agent.get(`/api/bookings/${booking.id}`);
    expect(asOwner.body.data.booking.availableActions.sort()).toEqual(["ACCEPT", "DECLINE"]);

    const asRenter = await renter.agent.get(`/api/bookings/${booking.id}`);
    expect(asRenter.body.data.booking.availableActions).toEqual(["CANCEL"]);
  });
});

describe("FR-512, FR-513 — who can see a booking", () => {
  it("hides it from everyone but the two parties, with 404", async () => {
    const { owner, renter, listingId } = await marketplace();
    const booking = await requestBooking(renter.agent, listingId);
    const stranger = await verifiedUser(app);

    // A booking is a private arrangement. A 403 would confirm that this id is
    // somebody's camera rental, which is a fact about two other people.
    expect((await stranger.agent.get(`/api/bookings/${booking.id}`)).status).toBe(404);
    expect((await act(stranger.agent, booking.id, "ACCEPT")).status).toBe(404);

    expect((await owner.agent.get(`/api/bookings/${booking.id}`)).status).toBe(200);
    expect((await renter.agent.get(`/api/bookings/${booking.id}`)).status).toBe(200);
  });

  it("lists a renter's own bookings, and an owner's from the other side", async () => {
    const { owner, renter, listingId } = await marketplace();
    await requestBooking(renter.agent, listingId);

    const asRenter = await renter.agent.get("/api/bookings");
    expect(asRenter.body.data.bookings).toHaveLength(1);
    expect(asRenter.body.data.bookings[0].yourRole).toBe("renter");

    const asOwner = await owner.agent.get("/api/bookings?side=owner");
    expect(asOwner.body.data.bookings).toHaveLength(1);
    expect(asOwner.body.data.bookings[0].yourRole).toBe("owner");

    // An owner asking for their rentals sees none of the bookings ON their listings.
    expect((await owner.agent.get("/api/bookings?side=renter")).body.data.bookings).toHaveLength(0);
  });

  it("answers an identical 404 for an unknown id and a malformed one", async () => {
    const { renter } = await marketplace();

    const responses = await Promise.all([
      renter.agent.get("/api/bookings/11111111-1111-4111-8111-111111111111"),
      renter.agent.get("/api/bookings/not-a-uuid"),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(404);
      expect(response.body).toEqual(responses[0].body);
    }
  });
});

describe("the trail is append-only — FR-511", () => {
  it("cannot be edited or deleted, even directly in SQL", async () => {
    const { owner, renter, listingId } = await marketplace();
    const booking = await requestBooking(renter.agent, listingId);
    await act(owner.agent, booking.id, "ACCEPT");

    // A convention is worth nothing here: the one time somebody fixes a typo with an
    // UPDATE, the trail stops being evidence. Migration 006 makes it a property of
    // the table, so the guarantee survives code nobody has written yet.
    await expect(
      query(`UPDATE booking_events SET comment = 'rewritten' WHERE booking_id = $1`, [booking.id])
    ).rejects.toThrow(/append-only/);

    await expect(
      query(`DELETE FROM booking_events WHERE booking_id = $1`, [booking.id])
    ).rejects.toThrow(/append-only/);
  });
});

describe("a listing that has been booked", () => {
  it("cannot be deleted", async () => {
    const { owner, renter, listingId } = await marketplace();
    await requestBooking(renter.agent, listingId);

    // Stricter than FR-110's wording, deliberately: a completed booking is the other
    // party's record of what they rented and paid, and deleting the listing would
    // leave a receipt referring to nothing. The remedy is to unpublish.
    const response = await owner.agent.delete(`/api/listings/${listingId}`);
    expect(response.status).toBe(409);
    expect(response.body.message).toMatch(/unpublish/i);
  });

  it("can be unpublished, and the confirmed booking survives it — FR-109", async () => {
    // The other half of the sentence above. Unpublishing is what an owner is told to
    // do instead of deleting, so it had better not be a quieter way of doing the same
    // damage — a renter with a confirmed booking must not find it gone because the
    // owner tidied their listings page.
    const { owner, renter, listingId } = await marketplace();
    const booking = await requestBooking(renter.agent, listingId);
    await act(owner.agent, booking.id, "ACCEPT");

    expect((await owner.agent.post(`/api/listings/${listingId}/unpublish`)).status).toBe(200);

    // Still there, still ACCEPTED, and still readable BY THE RENTER — who is not the
    // owner and so cannot see an unpublished listing at all. That is the case worth
    // asserting: reading the booking must not depend on the listing being visible.
    const after = await renter.agent.get(`/api/bookings/${booking.id}`);
    expect(after.status).toBe(200);
    expect(after.body.data.booking.status).toBe("ACCEPTED");

    // And the dates stay claimed. An unpublished listing is hidden, not cancelled, so
    // the exclusion constraint must still be holding them.
    expect((await renter.agent.get("/api/bookings?side=renter")).body.data.bookings).toHaveLength(1);
  });
});

/**
 * Handover, return and completion — step 8, FR-700 to FR-704 and FR-708.
 *
 * The block that carries most weight is the first one. Adding a state to a design
 * built on a PARTIAL exclusion constraint means every "does this status hold its
 * dates" list has to learn it, and there were five of them. Four were still saying
 * `('ACCEPTED', 'ACTIVE')` after the state existed, and three of those four were
 * silent wrong answers rather than errors — the calendar, the browse date filter and
 * the blackout guard would all have treated an item that was physically out as
 * available. Nothing would have thrown.
 */

import { describe, it, expect } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { query } from "../src/config/db.js";
import { verifiedUser } from "./helpers/factories.js";
import { DATES_HELD_STATUSES } from "../src/services/bookingStateMachine.js";

const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a" +
    "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA" +
    "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
  "base64"
);

const NEXT_MONTH = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
const iso = (days) => new Date(NEXT_MONTH.getTime() + days * 86_400_000).toISOString();

async function publishedListing(agent, overrides = {}) {
  const created = await agent.post("/api/listings").send({
    title: "Canon EOS R6",
    description: "Full-frame mirrorless with two batteries.",
    category: "cameras",
    condition: "GOOD",
    dailyRatePaise: 80_000,
    locality: "Kothrud",
    city: "Pune",
    ...overrides,
  });
  const id = created.body.data.listing.id;
  await agent.post(`/api/listings/${id}/photos`).attach("photos", JPEG, "p.jpg");
  await agent.post(`/api/listings/${id}/publish`);
  return id;
}

async function marketplace() {
  const owner = await verifiedUser(app);
  const renter = await verifiedUser(app);
  return { owner, renter, listingId: await publishedListing(owner.agent) };
}

const act = (agent, id, action, comment) =>
  agent.post(`/api/bookings/${id}/actions`).send(comment ? { action, comment } : { action });

const book = (agent, listingId, from = 0, to = 3) =>
  agent.post("/api/bookings").send({ listingId, startsAt: iso(from), endsAt: iso(to) });

/** A booking carried all the way to HANDED_OVER — the state everything below turns on. */
async function handedOver(overrides = {}) {
  const { owner, renter, listingId } = await marketplace();
  const requested = await book(renter.agent, listingId, overrides.from ?? 0, overrides.to ?? 3);
  const booking = requested.body.data.booking;

  await act(owner.agent, booking.id, "ACCEPT");
  await act(owner.agent, booking.id, "START");

  return { owner, renter, listingId, booking };
}

describe("HANDED_OVER holds its dates everywhere, not just in the constraint", () => {
  it("agrees with DATES_HELD_STATUSES — the one list that cannot be parameterised", async () => {
    // The exclusion constraint and the FR-206 trigger are SQL and cannot read
    // application code, so the list is written twice by necessity. This is the only
    // thing that keeps the two honest: it reads the constraint back out of the
    // database and compares it against the array every query is built from.
    const { rows } = await query(
      `SELECT pg_get_constraintdef(oid) AS def
         FROM pg_constraint
        WHERE conname = 'bookings_no_double_booking'`
    );

    const inConstraint = [...rows[0].def.matchAll(/'([A-Z_]+)'::text/g)].map((m) => m[1]);
    expect(inConstraint.sort()).toEqual([...DATES_HELD_STATUSES].sort());
  });

  it("refuses a second booking for the same dates, at the request stage", async () => {
    const { listingId } = await handedOver();
    const other = await verifiedUser(app);

    // The item is physically out, so FR-503's friendly pre-check should stop this
    // before anybody waits two days for an answer. That pre-check runs through
    // `findOverlappingBooking`, which was one of the four queries still filtering on
    // ACCEPTED/ACTIVE — so before the fix this request was ACCEPTED (201) and the
    // collision only surfaced later, if at all.
    const second = await book(other.agent, listingId, 1, 2);
    expect(second.status).toBe(409);
    expect(second.body.message).toMatch(/already booked/i);
  });

  it("refuses an ACCEPT that would overlap it, for a request made earlier", async () => {
    const { owner, listingId } = await handedOver({ from: 0, to: 3 });

    // A request made BEFORE the handover holds no dates, so it legitimately exists
    // alongside one — accepting it is the moment that has to fail.
    const other = await verifiedUser(app);
    const overlapping = await book(other.agent, listingId, 10, 12);
    expect(overlapping.status).toBe(201);

    await query(`UPDATE bookings SET starts_at = $1, ends_at = $2 WHERE id = $3`, [
      iso(1),
      iso(2),
      overlapping.body.data.booking.id,
    ]);

    // Deliberately NOT claiming to prove the constraint fired. Both the service
    // pre-check and the constraint answer 409 here and the pre-check runs first, so
    // this exercises the ACCEPT path against HANDED_OVER — nothing more. The
    // constraint itself is proven under real concurrency by the 20-way probe in
    // bookings.test.js, which is where that claim belongs.
    const accepted = await act(owner.agent, overlapping.body.data.booking.id, "ACCEPT");
    expect(accepted.status).toBe(409);
  });

  it("shows as unavailable on the calendar — FR-205", async () => {
    const { listingId, renter } = await handedOver();

    const availability = await renter.agent.get(`/api/listings/${listingId}/availability`);
    expect(availability.status).toBe(200);
    // Before the fix this returned an empty list: the query still filtered on
    // ACCEPTED/ACTIVE, so a handed-over item simply vanished from its own calendar.
    expect(availability.body.data.unavailable).toHaveLength(1);
  });

  it("keeps the listing out of a free-between search — FR-303", async () => {
    const { listingId } = await handedOver();
    const stranger = await verifiedUser(app);

    const free = await stranger.agent.get(
      `/api/listings?availableFrom=${iso(1)}&availableTo=${iso(2)}`
    );
    expect(free.body.data.listings.map((l) => l.id)).not.toContain(listingId);
  });

  it("refuses a blackout laid over it — FR-206", async () => {
    const { owner, listingId } = await handedOver();

    const blackout = await owner.agent
      .post(`/api/listings/${listingId}/blackouts`)
      .send({ startsAt: iso(1), endsAt: iso(2) });

    // The trigger, not the service. Migration 008 had to replace 007's function for
    // this — and a stale list there would have failed OPEN, allowing the blackout
    // with no error at all.
    expect(blackout.status).toBe(409);
    expect(blackout.body.message).toMatch(/confirmed booking/i);
  });
});

describe("FR-700 to FR-704 — the receiving party confirms, at both ends", () => {
  it("walks the whole path and records every step", async () => {
    const { owner, renter, booking } = await handedOver();

    expect((await renter.agent.get(`/api/bookings/${booking.id}`)).body.data.booking.status).toBe(
      "HANDED_OVER"
    );

    expect((await act(renter.agent, booking.id, "CONFIRM_RECEIPT")).status).toBe(200);
    expect((await act(renter.agent, booking.id, "RETURN")).status).toBe(200);

    const completed = await act(owner.agent, booking.id, "COMPLETE", "All in order, thanks.");
    expect(completed.status).toBe(200);
    expect(completed.body.data.booking.status).toBe("COMPLETED");

    // FR-511: every one of those is in the append-only trail, with its actor.
    const detail = await renter.agent.get(`/api/bookings/${booking.id}`);
    const trail = detail.body.data.booking.events.map((e) => e.to_status);
    expect(trail).toEqual(
      expect.arrayContaining(["ACCEPTED", "HANDED_OVER", "ACTIVE", "RETURNED", "COMPLETED"])
    );
  });

  it("will not let the handing-over party also confirm receipt", async () => {
    const { owner, booking } = await handedOver();

    // The whole point of the two-sided design. If the owner could confirm on the
    // renter's behalf, "you have my camera" would be one person's claim again.
    const response = await act(owner.agent, booking.id, "CONFIRM_RECEIPT");
    expect(response.status).toBe(403);
    expect(response.body.message).toMatch(/other party/i);
  });

  it("will not let the renter declare their own handover", async () => {
    const { owner, renter, listingId } = await marketplace();
    const booking = (await book(renter.agent, listingId)).body.data.booking;
    await act(owner.agent, booking.id, "ACCEPT");

    expect((await act(renter.agent, booking.id, "START")).status).toBe(403);
  });

  it("makes RETURN the renter's action, not the owner's — FR-703", async () => {
    const { owner, renter, booking } = await handedOver();
    await act(renter.agent, booking.id, "CONFIRM_RECEIPT");

    // The state machine originally declared this as the owner's, contradicting the
    // requirement outright — and collapsing the two-sided record, since the owner
    // would then both declare the return and confirm it.
    expect((await act(owner.agent, booking.id, "RETURN")).status).toBe(403);
    expect((await act(renter.agent, booking.id, "RETURN")).status).toBe(200);
  });

  it("lets a renter return without having confirmed receipt", async () => {
    const { renter, booking } = await handedOver();

    // Handing it back is a stronger admission of having had it than confirming
    // receipt would have been, so being stuck at HANDED_OVER must not trap them.
    const returned = await act(renter.agent, booking.id, "RETURN");
    expect(returned.status).toBe(200);
    expect(returned.body.data.booking.status).toBe("RETURNED");
  });

  it("cannot be cancelled once the item has gone out", async () => {
    const { owner, renter, booking } = await handedOver();

    // From here the way out is to return it, not to pretend it never happened.
    expect((await act(renter.agent, booking.id, "CANCEL")).status).toBe(409);
    expect((await act(owner.agent, booking.id, "CANCEL_AS_OWNER")).status).toBe(409);
  });
});

describe("RETURNED releases the dates", () => {
  it("frees an early return's remaining days", async () => {
    const { owner, renter, listingId, booking } = await handedOver();
    await act(renter.agent, booking.id, "CONFIRM_RECEIPT");
    await act(renter.agent, booking.id, "RETURN");

    // The item is back on the shelf. Holding its original dates against it would
    // refuse a real rental for an item sitting in the owner's hallway — which is why
    // RETURNED is deliberately absent from the exclusion constraint.
    const other = await verifiedUser(app);
    const second = await book(other.agent, listingId, 1, 2);
    expect(second.status).toBe(201);

    expect((await act(owner.agent, second.body.data.booking.id, "ACCEPT")).status).toBe(200);
  });
});

describe("FR-702 — condition photos, optional and append-only", () => {
  const attach = (agent, id, phase, file = "p.jpg") =>
    agent.post(`/api/bookings/${id}/photos`).field("phase", phase).attach("photos", JPEG, file);

  it("accepts them from EITHER party, which is what makes it a record", async () => {
    const { owner, renter, booking } = await handedOver();

    // Adversarial by design: a scratch is worth photographing by whichever side
    // thinks it helps them, and a record only one party can add to is not a record.
    expect((await attach(owner.agent, booking.id, "HANDOVER")).status).toBe(201);
    expect((await attach(renter.agent, booking.id, "HANDOVER")).status).toBe(201);

    const listed = await renter.agent.get(`/api/bookings/${booking.id}/photos`);
    expect(listed.body.data.photos).toHaveLength(2);
    // Named, because who said what about the condition is the point.
    expect(listed.body.data.photos.map((p) => p.uploadedByName)).toEqual([
      expect.any(String),
      expect.any(String),
    ]);
  });

  it("never hands the client a provider URL", async () => {
    const { owner, booking } = await handedOver();
    const created = await attach(owner.agent, booking.id, "HANDOVER");

    // A signed Cloudinary URL is a bearer credential for as long as it lives. The
    // client only ever gets a path on this application, re-checked on every request.
    const [photo] = created.body.data.photos;
    expect(photo.url).toBe(`/api/bookings/${booking.id}/photos/${photo.id}/file`);
    expect(JSON.stringify(created.body)).not.toMatch(/cloudinary|res\.cloudinary\.com/i);
  });

  it("shows them to both parties and to nobody else", async () => {
    const { owner, renter, booking } = await handedOver();
    const created = await attach(owner.agent, booking.id, "HANDOVER");
    const [photo] = created.body.data.photos;

    const stranger = await verifiedUser(app);

    expect((await owner.agent.get(photo.url)).status).toBe(200);
    expect((await renter.agent.get(photo.url)).status).toBe(200);

    // 404, not 403 — a stranger has no more business learning that this booking
    // exists than that the photo does.
    expect((await stranger.agent.get(photo.url)).status).toBe(404);
    expect((await request(app).get(photo.url)).status).toBe(401);
  });

  it("refuses a photo of a moment that has not happened", async () => {
    const { owner, renter, listingId } = await marketplace();
    const booking = (await book(renter.agent, listingId)).body.data.booking;
    await act(owner.agent, booking.id, "ACCEPT");

    // Nothing has come back yet, so a RETURN photo is a photo of nothing.
    const early = await attach(owner.agent, booking.id, "RETURN");
    expect(early.status).toBe(409);
    expect(early.body.message).toMatch(/on its way back/i);
  });

  it("closes both phases once the booking is settled", async () => {
    const { owner, renter, booking } = await handedOver();
    await act(renter.agent, booking.id, "CONFIRM_RECEIPT");
    await act(renter.agent, booking.id, "RETURN");
    await act(owner.agent, booking.id, "COMPLETE");

    // After completion a new photo is not evidence of the handover, it is evidence
    // of an argument.
    expect((await attach(owner.agent, booking.id, "HANDOVER")).status).toBe(409);
    expect((await attach(owner.agent, booking.id, "RETURN")).status).toBe(409);
  });

  it("cannot be deleted or edited, even by whoever uploaded it", async () => {
    const { owner, booking } = await handedOver();
    await attach(owner.agent, booking.id, "HANDOVER");

    // The tempting exception — "let them remove one added by mistake" — is exactly
    // the hole: "by mistake" is indistinguishable from "because it showed the
    // scratch". Enforced by trigger, so it holds against SQL too.
    await expect(
      query(`DELETE FROM booking_photos WHERE booking_id = $1`, [booking.id])
    ).rejects.toThrow(/append-only/);

    await expect(
      query(`UPDATE booking_photos SET note = 'nothing to see' WHERE booking_id = $1`, [booking.id])
    ).rejects.toThrow(/append-only/);
  });

  it("lets a handover happen with no photos at all", async () => {
    // Optional, deliberately. A handover in a car park with one bar of signal must
    // not be blocked by an upload, and a handover that cannot be recorded is worse
    // than one recorded without pictures.
    const { renter, owner, booking } = await handedOver();

    expect((await act(renter.agent, booking.id, "CONFIRM_RECEIPT")).status).toBe(200);
    expect((await renter.agent.get(`/api/bookings/${booking.id}/photos`)).body.data.photos).toEqual(
      []
    );
    expect((await act(renter.agent, booking.id, "RETURN")).status).toBe(200);
    expect((await act(owner.agent, booking.id, "COMPLETE")).status).toBe(200);
  });
});

describe("FR-708 — a timeout, because neither party can force the other", () => {
  it("confirms receipt for a renter who never answered, and completes for an absent owner", async () => {
    const { owner, renter, booking } = await handedOver();

    // Nothing has happened for two days. Backdated directly because the alternative
    // is a test that takes 48 hours.
    await query(`UPDATE bookings SET updated_at = now() - interval '49 hours' WHERE id = $1`, [
      booking.id,
    ]);

    const { sweepStalledConfirmations } = await import("../src/services/bookingService.js");
    expect((await sweepStalledConfirmations()).expired).toBe(1);

    const afterReceipt = await renter.agent.get(`/api/bookings/${booking.id}`);
    expect(afterReceipt.body.data.booking.status).toBe("ACTIVE");

    // THE ACTOR IS NULL, and that is the point. Recording the renter as having
    // confirmed something they never acknowledged would put a false statement in a
    // trail whose entire value is that everything in it happened.
    const swept = afterReceipt.body.data.booking.events.find((e) => e.to_status === "ACTIVE");
    expect(swept.actor_id).toBeNull();

    // And the same from the other end.
    await act(renter.agent, booking.id, "RETURN");
    await query(`UPDATE bookings SET updated_at = now() - interval '49 hours' WHERE id = $1`, [
      booking.id,
    ]);
    expect((await sweepStalledConfirmations()).expired).toBe(1);

    expect(
      (await owner.agent.get(`/api/bookings/${booking.id}`)).body.data.booking.status
    ).toBe("COMPLETED");
  });

  it("leaves a booking that is still within its window alone", async () => {
    const { booking, renter } = await handedOver();

    const { sweepStalledConfirmations } = await import("../src/services/bookingService.js");
    expect((await sweepStalledConfirmations()).expired).toBe(0);

    expect(
      (await renter.agent.get(`/api/bookings/${booking.id}`)).body.data.booking.status
    ).toBe("HANDED_OVER");
  });
});

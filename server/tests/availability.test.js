/**
 * Availability — step 4, FR-200 to FR-206, plus the halves of FR-303, FR-503 and
 * FR-504 that were waiting on it.
 *
 * The block that carries most weight is FR-206: a blackout must not cover a booking
 * the owner already committed to, and it is enforced by a trigger rather than by the
 * service — so it holds even against SQL that never went through the application.
 */

import { describe, it, expect } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { query } from "../src/config/db.js";
import { verifiedUser } from "./helpers/factories.js";

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

async function marketplace(overrides = {}) {
  const owner = await verifiedUser(app);
  const renter = await verifiedUser(app);
  return { owner, renter, listingId: await publishedListing(owner.agent, overrides) };
}

const blackout = (agent, listingId, body) =>
  agent.post(`/api/listings/${listingId}/blackouts`).send(body);

const book = (agent, listingId, startsAt, endsAt) =>
  agent.post("/api/bookings").send({ listingId, startsAt, endsAt });

describe("FR-200 — an owner blocks their own dates", () => {
  it("records a blackout", async () => {
    const { owner, listingId } = await marketplace();

    const response = await blackout(owner.agent, listingId, {
      startsAt: iso(0),
      endsAt: iso(3),
      reason: "Lending it to my brother",
    });

    expect(response.status).toBe(201);
    expect(response.body.data.blackout.reason).toBe("Lending it to my brother");
  });

  it("refuses one that overlaps another blackout", async () => {
    const { owner, listingId } = await marketplace();
    await blackout(owner.agent, listingId, { startsAt: iso(0), endsAt: iso(3) });

    // Harmless if allowed, but overlapping blocks make the owner's own calendar
    // unreadable, and merging them on read is more code than forbidding them.
    const response = await blackout(owner.agent, listingId, { startsAt: iso(2), endsAt: iso(5) });
    expect(response.status).toBe(409);
    expect(response.body.message).toMatch(/already blocked/i);
  });

  it("allows back-to-back blackouts", async () => {
    const { owner, listingId } = await marketplace();
    await blackout(owner.agent, listingId, { startsAt: iso(0), endsAt: iso(3) });

    // `[)` bounds, same as everywhere else in the product.
    expect((await blackout(owner.agent, listingId, { startsAt: iso(3), endsAt: iso(6) })).status).toBe(201);
  });

  it("refuses a stranger, and an inverted range", async () => {
    const { listingId } = await marketplace();
    const stranger = await verifiedUser(app);

    expect((await blackout(stranger.agent, listingId, { startsAt: iso(0), endsAt: iso(3) })).status).toBe(403);

    const owner2 = await verifiedUser(app);
    const own = await publishedListing(owner2.agent);
    expect((await blackout(owner2.agent, own, { startsAt: iso(3), endsAt: iso(0) })).status).toBe(400);
  });

  it("frees the dates again when removed", async () => {
    const { owner, renter, listingId } = await marketplace();
    const created = await blackout(owner.agent, listingId, { startsAt: iso(0), endsAt: iso(3) });

    expect((await book(renter.agent, listingId, iso(0), iso(2))).status).toBe(409);

    await owner.agent.delete(`/api/listings/${listingId}/blackouts/${created.body.data.blackout.id}`);
    expect((await book(renter.agent, listingId, iso(0), iso(2))).status).toBe(201);
  });

  it("lists them back to the owner, with the ids and reasons only they get", async () => {
    const { owner, renter, listingId } = await marketplace();
    await blackout(owner.agent, listingId, {
      startsAt: iso(0),
      endsAt: iso(2),
      reason: "Lending it to my brother",
    });

    const mine = await owner.agent.get(`/api/listings/${listingId}/blackouts`);
    expect(mine.status).toBe(200);
    expect(mine.body.data.blackouts).toHaveLength(1);
    expect(mine.body.data.blackouts[0].reason).toBe("Lending it to my brother");
    // The id is the handle the owner deletes with, so the list is useless without it.
    expect(mine.body.data.blackouts[0].id).toEqual(expect.any(String));

    // 403 rather than 404: the listing is PUBLISHED, so a stranger can already see it
    // exists by browsing and pretending otherwise would be theatre.
    expect((await renter.agent.get(`/api/listings/${listingId}/blackouts`)).status).toBe(403);
    expect((await request(app).get(`/api/listings/${listingId}/blackouts`)).status).toBe(401);

    // And the reason never reaches the public path, which is the whole reason these
    // are two endpoints rather than one.
    const publicView = await renter.agent.get(`/api/listings/${listingId}/availability`);
    expect(JSON.stringify(publicView.body)).not.toMatch(/brother/i);
  });
});

describe("FR-206 — a blackout may not cover a confirmed booking", () => {
  it("refuses through the API", async () => {
    const { owner, renter, listingId } = await marketplace();
    const requested = await book(renter.agent, listingId, iso(0), iso(4));
    await owner.agent
      .post(`/api/bookings/${requested.body.data.booking.id}/actions`)
      .send({ action: "ACCEPT" });

    const response = await blackout(owner.agent, listingId, { startsAt: iso(1), endsAt: iso(3) });
    expect(response.status).toBe(409);
    expect(response.body.message).toMatch(/confirmed booking/i);
  });

  it("is enforced by the DATABASE, not merely by the service", async () => {
    const { owner, renter, listingId } = await marketplace();
    const requested = await book(renter.agent, listingId, iso(0), iso(4));
    await owner.agent
      .post(`/api/bookings/${requested.body.data.booking.id}/actions`)
      .send({ action: "ACCEPT" });

    // A trigger, so the rule survives any future code path that inserts a blackout
    // without going through the service — which a service-layer check cannot promise.
    await expect(
      query(
        `INSERT INTO availability_blocks (listing_id, starts_at, ends_at)
         VALUES ($1, $2, $3)`,
        [listingId, iso(1), iso(3)]
      )
    ).rejects.toThrow(/overlaps a confirmed booking/);
  });

  it("permits a blackout over a booking that was only REQUESTED", async () => {
    const { owner, renter, listingId } = await marketplace();
    await book(renter.agent, listingId, iso(0), iso(4));

    // A request holds nothing — that is the whole point of the partial exclusion
    // constraint. The owner is free to block the dates, which simply means the
    // request can no longer be accepted.
    expect((await blackout(owner.agent, listingId, { startsAt: iso(1), endsAt: iso(3) })).status).toBe(201);
  });
});

describe("FR-503 — blackouts refuse a booking, with their own message", () => {
  it("refuses a booking over blocked dates", async () => {
    const { owner, renter, listingId } = await marketplace();
    await blackout(owner.agent, listingId, { startsAt: iso(0), endsAt: iso(5) });

    const response = await book(renter.agent, listingId, iso(1), iso(3));
    expect(response.status).toBe(409);
    // A DIFFERENT message from "already booked": one invites trying adjacent dates,
    // the other suggests asking the owner.
    expect(response.body.message).toMatch(/marked those dates as unavailable/i);
  });

  it("never leaks the owner's reason to a renter", async () => {
    const { owner, renter, listingId } = await marketplace();
    await blackout(owner.agent, listingId, {
      startsAt: iso(0),
      endsAt: iso(5),
      reason: "Lending it to my brother",
    });

    const response = await book(renter.agent, listingId, iso(1), iso(3));
    // "Lending it to my brother" is the owner's private note, not a renter's business.
    expect(JSON.stringify(response.body)).not.toMatch(/brother/i);
  });
});

describe("FR-203 — the notice period", () => {
  it("refuses a start inside it, and says how much notice is needed", async () => {
    const owner = await verifiedUser(app);
    const renter = await verifiedUser(app);
    const listingId = await publishedListing(owner.agent, { noticePeriodHours: 48 });

    const soon = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
    const response = await book(renter.agent, listingId, soon, iso(2));

    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/48 hours/);
  });

  it("still refuses a start in the past when no notice is set", async () => {
    const { renter, listingId } = await marketplace();
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();

    // The zero case of the same rule, not a separate check.
    expect((await book(renter.agent, listingId, yesterday, iso(2))).status).toBe(400);
  });

  it("advertises the same instant it enforces", async () => {
    const owner = await verifiedUser(app);
    const listingId = await publishedListing(owner.agent, { noticePeriodHours: 24 });

    const response = await request(app).get(`/api/listings/${listingId}/availability`);

    // One function computes both, so a listing page and a refusal cannot disagree by
    // an hour.
    expect(response.body.data.noticePeriodHours).toBe(24);
    const advertised = new Date(response.body.data.bookableFrom).getTime();
    expect(advertised).toBeGreaterThan(Date.now() + 23 * 3_600_000);
    expect(advertised).toBeLessThan(Date.now() + 25 * 3_600_000);
  });
});

describe("FR-204, FR-205 — who sees what on the calendar", () => {
  it("shows a visitor WHEN it is unavailable, but never WHY", async () => {
    const { owner, renter, listingId } = await marketplace();
    await blackout(owner.agent, listingId, { startsAt: iso(0), endsAt: iso(3), reason: "servicing" });
    const requested = await book(renter.agent, listingId, iso(10), iso(14));
    await owner.agent
      .post(`/api/bookings/${requested.body.data.booking.id}/actions`)
      .send({ action: "ACCEPT" });

    const response = await request(app).get(`/api/listings/${listingId}/availability`);

    expect(response.status).toBe(200);
    expect(response.body.data.unavailable).toHaveLength(2);

    // Whether a Tuesday is taken by a booking or a blackout is a fact about the
    // owner's business and about another renter's arrangements. Neither is a
    // visitor's business, and the reason certainly is not.
    for (const period of response.body.data.unavailable) {
      expect(period).not.toHaveProperty("kind");
    }
    expect(JSON.stringify(response.body)).not.toMatch(/servicing/i);
  });

  it("tells the OWNER which is which — FR-204", async () => {
    const { owner, renter, listingId } = await marketplace();
    await blackout(owner.agent, listingId, { startsAt: iso(0), endsAt: iso(3) });
    const requested = await book(renter.agent, listingId, iso(10), iso(14));
    await owner.agent
      .post(`/api/bookings/${requested.body.data.booking.id}/actions`)
      .send({ action: "ACCEPT" });

    const response = await owner.agent.get(`/api/listings/${listingId}/availability`);
    const kinds = response.body.data.unavailable.map((p) => p.kind).sort();

    // The owner needs the distinction: one of the two is theirs to change.
    expect(kinds).toEqual(["BLACKOUT", "BOOKING"]);
  });

  it("windows the answer when asked", async () => {
    const { owner, listingId } = await marketplace();
    await blackout(owner.agent, listingId, { startsAt: iso(0), endsAt: iso(3) });
    await blackout(owner.agent, listingId, { startsAt: iso(100), endsAt: iso(103) });

    const response = await request(app).get(
      `/api/listings/${listingId}/availability?from=${iso(-5)}&to=${iso(10)}`
    );
    expect(response.body.data.unavailable).toHaveLength(1);
  });

  it("hides a draft's availability from a stranger", async () => {
    const owner = await verifiedUser(app);
    const created = await owner.agent.post("/api/listings").send({
      title: "Unfinished",
      description: "Not for rent yet, still being written.",
      category: "cameras",
      condition: "GOOD",
    });
    const id = created.body.data.listing.id;

    expect((await request(app).get(`/api/listings/${id}/availability`)).status).toBe(404);
    expect((await owner.agent.get(`/api/listings/${id}/availability`)).status).toBe(200);
  });
});

describe("FR-303 — browse for listings free between two dates", () => {
  it("excludes anything booked or blocked in the window", async () => {
    const owner = await verifiedUser(app);
    const renter = await verifiedUser(app);

    const free = await publishedListing(owner.agent, { title: "Free camera" });
    const blocked = await publishedListing(owner.agent, { title: "Blocked camera" });
    const booked = await publishedListing(owner.agent, { title: "Booked camera" });

    await blackout(owner.agent, blocked, { startsAt: iso(0), endsAt: iso(5) });
    const requested = await book(renter.agent, booked, iso(0), iso(5));
    await owner.agent
      .post(`/api/bookings/${requested.body.data.booking.id}/actions`)
      .send({ action: "ACCEPT" });

    const response = await request(app).get(
      `/api/listings?availableFrom=${iso(1)}&availableTo=${iso(3)}`
    );

    expect(response.body.data.listings.map((l) => l.title)).toEqual(["Free camera"]);
    // The count must agree with the page — it comes from the same statement.
    expect(response.body.data.total).toBe(1);
    expect(free).toBeTruthy();
  });

  it("excludes a listing whose notice period has not elapsed", async () => {
    const owner = await verifiedUser(app);
    await publishedListing(owner.agent, { title: "Needs notice", noticePeriodHours: 720 });
    await publishedListing(owner.agent, { title: "Available now" });

    const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
    const dayAfter = new Date(Date.now() + 2 * 86_400_000).toISOString();

    // Offering it would produce a refusal at the last step of a booking.
    const response = await request(app).get(
      `/api/listings?availableFrom=${tomorrow}&availableTo=${dayAfter}`
    );
    expect(response.body.data.listings.map((l) => l.title)).toEqual(["Available now"]);
  });

  it("insists on both halves of the range, or neither", async () => {
    // One half cannot express "free between".
    expect((await request(app).get(`/api/listings?availableFrom=${iso(0)}`)).status).toBe(400);
    expect((await request(app).get(`/api/listings?availableTo=${iso(0)}`)).status).toBe(400);
    expect(
      (await request(app).get(`/api/listings?availableFrom=${iso(3)}&availableTo=${iso(0)}`)).status
    ).toBe(400);
  });

  it("still counts correctly alongside another filter", async () => {
    const owner = await verifiedUser(app);
    await publishedListing(owner.agent, { title: "Pune camera", city: "Pune" });
    await publishedListing(owner.agent, { title: "Mumbai camera", city: "Mumbai" });

    const response = await request(app).get(
      `/api/listings?city=Pune&availableFrom=${iso(1)}&availableTo=${iso(3)}`
    );
    expect(response.body.data.total).toBe(1);
    expect(response.body.data.listings).toHaveLength(1);
  });
});

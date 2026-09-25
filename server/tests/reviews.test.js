/**
 * Two-way reviews — FR-800 to FR-808.
 *
 * The block that carries the weight is the blind period. Without it the second
 * review is a reply to the first, and neither number measures the rental — so the
 * tests here try to defeat it rather than to exercise it: read the other side
 * early, edit after seeing theirs, reply before publication.
 */

import { describe, it, expect } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { query } from "../src/config/db.js";
import { verifiedUser } from "./helpers/factories.js";
import { REVIEW_WINDOW_DAYS, REVIEW_EDIT_HOURS } from "../src/services/reviewService.js";

const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a" +
    "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA" +
    "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
  "base64"
);

const NEXT_MONTH = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
const iso = (days) => new Date(NEXT_MONTH.getTime() + days * 86_400_000).toISOString();

const act = (agent, id, action) => agent.post(`/api/bookings/${id}/actions`).send({ action });

/** A booking driven all the way to COMPLETED, which is the only reviewable state. */
async function completed() {
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

  const bookingId = (
    await renter.agent.post("/api/bookings").send({ listingId, startsAt: iso(0), endsAt: iso(3) })
  ).body.data.booking.id;

  await act(owner.agent, bookingId, "ACCEPT");
  await act(owner.agent, bookingId, "START");
  await act(renter.agent, bookingId, "CONFIRM_RECEIPT");
  await act(renter.agent, bookingId, "RETURN");
  await act(owner.agent, bookingId, "COMPLETE");

  return { owner, renter, listingId, bookingId };
}

const review = (agent, id, rating, body) =>
  agent.post(`/api/bookings/${id}/reviews`).send(body ? { rating, body } : { rating });

const readReviews = async (agent, id) => (await agent.get(`/api/bookings/${id}/reviews`)).body.data;

describe("FR-801, FR-802 — who may review, and how often", () => {
  it("refuses until the rental is complete", async () => {
    const owner = await verifiedUser(app);
    const renter = await verifiedUser(app);

    const created = await owner.agent.post("/api/listings").send({
      title: "Bosch drill",
      description: "Corded SDS-plus with a full bit set.",
      category: "tools",
      condition: "GOOD",
      dailyRatePaise: 40_000,
      locality: "Baner",
      city: "Pune",
    });
    const listingId = created.body.data.listing.id;
    await owner.agent.post(`/api/listings/${listingId}/photos`).attach("photos", JPEG, "p.jpg");
    await owner.agent.post(`/api/listings/${listingId}/publish`);

    const bookingId = (
      await renter.agent.post("/api/bookings").send({ listingId, startsAt: iso(0), endsAt: iso(2) })
    ).body.data.booking.id;

    // No booking, no review — and a booking that has not finished is not a rental
    // anybody can speak to yet.
    const early = await review(renter.agent, bookingId, 5);
    expect(early.status).toBe(409);
    expect(early.body.message).toMatch(/complete/i);
  });

  it("allows one each, and refuses a second from the same person", async () => {
    const { owner, renter, bookingId } = await completed();

    expect((await review(renter.agent, bookingId, 5, "Great camera")).status).toBe(201);
    expect((await review(owner.agent, bookingId, 4, "Returned on time")).status).toBe(201);

    const again = await review(renter.agent, bookingId, 1);
    expect(again.status).toBe(409);
    // Pointing at the edit is more useful than a bare "already exists".
    expect(again.body.message).toMatch(/edit/i);
  });

  it("refuses a stranger with 404, never 403", async () => {
    const { bookingId } = await completed();
    const stranger = await verifiedUser(app);

    expect((await review(stranger.agent, bookingId, 5)).status).toBe(404);
    expect((await stranger.agent.get(`/api/bookings/${bookingId}/reviews`)).status).toBe(404);
  });

  it("decides the subject from the author, never from the request", async () => {
    const { owner, renter, bookingId } = await completed();
    await review(renter.agent, bookingId, 5);

    const { rows } = await query(`SELECT author_id, subject_id, direction FROM reviews`);
    // Taking a subject id from the body would let somebody aim a review at a third
    // party; a booking has exactly two people and the author's role picks the other.
    expect(rows[0].author_id).toBe(renter.user.id);
    expect(rows[0].subject_id).toBe(owner.user.id);
    expect(rows[0].direction).toBe("OF_OWNER");
  });
});

describe("FR-804 — blind until both have written", () => {
  it("hides the first review from its subject, and shows it to its author", async () => {
    const { owner, renter, bookingId } = await completed();
    await review(renter.agent, bookingId, 2, "Lens was scratched");

    // THE WHOLE POINT. If the owner could read this now, their review of the renter
    // would be a reply to it rather than an account of the rental.
    const forOwner = await readReviews(owner.agent, bookingId);
    expect(forOwner.reviews).toHaveLength(0);

    // The author always sees their own — they wrote it.
    const forRenter = await readReviews(renter.agent, bookingId);
    expect(forRenter.reviews).toHaveLength(1);
    expect(forRenter.reviews[0].isPublished).toBe(false);
  });

  it("publishes both the moment the second one lands", async () => {
    const { owner, renter, bookingId } = await completed();
    await review(renter.agent, bookingId, 2, "Lens was scratched");
    await review(owner.agent, bookingId, 5, "Careful renter");

    const forOwner = await readReviews(owner.agent, bookingId);
    expect(forOwner.reviews).toHaveLength(2);
    expect(forOwner.reviews.every((r) => r.isPublished)).toBe(true);
  });

  it("keeps an unpublished review out of the public list and out of the rating", async () => {
    const { owner, renter, bookingId } = await completed();
    await review(renter.agent, bookingId, 1, "Terrible");

    const publicView = await request(app).get(`/api/users/${owner.user.id}/reviews`);
    expect(publicView.status).toBe(200);
    expect(publicView.body.data.reviews).toHaveLength(0);

    // An unpublished review is not yet a fact about anybody, so it counts towards
    // nothing — null rather than 1.0.
    expect(publicView.body.data.rating.asOwner.average).toBeNull();
    expect(publicView.body.data.rating.asOwner.count).toBe(0);
  });

  it("publishes a lone review once its window has passed", async () => {
    const { owner, renter, bookingId } = await completed();
    await review(renter.agent, bookingId, 4, "Good camera, slow to reply");

    // Measured from the REVIEW's own age, not the booking's end — otherwise one
    // written on day thirteen publishes tomorrow while one written on day one
    // waits a fortnight, which makes the window a lottery.
    await query(
      `UPDATE reviews SET created_at = now() - make_interval(days => $1) WHERE booking_id = $2`,
      [REVIEW_WINDOW_DAYS + 1, bookingId]
    );

    const { sweepBlindReviews } = await import("../src/services/reviewService.js");
    const result = await sweepBlindReviews();
    expect(result.expired).toBe(1);

    const forOwner = await readReviews(owner.agent, bookingId);
    expect(forOwner.reviews).toHaveLength(1);
    expect(forOwner.reviews[0].isPublished).toBe(true);
  });

  it("refuses a review written AFTER the other one has already published — the retaliation gap", async () => {
    // Same setup as the sweep test above: the renter writes promptly, the window
    // lapses with the owner never writing, and the sweep publishes the renter's
    // review alone. The owner can now READ what the renter said. Writing one now is
    // not blind — it is a reply — which is exactly what FR-804 exists to prevent.
    const { owner, renter, bookingId } = await completed();
    await review(renter.agent, bookingId, 4, "Good camera, slow to reply");

    await query(
      `UPDATE reviews SET created_at = now() - make_interval(days => $1) WHERE booking_id = $2`,
      [REVIEW_WINDOW_DAYS + 1, bookingId]
    );
    const { sweepBlindReviews } = await import("../src/services/reviewService.js");
    await sweepBlindReviews();

    // The owner can see it now — confirming the exploit's precondition actually holds
    // before asserting the fix blocks it.
    const forOwnerBefore = await readReviews(owner.agent, bookingId);
    expect(forOwnerBefore.reviews).toHaveLength(1);
    expect(forOwnerBefore.reviews[0].isPublished).toBe(true);
    expect(forOwnerBefore.canReview).toBe(false);

    const retaliation = await review(owner.agent, bookingId, 1, "Terrible renter");
    expect(retaliation.status).toBe(409);
    expect(retaliation.body.message).toMatch(/window has closed/i);

    // And no second review was smuggled into the row count.
    const { rows } = await query(`SELECT count(*) FROM reviews WHERE booking_id = $1`, [bookingId]);
    expect(Number(rows[0].count)).toBe(1);
  });

  it("tells both parties when reviews become visible", async () => {
    const { owner, renter, bookingId } = await completed();
    await review(renter.agent, bookingId, 5);
    await review(owner.agent, bookingId, 5);

    const types = async (agent) =>
      (await agent.get("/api/notifications")).body.data.notifications.map((n) => n.type);

    expect(await types(owner.agent)).toContain("REVIEW_PUBLISHED");
    expect(await types(renter.agent)).toContain("REVIEW_PUBLISHED");
  });

  it("invites BOTH parties to review when a booking completes", async () => {
    const { owner, renter } = await completed();

    const types = async (agent) =>
      (await agent.get("/api/notifications")).body.data.notifications.map((n) => n.type);

    // The one booking notification sent to both. Every other tells the party who
    // did NOT act; completion opens something new for each of them.
    expect(await types(owner.agent)).toContain("REVIEW_INVITED");
    expect(await types(renter.agent)).toContain("REVIEW_INVITED");
  });
});

describe("FR-805 — the edit window, and where it collides with FR-804", () => {
  it("lets an author change an unpublished review", async () => {
    const { renter, bookingId } = await completed();
    const written = await review(renter.agent, bookingId, 2, "Scratched");

    const edited = await renter.agent
      .patch(`/api/reviews/${written.body.data.review.id}`)
      .send({ rating: 4, body: "Scratched, but the owner sorted it" });

    expect(edited.status).toBe(200);
    expect(edited.body.data.review.rating).toBe(4);
  });

  it("CLOSES the window the moment the review is published", async () => {
    // The requirement says "editable for 48 hours" and, separately, "blind until
    // both submit". Read independently they contradict: if the other party writes
    // an hour later, both publish — and a 48-hour window would then let you rewrite
    // yours HAVING READ THEIRS, which is exactly the retaliation FR-804 prevents.
    const { owner, renter, bookingId } = await completed();
    const written = await review(renter.agent, bookingId, 5, "Lovely");
    await review(owner.agent, bookingId, 1, "Awful renter");

    const retaliation = await renter.agent
      .patch(`/api/reviews/${written.body.data.review.id}`)
      .send({ rating: 1, body: "Actually terrible" });

    expect(retaliation.status).toBe(409);
    expect(retaliation.body.message).toMatch(/visible/i);
  });

  it("refuses an edit once the 48 hours are up", async () => {
    const { renter, bookingId } = await completed();
    const written = await review(renter.agent, bookingId, 3);

    await query(
      `UPDATE reviews SET created_at = now() - make_interval(hours => $1) WHERE id = $2`,
      [REVIEW_EDIT_HOURS + 1, written.body.data.review.id]
    );

    const late = await renter.agent
      .patch(`/api/reviews/${written.body.data.review.id}`)
      .send({ rating: 5 });

    expect(late.status).toBe(409);
  });

  it("lets nobody but the author edit, and nobody at all delete", async () => {
    const { owner, renter, bookingId } = await completed();
    const written = await review(renter.agent, bookingId, 3);
    const id = written.body.data.review.id;

    // 403 rather than 404: the owner is party to this booking, so they can see the
    // review exists — they are simply not its author.
    expect((await owner.agent.patch(`/api/reviews/${id}`).send({ rating: 5 })).status).toBe(403);

    // A reputation somebody can erase by deleting the bad ones is not a reputation,
    // and a convention is worth nothing here — the database refuses it.
    await expect(query(`DELETE FROM reviews WHERE id = $1`, [id])).rejects.toThrow(
      /cannot be deleted/
    );
  });
});

describe("FR-806, FR-807 — ratings and the public list", () => {
  it("keeps the two directions apart", async () => {
    const { owner, renter, bookingId } = await completed();
    await review(renter.agent, bookingId, 5, "Great owner");
    await review(owner.agent, bookingId, 2, "Late returning it");

    const aboutOwner = (await request(app).get(`/api/users/${owner.user.id}/reviews`)).body.data;
    const aboutRenter = (await request(app).get(`/api/users/${renter.user.id}/reviews`)).body.data;

    // Being good to lend to says very little about being good to lend TO. A single
    // blended number would average the two and hide exactly what somebody is
    // trying to find out.
    expect(aboutOwner.rating.asOwner).toEqual({ average: 5, count: 1 });
    expect(aboutOwner.rating.asRenter).toEqual({ average: null, count: 0 });
    expect(aboutRenter.rating.asRenter).toEqual({ average: 2, count: 1 });
    expect(aboutRenter.rating.asOwner).toEqual({ average: null, count: 0 });
  });

  it("is readable with no account at all — FR-807", async () => {
    const { owner, renter, bookingId } = await completed();
    await review(renter.agent, bookingId, 5, "Great owner");
    await review(owner.agent, bookingId, 5);

    const anonymous = await request(app).get(`/api/users/${owner.user.id}/reviews`);
    expect(anonymous.status).toBe(200);
    expect(anonymous.body.data.reviews[0].body).toBe("Great owner");
  });
});

describe("FR-808 — one public reply, by the subject", () => {
  it("lets the subject reply once a review is visible", async () => {
    const { owner, renter, bookingId } = await completed();
    await review(renter.agent, bookingId, 2, "Lens was scratched");
    await review(owner.agent, bookingId, 5);

    const { reviews } = await readReviews(owner.agent, bookingId);
    const aboutOwner = reviews.find((r) => r.subject_id === owner.user.id);

    const replied = await owner.agent
      .post(`/api/reviews/${aboutOwner.id}/reply`)
      .send({ body: "Sorry about that — it has been serviced since." });

    expect(replied.status).toBe(201);
    expect(replied.body.data.review.reply_body).toMatch(/serviced/);

    // One only. A reply that can be rewritten later is not a reply on the record.
    const second = await owner.agent
      .post(`/api/reviews/${aboutOwner.id}/reply`)
      .send({ body: "Actually, no." });
    expect(second.status).toBe(409);
  });

  it("refuses a reply from the author, and before publication", async () => {
    const { owner, renter, bookingId } = await completed();
    const written = await review(renter.agent, bookingId, 2, "Scratched");
    const id = written.body.data.review.id;

    // You cannot answer something nobody has been allowed to read yet.
    expect((await owner.agent.post(`/api/reviews/${id}/reply`).send({ body: "No" })).status).toBe(409);

    // And a review is not a conversation with yourself.
    expect((await renter.agent.post(`/api/reviews/${id}/reply`).send({ body: "Me" })).status).toBe(403);
  });
});

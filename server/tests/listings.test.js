/**
 * Listings, the rate card and photos — step 3.
 *
 * Two blocks carry the weight. **Ownership** (FR-111) is the whole authorization model
 * of this product: a relationship to a row, never a role, so it has to be probed from
 * the outside by a second account. **The publish gate** (FR-107) decides what strangers
 * can see, so every one of its conditions is asserted individually rather than trusting
 * that the function reads correctly.
 */

import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { query } from "../src/config/db.js";
import { getFakeUploads, clearFakeUploads } from "../src/config/cloudinary.js";
import { verifiedUser, unverifiedUser } from "./helpers/factories.js";

/** A minimal valid draft. Deliberately missing everything publishing needs. */
const DRAFT = {
  title: "Canon EOS R6 with 24-105mm lens",
  description: "Full-frame mirrorless, two batteries and a 64GB card included.",
  category: "cameras",
  condition: "GOOD",
};

/** Everything a listing needs to be publishable, apart from a photo. */
const READY = {
  ...DRAFT,
  dailyRatePaise: 150_000,
  depositPaise: 500_000,
  locality: "Kothrud",
  city: "Pune",
};

/** A real 1x1 JPEG — the first bytes are what the type sniffer reads. */
const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a" +
    "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA" +
    "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
  "base64"
);

/** A PNG, for asserting the sniffer accepts more than one format. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64"
);

/** Not an image at all, whatever it claims to be called. */
const NOT_AN_IMAGE = Buffer.from("<?php system($_GET['c']); ?>                    ");

beforeEach(() => clearFakeUploads());

/** Creates a draft through the API and returns its id. */
async function createDraft(agent, overrides = {}) {
  const response = await agent.post("/api/listings").send({ ...DRAFT, ...overrides });
  if (response.status !== 201) {
    throw new Error(`Fixture create failed (${response.status}): ${response.body?.message}`);
  }
  return response.body.data.listing.id;
}

/** Creates a listing with a photo and publishes it. */
async function createPublished(agent, overrides = {}) {
  const id = await createDraft(agent, { ...READY, ...overrides });
  await agent.post(`/api/listings/${id}/photos`).attach("photos", JPEG, "photo.jpg");
  const published = await agent.post(`/api/listings/${id}/publish`);
  if (published.status !== 200) {
    throw new Error(`Fixture publish failed (${published.status}): ${published.body?.message}`);
  }
  return id;
}

describe("GET /api/listings/categories", () => {
  it("is public and returns the seeded lookup table", async () => {
    const response = await request(app).get("/api/listings/categories");

    expect(response.status).toBe(200);
    expect(response.body.data.categories.length).toBeGreaterThan(5);
    // A slug, not a uuid: it is what the client sends back, and it is readable in a URL
    // and in an error message.
    expect(response.body.data.categories.map((c) => c.slug)).toContain("cameras");
  });
});

describe("POST /api/listings — FR-100", () => {
  it("creates a DRAFT, never a published listing", async () => {
    const { agent } = await verifiedUser(app);

    const response = await agent.post("/api/listings").send(DRAFT);

    expect(response.status).toBe(201);
    expect(response.body.data.listing.status).toBe("DRAFT");
    expect(response.body.data.listing.published_at).toBeNull();
  });

  it("accepts a draft with NO price, NO location and NO photos", async () => {
    const { agent } = await verifiedUser(app);

    // The point of a draft. Refusing to save one without a price would stop somebody
    // who wants to think about the price overnight from starting at all.
    const response = await agent.post("/api/listings").send(DRAFT);
    expect(response.status).toBe(201);
    expect(response.body.data.listing.daily_rate_paise).toBeNull();
    expect(response.body.data.listing.city).toBeNull();
  });

  it("cannot be told to publish itself, whatever the body says", async () => {
    const { agent } = await verifiedUser(app);

    const response = await agent
      .post("/api/listings")
      .send({ ...DRAFT, status: "PUBLISHED", publishedAt: "2020-01-01", ownerId: "someone-else" });

    // Zod strips unknown keys, so none of these reached a service. Publishing has
    // conditions (FR-107) and an insert that could set PUBLISHED would be a route
    // straight past them.
    expect(response.status).toBe(201);
    expect(response.body.data.listing.status).toBe("DRAFT");
  });

  it("refuses an UNVERIFIED account — the first real use of requireVerifiedEmail", async () => {
    const { agent } = await unverifiedUser(app);

    const response = await agent.post("/api/listings").send(DRAFT);

    // FR-005 has been a design intention with nothing enforcing it since step 1. This
    // is the first route that actually gates on it.
    expect(response.status).toBe(403);
    expect(response.body.errors.reason).toBe("EMAIL_NOT_VERIFIED");
  });

  it("refuses an unknown category", async () => {
    const { agent } = await verifiedUser(app);
    const response = await agent.post("/api/listings").send({ ...DRAFT, category: "spaceships" });
    expect(response.status).toBe(400);
  });

  it("refuses a rate that is not a whole number of paise", async () => {
    const { agent } = await verifiedUser(app);

    // Money as a float is a bug waiting for the first 0.1 + 0.2, and rupees-as-decimal
    // is exactly how it gets in.
    const response = await agent.post("/api/listings").send({ ...DRAFT, dailyRatePaise: 1500.5 });
    expect(response.status).toBe(400);
  });

  it("refuses a maximum duration shorter than the minimum", async () => {
    const { agent } = await verifiedUser(app);
    const response = await agent
      .post("/api/listings")
      .send({ ...DRAFT, minDurationHours: 48, maxDurationHours: 24 });
    expect(response.status).toBe(400);
  });
});

describe("ownership — FR-111", () => {
  it("hides a DRAFT from everyone but its owner, with a 404 not a 403", async () => {
    const owner = await verifiedUser(app);
    const stranger = await verifiedUser(app);
    const id = await createDraft(owner.agent);

    // 404, deliberately. A 403 would confirm that this id is somebody's unpublished
    // listing — exactly the fact a draft exists to keep private.
    for (const response of [
      await stranger.agent.get(`/api/listings/${id}`),
      await request(app).get(`/api/listings/${id}`),
    ]) {
      expect(response.status).toBe(404);
    }

    expect((await owner.agent.get(`/api/listings/${id}`)).status).toBe(200);
  });

  it("answers 403 — not 404 — when a stranger tries to edit a PUBLISHED listing", async () => {
    const owner = await verifiedUser(app);
    const stranger = await verifiedUser(app);
    const id = await createPublished(owner.agent);

    // The opposite call from the draft case, and for a reason: a published listing is
    // world-readable, so pretending it does not exist would be theatre.
    const response = await stranger.agent.patch(`/api/listings/${id}`).send({ title: "Mine now" });
    expect(response.status).toBe(403);
  });

  it("refuses every mutating action from a stranger", async () => {
    const owner = await verifiedUser(app);
    const stranger = await verifiedUser(app);
    const id = await createPublished(owner.agent);

    const attempts = [
      stranger.agent.patch(`/api/listings/${id}`).send({ title: "Mine" }),
      stranger.agent.post(`/api/listings/${id}/publish`),
      stranger.agent.post(`/api/listings/${id}/unpublish`),
      stranger.agent.delete(`/api/listings/${id}`),
      stranger.agent.post(`/api/listings/${id}/photos`).attach("photos", JPEG, "x.jpg"),
      stranger.agent.get(`/api/listings/${id}/readiness`),
    ];

    for (const response of await Promise.all(attempts)) {
      expect([403, 404]).toContain(response.status);
    }

    // And nothing changed.
    const { rows } = await query(`SELECT title, status FROM listings WHERE id = $1`, [id]);
    expect(rows[0]).toMatchObject({ title: READY.title, status: "PUBLISHED" });
  });

  it("shows an owner their own drafts in /mine — FR-115", async () => {
    const owner = await verifiedUser(app);
    const stranger = await verifiedUser(app);
    await createDraft(owner.agent);
    await createDraft(stranger.agent);

    const response = await owner.agent.get("/api/listings/mine");

    expect(response.status).toBe(200);
    expect(response.body.data.listings).toHaveLength(1);
    expect(response.body.data.listings[0].status).toBe("DRAFT");
  });

  it("routes /mine to the owner's list, not into the :id handler", async () => {
    const { agent } = await verifiedUser(app);

    // Express matches in declaration order. With /:id declared first, "mine" would be
    // captured as an id, fail the UUID shape check and answer 404 — a routing bug that
    // looks exactly like a missing record.
    expect((await agent.get("/api/listings/mine")).status).toBe(200);
  });
});

describe("the publish gate — FR-107", () => {
  it("names EVERY unmet condition at once, not the first", async () => {
    const { agent } = await verifiedUser(app);
    const id = await createDraft(agent);

    const response = await agent.post(`/api/listings/${id}/publish`);

    expect(response.status).toBe(409);
    // Reporting them one at a time turns publishing into a guessing game where each fix
    // reveals the next obstacle.
    expect(response.body.message).toMatch(/photo/i);
    expect(response.body.message).toMatch(/price/i);
    expect(response.body.message).toMatch(/where/i);
  });

  it("refuses without a photo", async () => {
    const { agent } = await verifiedUser(app);
    const id = await createDraft(agent, READY);

    const response = await agent.post(`/api/listings/${id}/publish`);
    expect(response.status).toBe(409);
    expect(response.body.message).toMatch(/photo/i);
  });

  it("refuses without any rate at all", async () => {
    const { agent } = await verifiedUser(app);
    const { dailyRatePaise, ...noRate } = READY;
    const id = await createDraft(agent, noRate);
    await agent.post(`/api/listings/${id}/photos`).attach("photos", JPEG, "p.jpg");

    const response = await agent.post(`/api/listings/${id}/publish`);
    expect(response.status).toBe(409);
    expect(response.body.message).toMatch(/price/i);
  });

  it("accepts ANY ONE of the three rates", async () => {
    const { agent } = await verifiedUser(app);
    const { dailyRatePaise, ...base } = READY;

    for (const rate of ["hourlyRatePaise", "dailyRatePaise", "monthlyRatePaise"]) {
      const id = await createDraft(agent, { ...base, [rate]: 50_000 });
      await agent.post(`/api/listings/${id}/photos`).attach("photos", JPEG, "p.jpg");

      const response = await agent.post(`/api/listings/${id}/publish`);
      expect(response.status, `publishing with only ${rate}`).toBe(200);
    }
  });

  it("refuses without a location", async () => {
    const { agent } = await verifiedUser(app);
    const { city, locality, ...noPlace } = READY;
    const id = await createDraft(agent, noPlace);
    await agent.post(`/api/listings/${id}/photos`).attach("photos", JPEG, "p.jpg");

    const response = await agent.post(`/api/listings/${id}/publish`);
    expect(response.status).toBe(409);
    expect(response.body.message).toMatch(/where/i);
  });

  it("reports the same conditions through /readiness, without publishing anything", async () => {
    const { agent } = await verifiedUser(app);
    const id = await createDraft(agent);

    const response = await agent.get(`/api/listings/${id}/readiness`);

    // Same function as the gate itself, so the checklist the owner sees cannot drift
    // from the rule that actually refuses them.
    expect(response.status).toBe(200);
    expect(response.body.data.canPublish).toBe(false);
    expect(response.body.data.blockers.length).toBe(3);

    const { rows } = await query(`SELECT status FROM listings WHERE id = $1`, [id]);
    expect(rows[0].status).toBe("DRAFT");
  });

  it("publishes when everything is in place, and stamps published_at once", async () => {
    const { agent } = await verifiedUser(app);
    const id = await createPublished(agent);

    const { rows: first } = await query(`SELECT published_at FROM listings WHERE id = $1`, [id]);
    expect(first[0].published_at).not.toBeNull();

    await agent.post(`/api/listings/${id}/unpublish`);
    await agent.post(`/api/listings/${id}/publish`);

    const { rows: second } = await query(`SELECT published_at FROM listings WHERE id = $1`, [id]);
    // Records when it FIRST went live — a different question from whether it is live
    // now, which `status` already answers.
    expect(second[0].published_at).toEqual(first[0].published_at);
  });

  it("makes a published listing readable by a signed-out visitor", async () => {
    const { agent } = await verifiedUser(app);
    const id = await createPublished(agent);

    const response = await request(app).get(`/api/listings/${id}`);
    expect(response.status).toBe(200);
    expect(response.body.data.listing.photos).toHaveLength(1);
  });

  it("hides it again on unpublish — FR-109", async () => {
    const { agent } = await verifiedUser(app);
    const id = await createPublished(agent);

    await agent.post(`/api/listings/${id}/unpublish`);

    expect((await request(app).get(`/api/listings/${id}`)).status).toBe(404);
    // Still the owner's, and still editable.
    expect((await agent.get(`/api/listings/${id}`)).status).toBe(200);
  });
});

describe("editing — FR-108", () => {
  it("changes only the fields sent", async () => {
    const { agent } = await verifiedUser(app);
    const id = await createDraft(agent, READY);

    const response = await agent.patch(`/api/listings/${id}`).send({ title: "Canon EOS R6 II" });

    expect(response.status).toBe(200);
    expect(response.body.data.listing.title).toBe("Canon EOS R6 II");
    expect(response.body.data.listing.daily_rate_paise).toBe(READY.dailyRatePaise);
    expect(response.body.data.listing.city).toBe("Pune");
  });

  it("clears a rate with null, and leaves it alone when the field is absent", async () => {
    const { agent } = await verifiedUser(app);
    const id = await createDraft(agent, READY);

    await agent.patch(`/api/listings/${id}`).send({ title: "Same camera" });
    let { rows } = await query(`SELECT daily_rate_paise FROM listings WHERE id = $1`, [id]);
    expect(rows[0].daily_rate_paise).toBe(READY.dailyRatePaise);

    await agent.patch(`/api/listings/${id}`).send({ dailyRatePaise: null });
    ({ rows } = await query(`SELECT daily_rate_paise FROM listings WHERE id = $1`, [id]));
    expect(rows[0].daily_rate_paise).toBeNull();
  });

  it("validates the MERGED duration range, not just the patch", async () => {
    const { agent } = await verifiedUser(app);
    const id = await createDraft(agent, { ...DRAFT, minDurationHours: 48 });

    // The usual shape of this bug: with both fields optional, a body carrying only the
    // maximum can invert the range against a stored minimum the schema never sees.
    const response = await agent.patch(`/api/listings/${id}`).send({ maxDurationHours: 24 });
    expect(response.status).toBe(400);
  });

  it("is allowed while PUBLISHED — correcting a live listing is ordinary", async () => {
    const { agent } = await verifiedUser(app);
    const id = await createPublished(agent);

    const response = await agent.patch(`/api/listings/${id}`).send({ description: "Now with a tripod." });
    expect(response.status).toBe(200);
    expect(response.body.data.listing.status).toBe("PUBLISHED");
  });

  it("refuses an empty body", async () => {
    const { agent } = await verifiedUser(app);
    const id = await createDraft(agent);
    expect((await agent.patch(`/api/listings/${id}`).send({})).status).toBe(400);
  });
});

describe("photos — FR-105, FR-106", () => {
  it("accepts a real JPEG and a real PNG", async () => {
    const { agent } = await verifiedUser(app);
    const id = await createDraft(agent);

    const response = await agent
      .post(`/api/listings/${id}/photos`)
      .attach("photos", JPEG, "one.jpg")
      .attach("photos", PNG, "two.png");

    expect(response.status).toBe(201);
    expect(response.body.data.listing.photos).toHaveLength(2);
    expect(getFakeUploads()).toHaveLength(2);
  });

  it("REJECTS a file that is not really an image, however it is named", async () => {
    const { agent } = await verifiedUser(app);
    const id = await createDraft(agent);

    // The extension and the Content-Type are both supplied by the uploader, so both are
    // claims rather than facts. Only the leading bytes are dictated by the format.
    const response = await agent
      .post(`/api/listings/${id}/photos`)
      .attach("photos", NOT_AN_IMAGE, { filename: "holiday.jpg", contentType: "image/jpeg" });

    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/not a .*image/i);

    // And nothing was uploaded — validation happens before the provider is touched, so
    // a rejected request never creates a remote asset.
    expect(getFakeUploads()).toHaveLength(0);
  });

  it("rejects the WHOLE batch when one file is bad", async () => {
    const { agent } = await verifiedUser(app);
    const id = await createDraft(agent);

    const response = await agent
      .post(`/api/listings/${id}/photos`)
      .attach("photos", JPEG, "good.jpg")
      .attach("photos", NOT_AN_IMAGE, { filename: "bad.jpg", contentType: "image/jpeg" });

    // A listing that silently came out with three photos when four were chosen is a bug
    // the user cannot see or explain.
    expect(response.status).toBe(400);
    expect(getFakeUploads()).toHaveLength(0);

    const { rows } = await query(`SELECT count(*)::int AS n FROM listing_photos WHERE listing_id = $1`, [id]);
    expect(rows[0].n).toBe(0);
  });

  it("caps a listing at eight photos, counting what is already there", async () => {
    const { agent } = await verifiedUser(app);
    const id = await createDraft(agent);

    let batch = agent.post(`/api/listings/${id}/photos`);
    for (let i = 0; i < 6; i += 1) batch = batch.attach("photos", JPEG, `p${i}.jpg`);
    expect((await batch).status).toBe(201);

    const response = await agent
      .post(`/api/listings/${id}/photos`)
      .attach("photos", JPEG, "seven.jpg")
      .attach("photos", JPEG, "eight.jpg")
      .attach("photos", JPEG, "nine.jpg");

    // The cap is checked against the stored count BEFORE uploading, so an over-cap
    // request never creates a remote asset either.
    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/2 more/);
  });

  it("numbers photos from zero, appending after what exists", async () => {
    const { agent } = await verifiedUser(app);
    const id = await createDraft(agent);

    await agent.post(`/api/listings/${id}/photos`).attach("photos", JPEG, "a.jpg");
    const response = await agent.post(`/api/listings/${id}/photos`).attach("photos", PNG, "b.png");

    expect(response.body.data.listing.photos.map((p) => p.sortOrder)).toEqual([0, 1]);
  });

  it("reorders, making position 0 the cover", async () => {
    const { agent } = await verifiedUser(app);
    const id = await createDraft(agent);

    const created = await agent
      .post(`/api/listings/${id}/photos`)
      .attach("photos", JPEG, "a.jpg")
      .attach("photos", PNG, "b.png")
      .attach("photos", JPEG, "c.jpg");

    const [a, b, c] = created.body.data.listing.photos.map((p) => p.id);

    // A permutation passes through states where two rows share a position. This only
    // works because uq_listing_photo_position is DEFERRABLE INITIALLY DEFERRED — with a
    // normal UNIQUE, every reorder that is not a strict rotation would be refused.
    const response = await agent
      .patch(`/api/listings/${id}/photos/order`)
      .send({ photoIds: [c, a, b] });

    expect(response.status).toBe(200);
    expect(response.body.data.listing.photos.map((p) => p.id)).toEqual([c, a, b]);
  });

  it("refuses a partial reorder", async () => {
    const { agent } = await verifiedUser(app);
    const id = await createDraft(agent);
    const created = await agent
      .post(`/api/listings/${id}/photos`)
      .attach("photos", JPEG, "a.jpg")
      .attach("photos", PNG, "b.png");

    const [a] = created.body.data.listing.photos.map((p) => p.id);

    // "What happened to the rest?" has no good answer, so it is refused rather than
    // guessed at.
    expect((await agent.patch(`/api/listings/${id}/photos/order`).send({ photoIds: [a] })).status).toBe(400);
  });

  it("deletes one photo, and only from its own listing", async () => {
    const { agent } = await verifiedUser(app);
    const mine = await createDraft(agent);
    const other = await createDraft(agent);

    const created = await agent.post(`/api/listings/${mine}/photos`).attach("photos", JPEG, "a.jpg");
    const photoId = created.body.data.listing.photos[0].id;

    // Scoped by listing as well as by photo id: knowing a photo's uuid must not be
    // enough to delete it through a different listing.
    expect((await agent.delete(`/api/listings/${other}/photos/${photoId}`)).status).toBe(404);

    const response = await agent.delete(`/api/listings/${mine}/photos/${photoId}`);
    expect(response.status).toBe(200);
    expect(response.body.data.listing.photos).toHaveLength(0);
  });

  it("stores an id and never a URL, and serves transformed URLs on read", async () => {
    const { agent } = await verifiedUser(app);
    const id = await createDraft(agent);
    const created = await agent.post(`/api/listings/${id}/photos`).attach("photos", JPEG, "a.jpg");

    const { rows } = await query(`SELECT storage_id FROM listing_photos WHERE listing_id = $1`, [id]);
    // THE MOST IMPORTANT RULE ON THAT TABLE. A URL bakes the provider, the account, the
    // CDN domain and the transformation into thousands of rows.
    expect(rows[0].storage_id).not.toMatch(/^https?:/);

    const photo = created.body.data.listing.photos[0];
    // f_auto/q_auto routinely halve the bytes for no visible difference, which on a
    // marketplace grid over mobile data is the difference between usable and not.
    expect(photo.thumbUrl).toMatch(/w_400.*f_auto.*q_auto/);
    expect(photo.url).toMatch(/w_1200.*f_auto.*q_auto/);
  });
});

describe("deleting — FR-110", () => {
  it("removes the listing, its photo rows and its remote assets", async () => {
    const { agent } = await verifiedUser(app);
    const id = await createDraft(agent);
    await agent.post(`/api/listings/${id}/photos`).attach("photos", JPEG, "a.jpg");
    expect(getFakeUploads()).toHaveLength(1);

    const response = await agent.delete(`/api/listings/${id}`);
    expect(response.status).toBe(200);

    const { rows } = await query(`SELECT count(*)::int AS n FROM listing_photos WHERE listing_id = $1`, [id]);
    expect(rows[0].n).toBe(0);
    expect(getFakeUploads()).toHaveLength(0);
  });

  it("answers an identical 404 for an unknown id and a malformed one", async () => {
    const { agent } = await verifiedUser(app);

    const responses = await Promise.all([
      agent.get("/api/listings/11111111-1111-4111-8111-111111111111"),
      agent.get("/api/listings/not-a-uuid"),
    ]);

    // "That is not a UUID" and "no such listing" are the same answer from outside, and
    // the messages must match exactly or the pair becomes an oracle.
    for (const response of responses) {
      expect(response.status).toBe(404);
      expect(response.body).toEqual(responses[0].body);
    }
  });
});

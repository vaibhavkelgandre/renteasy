/**
 * Browse and search — step 5, FR-300 to FR-309.
 *
 * Two blocks carry the weight. **FR-309** — drafts and unpublished listings must never
 * appear — is the one where a mistake leaks somebody's private work to the whole
 * internet, so it is probed from every filter rather than trusted to one WHERE clause.
 * **FR-307** — `total` counted from the same query as the page — is the one that fails
 * silently, producing a pager offering a page that renders empty.
 */

import { describe, it, expect } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { verifiedUser } from "./helpers/factories.js";

const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a" +
    "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA" +
    "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
  "base64"
);

/** Creates a listing and publishes it, returning its id. */
async function publish(agent, overrides = {}) {
  const body = {
    title: "Canon EOS R6",
    description: "Full-frame mirrorless with two batteries and a card.",
    category: "cameras",
    condition: "GOOD",
    dailyRatePaise: 150_000,
    locality: "Kothrud",
    city: "Pune",
    ...overrides,
  };

  const created = await agent.post("/api/listings").send(body);
  if (created.status !== 201) {
    throw new Error(`Fixture create failed (${created.status}): ${created.body?.message}`);
  }

  const id = created.body.data.listing.id;
  await agent.post(`/api/listings/${id}/photos`).attach("photos", JPEG, "p.jpg");

  const published = await agent.post(`/api/listings/${id}/publish`);
  if (published.status !== 200) {
    throw new Error(`Fixture publish failed (${published.status}): ${published.body?.message}`);
  }
  return id;
}

/** Creates a draft that is never published. */
async function draft(agent, overrides = {}) {
  const created = await agent.post("/api/listings").send({
    title: "Secret unfinished thing",
    description: "Nobody should ever see this in a browse result.",
    category: "cameras",
    condition: "GOOD",
    ...overrides,
  });
  return created.body.data.listing.id;
}

const browse = (query = "") => request(app).get(`/api/listings${query}`);

describe("FR-300 — browsing needs no account", () => {
  it("returns published listings to a signed-out visitor", async () => {
    const { agent } = await verifiedUser(app);
    await publish(agent);

    const response = await browse();

    expect(response.status).toBe(200);
    expect(response.body.data.listings).toHaveLength(1);
    expect(response.body.data.listings[0].title).toBe("Canon EOS R6");
  });

  it("includes a cover image URL, built on read", async () => {
    const { agent } = await verifiedUser(app);
    await publish(agent);

    const [listing] = (await browse()).body.data.listings;

    // A cover only — building URLs for every photo of every listing on the page would
    // be work nobody looks at.
    expect(listing.coverUrl).toMatch(/w_400.*f_auto.*q_auto/);
    expect(listing.coverUrl).not.toMatch(/^https?:\/\/[^/]+$/);
  });

  it("answers with an empty page rather than an error when nothing matches", async () => {
    const response = await browse("?q=nothing-here-matches-this");

    expect(response.status).toBe(200);
    expect(response.body.data.listings).toEqual([]);
    expect(response.body.data.total).toBe(0);
  });
});

describe("FR-309 — nothing unpublished ever appears", () => {
  it("hides drafts and unpublished listings from every browse result", async () => {
    const { agent } = await verifiedUser(app);

    const live = await publish(agent);
    await draft(agent);

    const hidden = await publish(agent, { title: "Was live, now hidden" });
    await agent.post(`/api/listings/${hidden}/unpublish`);

    const response = await browse();

    // The single most consequential rule here: a draft is somebody's unfinished work
    // and an unpublished listing was deliberately withdrawn. Either appearing is a
    // leak, not a display bug.
    expect(response.body.data.listings.map((l) => l.id)).toEqual([live]);
    expect(response.body.data.total).toBe(1);
  });

  it("keeps them hidden through EVERY filter, not just the default view", async () => {
    const { agent } = await verifiedUser(app);
    await draft(agent, { title: "Findable draft", city: "Pune" });

    // Probed through each filter separately, because the status condition lives in one
    // clause that every one of these composes with — and a filter added later could
    // reasonably be written in a way that drops it.
    const queries = [
      "",
      "?category=cameras",
      "?city=Pune",
      "?q=Findable",
      "?q=draft",
      "?sort=price_asc",
      "?sort=newest&limit=48",
      "?unit=daily&minPricePaise=0",
    ];

    for (const query of queries) {
      const response = await browse(query);
      expect(response.status, query).toBe(200);
      expect(response.body.data.total, `leaked through ${query || "(no filter)"}`).toBe(0);
    }
  });

  it("stops showing a listing the moment it is unpublished", async () => {
    const { agent } = await verifiedUser(app);
    const id = await publish(agent);

    expect((await browse()).body.data.total).toBe(1);

    await agent.post(`/api/listings/${id}/unpublish`);
    expect((await browse()).body.data.total).toBe(0);
  });
});

describe("FR-307 — pagination, defaulted and capped", () => {
  it("counts `total` over everything matching, not just the page", async () => {
    const { agent } = await verifiedUser(app);
    for (let i = 0; i < 5; i += 1) await publish(agent, { title: `Camera ${i}` });

    const response = await browse("?limit=2");

    // The bug this prevents is a pager that offers page four and renders nothing. The
    // count comes from `count(*) OVER ()` in the same statement as the rows, so it
    // cannot be computed from different conditions than the page.
    expect(response.body.data.listings).toHaveLength(2);
    expect(response.body.data.total).toBe(5);
  });

  it("counts against the FILTER, not the whole table", async () => {
    const { agent } = await verifiedUser(app);
    await publish(agent, { title: "Canon camera" });
    await publish(agent, { title: "Nikon camera" });
    await publish(agent, { title: "Bajaj Pulsar", category: "bikes" });

    const response = await browse("?category=bikes");
    expect(response.body.data.total).toBe(1);
    expect(response.body.data.listings).toHaveLength(1);
  });

  it("walks pages without repeating or skipping a listing", async () => {
    const { agent } = await verifiedUser(app);
    // All at the same price, so the ordering has to fall through to the tiebreaker.
    for (let i = 0; i < 6; i += 1) await publish(agent, { title: `Item ${i}`, dailyRatePaise: 50_000 });

    const seen = [];
    for (let offset = 0; offset < 6; offset += 2) {
      const page = await browse(`?limit=2&offset=${offset}&sort=price_asc`);
      seen.push(...page.body.data.listings.map((l) => l.id));
    }

    // Without `created_at DESC` as a tiebreaker, rows at an equal price have no defined
    // order and the same one can appear on two pages — the classic unstable-pagination
    // bug, which only shows up once there is enough data to paginate.
    expect(new Set(seen).size).toBe(6);
  });

  it("defaults the page size when none is asked for", async () => {
    const response = await browse();
    // A caller that asks for no page still gets a bounded one.
    expect(response.body.data.limit).toBe(24);
    expect(response.body.data.offset).toBe(0);
  });

  it("REFUSES a limit above the cap rather than serving the whole table", async () => {
    const response = await browse("?limit=100000");

    // Without the cap, pagination is decoration over an unbounded query. Refused
    // outright rather than silently clamped, so a caller learns their request was not
    // honoured.
    expect(response.status).toBe(400);
    expect(response.body.errors.limit).toBeDefined();
  });

  it("coerces query strings to numbers", async () => {
    // A query string is always strings. Without z.coerce, `?limit=5` fails validation
    // and every page request in the product breaks.
    const response = await browse("?limit=5&offset=0");
    expect(response.status).toBe(200);
    expect(response.body.data.limit).toBe(5);
  });
});

describe("FR-301 to FR-306 — filters, search and sort", () => {
  it("filters by category", async () => {
    const { agent } = await verifiedUser(app);
    await publish(agent, { title: "A camera" });
    await publish(agent, { title: "A bike", category: "bikes" });

    const response = await browse("?category=bikes");
    expect(response.body.data.listings.map((l) => l.title)).toEqual(["A bike"]);
  });

  it("filters by city, case-insensitively", async () => {
    const { agent } = await verifiedUser(app);
    await publish(agent, { title: "In Pune", city: "Pune" });
    await publish(agent, { title: "In Mumbai", city: "Mumbai" });

    // lower() on both sides, matching the index. Comparing the raw column would miss
    // "pune" against a listing stored as "Pune".
    const response = await browse("?city=pune");
    expect(response.body.data.listings.map((l) => l.title)).toEqual(["In Pune"]);
  });

  it("searches title AND description, on partial words", async () => {
    const { agent } = await verifiedUser(app);
    await publish(agent, { title: "Bajaj Pulsar 150", category: "bikes" });
    await publish(agent, { title: "Canon EOS", description: "A camera for weddings and travel." });

    // Trigram matching is why partial input works. Full-text search would stem whole
    // words and find nothing for "puls".
    expect((await browse("?q=puls")).body.data.total).toBe(1);

    // And the term is matched against the description too, not only the title.
    expect((await browse("?q=weddings")).body.data.total).toBe(1);
  });

  it("treats % and _ in a search term as literal characters", async () => {
    const { agent } = await verifiedUser(app);
    await publish(agent, { title: "Ordinary camera" });

    // Unescaped, `%` in a LIKE pattern matches everything — so a user typing "50% off"
    // would get the entire catalogue back and no indication why.
    expect((await browse("?q=%25")).body.data.total).toBe(0);
    expect((await browse("?q=_")).body.data.total).toBe(0);
  });

  it("filters by price against the CHOSEN unit — FR-302", async () => {
    const { agent } = await verifiedUser(app);
    await publish(agent, { title: "Cheap daily", dailyRatePaise: 50_000 });
    await publish(agent, { title: "Pricey daily", dailyRatePaise: 500_000 });

    const response = await browse("?unit=daily&maxPricePaise=100000");
    expect(response.body.data.listings.map((l) => l.title)).toEqual(["Cheap daily"]);
  });

  it("excludes listings with no rate for the unit being filtered on", async () => {
    const { agent } = await verifiedUser(app);
    await publish(agent, { title: "Daily only", dailyRatePaise: 50_000 });
    await publish(agent, {
      title: "Monthly only",
      dailyRatePaise: null,
      monthlyRatePaise: 900_000,
    });

    // "Under ₹1000 a day" cannot sensibly include something with only a monthly price,
    // and silently keeping it would make the filter look broken.
    const response = await browse("?unit=daily&maxPricePaise=100000");
    expect(response.body.data.listings.map((l) => l.title)).toEqual(["Daily only"]);
  });

  it("sorts by price, with unpriced listings LAST", async () => {
    const { agent } = await verifiedUser(app);
    await publish(agent, { title: "Mid", dailyRatePaise: 200_000 });
    await publish(agent, { title: "Cheap", dailyRatePaise: 50_000 });
    await publish(agent, { title: "No daily rate", dailyRatePaise: null, monthlyRatePaise: 10_000 });

    const response = await browse("?sort=price_asc&unit=daily");

    // Postgres sorts NULLs FIRST on ASC by default, which would put every listing with
    // no daily rate at the top of "cheapest first".
    expect(response.body.data.listings.map((l) => l.title)).toEqual([
      "Cheap",
      "Mid",
      "No daily rate",
    ]);
  });

  it("defaults to newest first", async () => {
    const { agent } = await verifiedUser(app);
    await publish(agent, { title: "Older" });
    await publish(agent, { title: "Newer" });

    const response = await browse();
    expect(response.body.data.listings.map((l) => l.title)).toEqual(["Newer", "Older"]);
  });

  it("combines filters rather than letting the last one win", async () => {
    const { agent } = await verifiedUser(app);
    await publish(agent, { title: "Pune camera", city: "Pune", dailyRatePaise: 50_000 });
    await publish(agent, { title: "Pune bike", city: "Pune", category: "bikes", dailyRatePaise: 50_000 });
    await publish(agent, { title: "Mumbai camera", city: "Mumbai", dailyRatePaise: 50_000 });

    const response = await browse("?city=Pune&category=cameras&unit=daily&maxPricePaise=100000");
    expect(response.body.data.listings.map((l) => l.title)).toEqual(["Pune camera"]);
  });

  it("refuses a maximum price below the minimum", async () => {
    const response = await browse("?minPricePaise=500000&maxPricePaise=100");
    expect(response.status).toBe(400);
  });

  it("refuses an unknown sort rather than silently ignoring it", async () => {
    // Silently falling back would let a caller believe they had sorted by something.
    expect((await browse("?sort=cheapest")).status).toBe(400);
    expect((await browse("?unit=weekly")).status).toBe(400);
  });
});

describe("GET /api/listings/cities", () => {
  it("lists only cities that currently have something published", async () => {
    const { agent } = await verifiedUser(app);
    await publish(agent, { city: "Pune" });
    await draft(agent, { city: "Nagpur" });

    const response = await request(app).get("/api/listings/cities");

    // Derived rather than a fixed list, which would go stale in both directions —
    // offering places with nothing to rent and omitting the one somebody just listed
    // in. A draft's city must not appear, for the same reason the draft must not.
    expect(response.body.data.cities).toEqual(["Pune"]);
  });
});

describe("route ordering", () => {
  it("does not let /:id swallow the literal browse paths", async () => {
    // Express matches in declaration order. With /:id first, "cities" and "categories"
    // would be captured as ids, fail the UUID shape check and answer 404 — a routing
    // bug that looks exactly like a missing record.
    expect((await request(app).get("/api/listings/cities")).status).toBe(200);
    expect((await request(app).get("/api/listings/categories")).status).toBe(200);
    expect((await request(app).get("/api/listings")).status).toBe(200);
  });
});

describe("GET /listings/:id/quote — FR-400 to FR-404", () => {
  const RANGE = "?start=2026-10-01T00:00:00Z&end=2026-11-10T00:00:00Z"; // 40 days

  it("prices a rental without an account", async () => {
    const { agent } = await verifiedUser(app);
    const id = await publish(agent, { dailyRatePaise: 80_000, monthlyRatePaise: 1_500_000 });

    const response = await request(app).get(`/api/listings/${id}/quote${RANGE}`);

    // The 40-day worked example: a month plus ten days, not 40 × the daily rate.
    expect(response.status).toBe(200);
    expect(response.body.data.quote.rentPaise).toBe(2_300_000);
    expect(response.body.data.quote.lines).toHaveLength(2);
  });

  it("itemises, and keeps the deposit out of the rent", async () => {
    const { agent } = await verifiedUser(app);
    const id = await publish(agent, { dailyRatePaise: 80_000, depositPaise: 500_000 });

    const { quote } = (
      await request(app).get(
        `/api/listings/${id}/quote?start=2026-10-01T00:00:00Z&end=2026-10-02T00:00:00Z`
      )
    ).body.data;

    expect(quote.lines[0]).toMatchObject({ unit: "day", quantity: 1 });
    expect(quote.rentPaise).toBe(80_000);
    expect(quote.depositPaise).toBe(500_000);
    expect(quote.renterTotalPaise).toBe(580_000);
    // Commission comes out of the owner's side, so it never inflates what is quoted:
    // the renter's total is exactly rent + deposit, with no trace of it.
    expect(quote.commissionPaise).toBeGreaterThan(0);
    expect(quote.renterTotalPaise).toBe(quote.rentPaise + quote.taxPaise + quote.depositPaise);
    expect(quote.ownerPayoutPaise).toBe(quote.rentPaise - quote.commissionPaise);
  });

  it("reports a duration blocker instead of refusing to price it", async () => {
    const { agent } = await verifiedUser(app);
    const id = await publish(agent, { minDurationHours: 48 });

    const response = await request(app).get(
      `/api/listings/${id}/quote?start=2026-10-01T00:00:00Z&end=2026-10-01T06:00:00Z`
    );

    // Same shape as the publish checklist: somebody who cannot see the price cannot
    // work out what to change.
    expect(response.status).toBe(200);
    expect(response.body.data.quote.rentPaise).toBeGreaterThan(0);
    expect(response.body.data.blockers[0]).toMatch(/minimum rental of 2 days/);
  });

  it("has no blockers for a range within the listing's limits", async () => {
    const { agent } = await verifiedUser(app);
    const id = await publish(agent, { minDurationHours: 2, maxDurationHours: 720 });

    const response = await request(app).get(
      `/api/listings/${id}/quote?start=2026-10-01T00:00:00Z&end=2026-10-02T00:00:00Z`
    );
    expect(response.body.data.blockers).toEqual([]);
  });

  it("refuses an inverted range with a 400, not a 500", async () => {
    const { agent } = await verifiedUser(app);
    const id = await publish(agent);

    const response = await request(app).get(
      `/api/listings/${id}/quote?start=2026-10-02T00:00:00Z&end=2026-10-01T00:00:00Z`
    );
    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/end after/i);
  });

  it("will not price a draft for a stranger, but will for its owner", async () => {
    const { agent } = await verifiedUser(app);
    // Priced deliberately: the bare draft fixture has no rate, and an unpriced listing
    // answers 400 for everyone — which would hide the 404-versus-200 distinction this
    // test exists to check.
    const id = await draft(agent, { dailyRatePaise: 80_000 });

    // Same rule as the detail page: a draft is invisible, so its price is too.
    expect((await request(app).get(`/api/listings/${id}/quote${RANGE}`)).status).toBe(404);
    expect((await agent.get(`/api/listings/${id}/quote${RANGE}`)).status).toBe(200);
  });

  it("refuses to price a listing with no rate at all", async () => {
    const { agent } = await verifiedUser(app);
    const id = await draft(agent);

    // 400 rather than quoting ₹0, which would be a free camera.
    const response = await agent.get(`/api/listings/${id}/quote${RANGE}`);
    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/no price/i);
  });
});

describe("your own listings are not things you can rent — FR-502 on the browse side", () => {
  it("hides them from you, and shows them to everybody else", async () => {
    const owner = await verifiedUser(app);
    const stranger = await verifiedUser(app);

    await publish(owner.agent, { title: "My own tripod" });
    await publish(stranger.agent, { title: "Somebody else's tripod" });

    const mine = await owner.agent.get("/api/listings");
    const titles = mine.body.data.listings.map((listing) => listing.title);
    expect(titles).toContain("Somebody else's tripod");
    expect(titles).not.toContain("My own tripod");

    // The exclusion is about who is ASKING, not about the listing — it is perfectly
    // visible to the other party and to a signed-out visitor.
    const theirs = await stranger.agent.get("/api/listings");
    expect(theirs.body.data.listings.map((l) => l.title)).toContain("My own tripod");
    expect((await browse()).body.data.listings).toHaveLength(2);
  });

  it("counts what it shows — the pager must not promise a row it withheld", async () => {
    const owner = await verifiedUser(app);
    const stranger = await verifiedUser(app);

    await publish(owner.agent, { title: "Mine one" });
    await publish(owner.agent, { title: "Mine two" });
    await publish(stranger.agent, { title: "Theirs" });

    // `total` comes from `count(*) OVER ()`, so it is computed by the same statement
    // as the page and cannot disagree with it — but only as long as the exclusion is
    // a WHERE condition. Filter the rows in JS afterwards and this is 3 with one row,
    // which renders a pager offering a second page that is empty.
    const mine = await owner.agent.get("/api/listings");
    expect(mine.body.data.total).toBe(1);
    expect(mine.body.data.listings).toHaveLength(1);

    expect((await browse()).body.data.total).toBe(3);
  });

  it("still applies alongside another filter", async () => {
    const owner = await verifiedUser(app);
    const stranger = await verifiedUser(app);

    await publish(owner.agent, { title: "Mine in Pune", city: "Pune" });
    await publish(stranger.agent, { title: "Theirs in Pune", city: "Pune" });

    const filtered = await owner.agent.get("/api/listings?city=Pune");
    expect(filtered.body.data.total).toBe(1);
    expect(filtered.body.data.listings[0].title).toBe("Theirs in Pune");
  });
});

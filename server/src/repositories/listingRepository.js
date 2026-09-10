/**
 * Listings and their photos. The only place SQL touching those tables lives.
 */

import { query } from "../config/db.js";

/**
 * The columns any caller may see.
 *
 * A named projection rather than `SELECT *`, for the same reason `users` has one: a
 * column added later cannot leak into a response by default.
 */
const LISTING_COLUMNS = `
  l.id, l.owner_id, l.category_id,
  l.title, l.description, l.condition, l.status,
  l.hourly_rate_paise, l.daily_rate_paise, l.monthly_rate_paise,
  l.deposit_paise,
  l.locality, l.city,
  l.min_duration_hours, l.max_duration_hours,
  l.notice_period_hours,
  l.fulfilment,
  l.published_at, l.created_at, l.updated_at
`;

/** Joined so a caller never needs a second query to render a category name. */
const WITH_CATEGORY = `${LISTING_COLUMNS}, c.slug AS category_slug, c.name AS category_name`;

/**
 * Every active category, in editorial order — FR-102.
 *
 * @returns {Promise<object[]>}
 * @throws {Error} On a database failure.
 */
export async function findActiveCategories() {
  const { rows } = await query(
    `SELECT id, slug, name FROM categories
      WHERE is_active = true
      ORDER BY sort_order, name`
  );
  return rows;
}

/**
 * Resolves a category by its slug.
 *
 * By SLUG, not id: the client sends "cameras", which is stable, readable in a URL and
 * meaningful in an error message. A uuid would be none of those.
 *
 * @param {string} slug
 * @returns {Promise<object | null>}
 * @throws {Error} On a database failure.
 */
export async function findCategoryBySlug(slug) {
  const { rows } = await query(
    `SELECT id, slug, name FROM categories WHERE slug = $1 AND is_active = true`,
    [slug]
  );
  return rows[0] ?? null;
}

/**
 * Creates a listing. Always a DRAFT — FR-100.
 *
 * `status` is not a parameter, deliberately. Publishing has conditions (FR-107) that
 * live in the service, and an insert that could set `PUBLISHED` directly would be a
 * route straight past them.
 *
 * @param {object} input
 * @returns {Promise<object>} The created listing.
 * @throws {Error} On a database failure.
 */
export async function insertListing({
  ownerId,
  categoryId,
  title,
  description,
  condition,
  hourlyRatePaise = null,
  dailyRatePaise = null,
  monthlyRatePaise = null,
  depositPaise = 0,
  locality = null,
  city = null,
  minDurationHours = null,
  maxDurationHours = null,
  fulfilment = "PICKUP",
  noticePeriodHours = null,
}) {
  const { rows } = await query(
    `INSERT INTO listings (
       owner_id, category_id, title, description, condition,
       hourly_rate_paise, daily_rate_paise, monthly_rate_paise, deposit_paise,
       locality, city, min_duration_hours, max_duration_hours, fulfilment,
       notice_period_hours
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     RETURNING ${LISTING_COLUMNS.replaceAll("l.", "")}`,
    [
      ownerId, categoryId, title, description, condition,
      hourlyRatePaise, dailyRatePaise, monthlyRatePaise, depositPaise,
      locality, city, minDurationHours, maxDurationHours, fulfilment,
      noticePeriodHours,
    ]
  );
  return rows[0];
}

/**
 * Finds one listing by id, whatever its status.
 *
 * Unfiltered on purpose: the CALLER decides what each status means to it. An owner may
 * see their own draft; a stranger may not. Filtering here would make the owner's view
 * impossible to express without a second query.
 *
 * @param {string} id Must already be shape-checked as a UUID.
 * @returns {Promise<object | null>}
 * @throws {Error} On a database failure.
 */
export async function findListingById(id) {
  const { rows } = await query(
    `SELECT ${WITH_CATEGORY}
       FROM listings l JOIN categories c ON c.id = l.category_id
      WHERE l.id = $1`,
    [id]
  );
  return rows[0] ?? null;
}

/**
 * Every listing belonging to one owner, drafts included — FR-115.
 *
 * @param {string} ownerId
 * @returns {Promise<object[]>}
 * @throws {Error} On a database failure.
 */
export async function findListingsByOwner(ownerId) {
  const { rows } = await query(
    `SELECT ${WITH_CATEGORY},
            (SELECT count(*)::int FROM listing_photos p WHERE p.listing_id = l.id) AS photo_count,
            (SELECT p.storage_id FROM listing_photos p
              WHERE p.listing_id = l.id ORDER BY p.sort_order LIMIT 1) AS cover_storage_id
       FROM listings l JOIN categories c ON c.id = l.category_id
      WHERE l.owner_id = $1
      ORDER BY l.created_at DESC`,
    [ownerId]
  );
  return rows;
}

/**
 * Updates the editable fields of a listing — FR-108.
 *
 * Every field is optional and `undefined` means "leave alone", which is what makes a
 * partial edit possible without the caller having to send the whole record back. The
 * `$n::boolean` flag per column is how that is expressed in one statement — COALESCE
 * cannot, because it treats an explicit `null` ("clear this") as "leave alone".
 *
 * `owner_id` and `status` are absent and unreachable: ownership never changes, and
 * publishing has its own function with its own conditions.
 *
 * @param {string} id
 * @param {object} fields
 * @returns {Promise<object | null>}
 * @throws {Error} On a database failure.
 */
export async function updateListing(id, fields) {
  const f = (key) => fields[key] !== undefined;

  const { rows } = await query(
    `UPDATE listings SET
       category_id        = CASE WHEN $2::boolean  THEN $3::uuid    ELSE category_id END,
       title              = CASE WHEN $4::boolean  THEN $5          ELSE title END,
       description        = CASE WHEN $6::boolean  THEN $7          ELSE description END,
       condition          = CASE WHEN $8::boolean  THEN $9          ELSE condition END,
       hourly_rate_paise  = CASE WHEN $10::boolean THEN $11::int    ELSE hourly_rate_paise END,
       daily_rate_paise   = CASE WHEN $12::boolean THEN $13::int    ELSE daily_rate_paise END,
       monthly_rate_paise = CASE WHEN $14::boolean THEN $15::int    ELSE monthly_rate_paise END,
       deposit_paise      = CASE WHEN $16::boolean THEN $17::int    ELSE deposit_paise END,
       locality           = CASE WHEN $18::boolean THEN $19         ELSE locality END,
       city               = CASE WHEN $20::boolean THEN $21         ELSE city END,
       min_duration_hours = CASE WHEN $22::boolean THEN $23::int    ELSE min_duration_hours END,
       max_duration_hours = CASE WHEN $24::boolean THEN $25::int    ELSE max_duration_hours END,
       fulfilment         = CASE WHEN $26::boolean THEN $27         ELSE fulfilment END,
       notice_period_hours = CASE WHEN $28::boolean THEN $29::int   ELSE notice_period_hours END,
       updated_at         = now()
     WHERE id = $1
     RETURNING ${LISTING_COLUMNS.replaceAll("l.", "")}`,
    [
      id,
      f("categoryId"), fields.categoryId ?? null,
      f("title"), fields.title ?? null,
      f("description"), fields.description ?? null,
      f("condition"), fields.condition ?? null,
      f("hourlyRatePaise"), fields.hourlyRatePaise ?? null,
      f("dailyRatePaise"), fields.dailyRatePaise ?? null,
      f("monthlyRatePaise"), fields.monthlyRatePaise ?? null,
      f("depositPaise"), fields.depositPaise ?? null,
      f("locality"), fields.locality ?? null,
      f("city"), fields.city ?? null,
      f("minDurationHours"), fields.minDurationHours ?? null,
      f("maxDurationHours"), fields.maxDurationHours ?? null,
      f("fulfilment"), fields.fulfilment ?? null,
      f("noticePeriodHours"), fields.noticePeriodHours ?? null,
    ]
  );
  return rows[0] ?? null;
}

/**
 * Moves a listing between DRAFT / PUBLISHED / UNPUBLISHED.
 *
 * `published_at` is stamped only the FIRST time and never cleared: it records when the
 * listing first became visible, which is a different question from whether it is
 * visible now — and `status` already answers that one.
 *
 * @param {string} id
 * @param {"DRAFT"|"PUBLISHED"|"UNPUBLISHED"} status
 * @returns {Promise<object | null>}
 * @throws {Error} On a database failure.
 */
export async function updateListingStatus(id, status) {
  const { rows } = await query(
    `UPDATE listings
        SET status       = $2,
            published_at = CASE
                             WHEN $2 = 'PUBLISHED' AND published_at IS NULL THEN now()
                             ELSE published_at
                           END,
            updated_at   = now()
      WHERE id = $1
      RETURNING ${LISTING_COLUMNS.replaceAll("l.", "")}`,
    [id, status]
  );
  return rows[0] ?? null;
}

/**
 * Deletes a listing. Its photo ROWS cascade; the remote assets do not.
 *
 * @param {string} id
 * @returns {Promise<boolean>}
 * @throws {Error} On a database failure.
 */
export async function deleteListing(id) {
  const { rowCount } = await query(`DELETE FROM listings WHERE id = $1`, [id]);
  return rowCount === 1;
}

/**
 * A listing's photos, cover first.
 *
 * @param {string} listingId
 * @returns {Promise<object[]>}
 * @throws {Error} On a database failure.
 */
export async function findPhotosForListing(listingId) {
  const { rows } = await query(
    `SELECT id, listing_id, storage_id, provider, width, height, bytes, mime_type, sort_order
       FROM listing_photos WHERE listing_id = $1 ORDER BY sort_order`,
    [listingId]
  );
  return rows;
}

/**
 * How many photos a listing already has. Used to enforce the cap before uploading
 * anything, so a rejected request never creates a remote asset.
 *
 * @param {string} listingId
 * @returns {Promise<number>}
 * @throws {Error} On a database failure.
 */
export async function countPhotos(listingId) {
  const { rows } = await query(
    `SELECT count(*)::int AS count FROM listing_photos WHERE listing_id = $1`,
    [listingId]
  );
  return rows[0].count;
}

/**
 * Inserts photo rows, appending after whatever is already there.
 *
 * ONE STATEMENT for the whole batch, not a loop of inserts. Two reasons: a partial
 * failure would leave some rows and some orphaned remote assets, and `sort_order` is
 * computed from the current maximum, which a loop would race against itself on.
 *
 * @param {string} listingId
 * @param {Array<{storageId: string, width: number, height: number, bytes: number, mimeType: string}>} photos
 * @returns {Promise<object[]>} The inserted rows.
 * @throws {Error} On a database failure.
 */
export async function insertPhotos(listingId, photos) {
  if (photos.length === 0) return [];

  const values = photos
    .map((_, i) => `($1, $${i * 5 + 2}, $${i * 5 + 3}, $${i * 5 + 4}, $${i * 5 + 5}, $${i * 5 + 6})`)
    .join(", ");

  const params = [listingId];
  for (const photo of photos) {
    params.push(photo.storageId, photo.width, photo.height, photo.bytes, photo.mimeType);
  }

  const { rows } = await query(
    `WITH next AS (
       SELECT coalesce(max(sort_order) + 1, 0) AS start FROM listing_photos WHERE listing_id = $1
     ),
     incoming (listing_id, storage_id, width, height, bytes, mime_type) AS (
       VALUES ${values}
     ),
     numbered AS (
       SELECT i.*, (SELECT start FROM next) + (row_number() OVER () - 1) AS position
         FROM incoming i
     )
     INSERT INTO listing_photos (listing_id, storage_id, width, height, bytes, mime_type, sort_order)
     SELECT listing_id::uuid, storage_id, width::int, height::int, bytes::int, mime_type, position::int
       FROM numbered
     RETURNING id, listing_id, storage_id, width, height, bytes, mime_type, sort_order`,
    params
  );
  return rows;
}

/**
 * Deletes one photo, returning its storage id so the caller can clean up remotely.
 *
 * Scoped by `listing_id` as well as `id`, so a photo can only ever be deleted through
 * the listing the caller was authorized against. Without it, knowing a photo's uuid
 * would be enough to delete it from somebody else's listing.
 *
 * @param {string} listingId
 * @param {string} photoId
 * @returns {Promise<string | null>} The storage id, or null if nothing matched.
 * @throws {Error} On a database failure.
 */
export async function deletePhoto(listingId, photoId) {
  const { rows } = await query(
    `DELETE FROM listing_photos WHERE id = $1 AND listing_id = $2 RETURNING storage_id`,
    [photoId, listingId]
  );
  return rows[0]?.storage_id ?? null;
}

/**
 * Rewrites the order of a listing's photos — FR-106.
 *
 * ONE STATEMENT, which is only possible because `uq_listing_photo_position` is
 * DEFERRABLE INITIALLY DEFERRED (migration 004). A permutation passes through states
 * where two rows share a position — swapping 0 and 1 must transiently have two of one
 * or the other — and a normal UNIQUE, checked per row as the statement runs, refuses
 * every reorder that is not a strict rotation.
 *
 * Deferred, the check happens at commit, so only the final arrangement is validated.
 *
 * @param {string} listingId
 * @param {string[]} photoIdsInOrder Every photo of the listing, in the wanted order.
 * @returns {Promise<number>} How many rows moved.
 * @throws {Error} On a database failure.
 */
export async function reorderPhotos(listingId, photoIdsInOrder) {
  const { rowCount } = await query(
    `UPDATE listing_photos p
        SET sort_order = ordered.position
       FROM (SELECT id, (ordinality - 1)::int AS position
               FROM unnest($2::uuid[]) WITH ORDINALITY AS t(id, ordinality)) AS ordered
      WHERE p.id = ordered.id AND p.listing_id = $1`,
    [listingId, photoIdsInOrder]
  );
  return rowCount;
}

/**
 * How many listings one page of browse returns when the caller does not say.
 *
 * 24 divides by 2, 3 and 4, so the grid has no orphan tile at any breakpoint.
 */
export const BROWSE_DEFAULT_LIMIT = 24;

/**
 * The most a caller may ask for in one page — FR-307.
 *
 * A cap, not a suggestion. Without it `?limit=100000` is a request for the whole
 * table, which is precisely the unbounded query pagination exists to remove.
 */
export const BROWSE_MAX_LIMIT = 48;

/** Which rate column each rental unit filters and sorts on. */
const RATE_COLUMN = {
  hourly: "hourly_rate_paise",
  daily: "daily_rate_paise",
  monthly: "monthly_rate_paise",
};

/**
 * Builds the WHERE clause and its parameters for a browse query.
 *
 * EXTRACTED SO THE PAGE AND ITS COUNT CANNOT DISAGREE. That is the whole reason this
 * is a function rather than inline SQL: a `total` computed from even slightly
 * different conditions than the rows is worse than no total, because the pager then
 * offers a page four that renders empty and nobody can see why.
 *
 * (In practice `findPublishedListings` goes further and takes the count from the same
 * statement — see there. This still exists because the conditions are fiddly enough to
 * be worth naming once.)
 *
 * @param {object} filters
 * @returns {{ clause: string, params: unknown[], rateColumn: string }}
 */
function buildBrowseWhere(filters) {
  const {
    categorySlug, city, q, unit = "daily", minPricePaise, maxPricePaise,
    availableFrom, availableTo,
  } = filters;
  const rateColumn = RATE_COLUMN[unit] ?? RATE_COLUMN.daily;

  // FR-309, and it is FIRST so it can never be lost among the optional conditions.
  // Drafts and unpublished listings must never appear in a browse result — a draft is
  // somebody's unfinished work and an unpublished listing was deliberately withdrawn.
  const conditions = ["l.status = 'PUBLISHED'"];
  const params = [];

  if (categorySlug) {
    params.push(categorySlug);
    conditions.push(`c.slug = $${params.length}`);
  }

  if (city) {
    params.push(city);
    // lower() on both sides, matching idx_listings_city. Comparing the raw column
    // would miss "pune" against a listing stored as "Pune".
    conditions.push(`lower(l.city) = lower($${params.length})`);
  }

  if (q) {
    // ILIKE with wrapping wildcards, which is what the trigram indexes from migration
    // 005 exist to serve. `%` and `_` in the term are escaped so a user typing "50%
    // off" searches for that text rather than matching everything.
    params.push(`%${q.replace(/[\%_]/g, (ch) => `\${ch}`)}%`);
    conditions.push(`(l.title ILIKE $${params.length} OR l.description ILIKE $${params.length})`);
  }

  // A price filter is PER UNIT (FR-302), and it excludes listings that have no rate
  // for that unit at all. That is the honest reading: "under ₹1000 a day" cannot
  // sensibly include something with only a monthly price, and silently keeping it
  // would make the filter look broken.
  if (minPricePaise != null) {
    params.push(minPricePaise);
    conditions.push(`l.${rateColumn} >= $${params.length}`);
  }

  if (maxPricePaise != null) {
    params.push(maxPricePaise);
    conditions.push(`l.${rateColumn} <= $${params.length}`);
  }

  /**
   * FR-303 — free between two dates.
   *
   * A NOT EXISTS over the same union availability is built from, rather than a join:
   * a join would multiply a listing by its number of clashing periods and then need a
   * DISTINCT, which breaks the `count(*) OVER ()` the pagination depends on.
   *
   * `[)` bounds again, matching the constraint and every other overlap test in the
   * product. Three notions of "overlap" would be two too many.
   */
  if (availableFrom && availableTo) {
    params.push(availableFrom, availableTo);
    const from = `$${params.length - 1}::timestamptz`;
    const to = `$${params.length}::timestamptz`;

    conditions.push(`NOT EXISTS (
      SELECT 1 FROM bookings bk
       WHERE bk.listing_id = l.id
         AND bk.status IN ('ACCEPTED', 'ACTIVE')
         AND bk.period && tstzrange(${from}, ${to}, '[)')
    )`);
    conditions.push(`NOT EXISTS (
      SELECT 1 FROM availability_blocks ab
       WHERE ab.listing_id = l.id
         AND ab.period && tstzrange(${from}, ${to}, '[)')
    )`);

    // The notice period too: a listing needing a day's notice is not "available
    // tomorrow morning", and offering it in that result would produce a refusal at
    // the last step of a booking.
    conditions.push(
      `(l.notice_period_hours IS NULL OR ${from} >= now() + (l.notice_period_hours || ' hours')::interval)`
    );
  }

  return { clause: conditions.join(" AND "), params, rateColumn };
}

/** Maps a sort key to SQL. Never interpolates caller input. */
function buildBrowseOrder(sort, rateColumn) {
  switch (sort) {
    case "price_asc":
      // NULLS LAST so listings with no rate for the chosen unit sink to the bottom
      // rather than heading the results — Postgres sorts NULLs first on ASC by default,
      // which would put every priceless listing at the top of "cheapest first".
      return `l.${rateColumn} ASC NULLS LAST, l.created_at DESC`;
    case "price_desc":
      return `l.${rateColumn} DESC NULLS LAST, l.created_at DESC`;
    default:
      return "l.created_at DESC";
  }
}

/**
 * One page of published listings, plus the total that page came from — FR-300 to
 * FR-307, FR-309.
 *
 * THE TOTAL COMES FROM THE SAME STATEMENT AS THE ROWS, via `count(*) OVER ()`. A
 * window function is evaluated after WHERE and before LIMIT, so it counts every
 * matching row while the query returns only this page.
 *
 * That is a deliberate step beyond "use the same WHERE in both queries". Sharing a
 * clause relies on discipline; sharing a *statement* makes disagreement impossible.
 * The cost is that the count is repeated on every returned row, which is nothing next
 * to a pager that offers a page with no rows on it.
 *
 * `created_at DESC` is appended to every ordering as a tiebreaker. Without it two
 * listings at the same price have no defined order, so the same row can appear on both
 * page one and page two — the classic unstable-pagination bug, and one that only shows
 * up once there is enough data to paginate.
 *
 * @param {object} input
 * @param {object} [input.filters={}] categorySlug, city, q, unit, min/maxPricePaise.
 * @param {string} [input.sort] `newest` (default), `price_asc`, `price_desc`.
 * @param {number} [input.limit]
 * @param {number} [input.offset=0]
 * @returns {Promise<{ listings: object[], total: number }>}
 * @throws {Error} On a database failure.
 */
export async function findPublishedListings({ filters = {}, sort, limit, offset = 0 } = {}) {
  const { clause, params, rateColumn } = buildBrowseWhere(filters);
  const order = buildBrowseOrder(sort, rateColumn);

  const pageSize = Math.min(limit ?? BROWSE_DEFAULT_LIMIT, BROWSE_MAX_LIMIT);
  params.push(pageSize, offset);

  const { rows } = await query(
    `SELECT ${WITH_CATEGORY},
            count(*) OVER () AS total_count,
            (SELECT p.storage_id FROM listing_photos p
              WHERE p.listing_id = l.id ORDER BY p.sort_order LIMIT 1) AS cover_storage_id
       FROM listings l JOIN categories c ON c.id = l.category_id
      WHERE ${clause}
      ORDER BY ${order}
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  return {
    // Zero rows means zero matches — there is no row to read a count off, and that is
    // the correct answer anyway.
    total: rows.length > 0 ? Number(rows[0].total_count) : 0,
    listings: rows.map(({ total_count, ...listing }) => listing),
  };
}

/**
 * The distinct cities that currently have something published.
 *
 * Derived rather than stored: a fixed city list would go stale in both directions,
 * offering places with nothing to rent and omitting the one somebody just listed in.
 *
 * @returns {Promise<string[]>}
 * @throws {Error} On a database failure.
 */
export async function findBrowseCities() {
  const { rows } = await query(
    `SELECT DISTINCT city FROM listings
      WHERE status = 'PUBLISHED' AND city IS NOT NULL
      ORDER BY city`
  );
  return rows.map((row) => row.city);
}

/**
 * Adds a blackout — FR-200.
 *
 * @param {object} input
 * @returns {Promise<object>}
 * @throws {Error} `23P01` if it overlaps another blackout (the EXCLUDE constraint),
 *         `23514` if it covers a confirmed booking (the trigger). The caller must
 *         translate both — neither is an application fault.
 */
export async function insertBlackout({ listingId, startsAt, endsAt, reason = null }) {
  const { rows } = await query(
    `INSERT INTO availability_blocks (listing_id, starts_at, ends_at, reason)
     VALUES ($1,$2,$3,$4)
     RETURNING id, listing_id, starts_at, ends_at, reason, created_at`,
    [listingId, startsAt, endsAt, reason]
  );
  return rows[0];
}

/**
 * A listing's blackouts, optionally windowed.
 *
 * @param {string} listingId
 * @param {object} [window]
 * @returns {Promise<object[]>}
 */
export async function findBlackouts(listingId, { from = null, to = null } = {}) {
  const { rows } = await query(
    `SELECT id, listing_id, starts_at, ends_at, reason
       FROM availability_blocks
      WHERE listing_id = $1
        AND ($2::timestamptz IS NULL OR ends_at > $2)
        AND ($3::timestamptz IS NULL OR starts_at < $3)
      ORDER BY starts_at`,
    [listingId, from, to]
  );
  return rows;
}

/**
 * Removes a blackout, scoped by listing.
 *
 * Scoped by `listing_id` as well as `id` so knowing a blackout's uuid is not enough to
 * delete it through a listing the caller does not own — the same rule as photos.
 *
 * @param {string} listingId
 * @param {string} blockId
 * @returns {Promise<boolean>}
 */
export async function deleteBlackout(listingId, blockId) {
  const { rowCount } = await query(
    `DELETE FROM availability_blocks WHERE id = $1 AND listing_id = $2`,
    [blockId, listingId]
  );
  return rowCount === 1;
}

/**
 * Every period a listing is unavailable — FR-201 and FR-205, in one answer.
 *
 * A UNION of two tables, and it has to be. A renter looking at a calendar does not
 * care whether a Tuesday is taken because somebody booked it or because the owner
 * blocked it; they care that it is taken. Returning two lists and asking the client to
 * merge them would put that judgement in three places (web, any future app, and the
 * browse filter) and let them disagree.
 *
 * `kind` is returned anyway, because the OWNER's calendar does need the distinction —
 * one of the two is theirs to change. FR-205's public view drops it.
 *
 * @param {string} listingId
 * @param {object} [window]
 * @returns {Promise<Array<{ starts_at: Date, ends_at: Date, kind: "BOOKING"|"BLACKOUT" }>>}
 */
export async function findUnavailablePeriods(listingId, { from = null, to = null } = {}) {
  const { rows } = await query(
    `SELECT starts_at, ends_at, kind FROM (
       SELECT starts_at, ends_at, 'BOOKING' AS kind
         FROM bookings
        WHERE listing_id = $1 AND status IN ('ACCEPTED', 'ACTIVE')
       UNION ALL
       SELECT starts_at, ends_at, 'BLACKOUT' AS kind
         FROM availability_blocks
        WHERE listing_id = $1
     ) periods
      WHERE ($2::timestamptz IS NULL OR ends_at > $2)
        AND ($3::timestamptz IS NULL OR starts_at < $3)
      ORDER BY starts_at`,
    [listingId, from, to]
  );
  return rows;
}

/**
 * Whether a range collides with a blackout — the other half of FR-503.
 *
 * Separate from `findOverlappingBooking` rather than folded into it, because the two
 * produce different refusals: "those dates are already booked" versus "the owner has
 * marked those dates unavailable". Merging them would force one vague message.
 *
 * @param {string} listingId
 * @param {Date|string} startsAt
 * @param {Date|string} endsAt
 * @returns {Promise<object | null>}
 */
export async function findOverlappingBlackout(listingId, startsAt, endsAt) {
  const { rows } = await query(
    `SELECT id, starts_at, ends_at
       FROM availability_blocks
      WHERE listing_id = $1
        AND period && tstzrange($2::timestamptz, $3::timestamptz, '[)')
      LIMIT 1`,
    [listingId, startsAt, endsAt]
  );
  return rows[0] ?? null;
}

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
}) {
  const { rows } = await query(
    `INSERT INTO listings (
       owner_id, category_id, title, description, condition,
       hourly_rate_paise, daily_rate_paise, monthly_rate_paise, deposit_paise,
       locality, city, min_duration_hours, max_duration_hours, fulfilment
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING ${LISTING_COLUMNS.replaceAll("l.", "")}`,
    [
      ownerId, categoryId, title, description, condition,
      hourlyRatePaise, dailyRatePaise, monthlyRatePaise, depositPaise,
      locality, city, minDurationHours, maxDurationHours, fulfilment,
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

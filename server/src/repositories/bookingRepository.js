/**
 * Bookings and their event trail. The only place SQL touching those tables lives.
 */

import { query } from "../config/db.js";
import { DATES_HELD_STATUSES } from "../services/bookingStateMachine.js";

/**
 * The columns any caller may see, with the listing and the parties joined on.
 *
 * `owner_id` comes from the listing rather than being stored on the booking. Ownership
 * never changes (there is no transfer path), so denormalising would be safe — and
 * still wrong: one fact in two places is one that can eventually disagree with itself,
 * for the sake of a join Postgres does trivially.
 */
const BOOKING_COLUMNS = `
  b.id, b.listing_id, b.renter_id,
  l.owner_id,
  b.starts_at, b.ends_at, b.status,
  b.rent_paise, b.tax_paise, b.deposit_paise, b.commission_paise,
  b.renter_total_paise, b.owner_payout_paise, b.quote_lines,
  b.renter_message,
  b.created_at, b.updated_at,
  l.title AS listing_title,
  l.city  AS listing_city,
  (SELECT p.storage_id FROM listing_photos p
    WHERE p.listing_id = l.id ORDER BY p.sort_order LIMIT 1) AS cover_storage_id
`;

const FROM_BOOKINGS = `FROM bookings b JOIN listings l ON l.id = b.listing_id`;

/**
 * Creates a booking in REQUESTED, with its price frozen in.
 *
 * Every figure is written from the quote the caller was shown, never recomputed here —
 * that is what makes FR-112 hold when the owner edits their rate card tomorrow.
 *
 * @param {object} input
 * @returns {Promise<object>} The created booking's id and status.
 * @throws {Error} With `code === "23P01"` if the exclusion constraint refuses it. Only
 *         reachable on a status that holds dates, so not on this path — documented
 *         because the same error is very much reachable from `updateStatus`.
 */
export async function insertBooking({
  listingId,
  renterId,
  startsAt,
  endsAt,
  quote,
  renterMessage = null,
}) {
  const { rows } = await query(
    `INSERT INTO bookings (
       listing_id, renter_id, starts_at, ends_at,
       rent_paise, tax_paise, deposit_paise, commission_paise,
       renter_total_paise, owner_payout_paise, quote_lines, renter_message
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)
     RETURNING id, status, created_at`,
    [
      listingId,
      renterId,
      startsAt,
      endsAt,
      quote.rentPaise,
      quote.taxPaise,
      quote.depositPaise,
      quote.commissionPaise,
      quote.renterTotalPaise,
      quote.ownerPayoutPaise,
      JSON.stringify(quote.lines),
      renterMessage,
    ]
  );
  return rows[0];
}

/**
 * Finds one booking, with its listing and owner.
 *
 * @param {string} id Must already be shape-checked as a UUID.
 * @returns {Promise<object | null>}
 * @throws {Error} On a database failure.
 */
export async function findBookingById(id) {
  const { rows } = await query(`SELECT ${BOOKING_COLUMNS} ${FROM_BOOKINGS} WHERE b.id = $1`, [id]);
  return rows[0] ?? null;
}

/**
 * Moves a booking to a new status — the ONLY function that writes `status`.
 *
 * `AND status = $3` makes this the atomic claim. Two people pressing Accept at the
 * same moment both read REQUESTED; only one updates a row, and the loser gets zero
 * rather than a second transition applied on top of the first.
 *
 * @param {string} id
 * @param {string} toStatus
 * @param {string} fromStatus The status the caller believes it is in.
 * @returns {Promise<object | null>} The updated booking, or null if it had moved on.
 * @throws {Error} With `code === "23P01"` when the exclusion constraint refuses — the
 *         caller MUST handle this. It is how a second accept for the same dates is
 *         stopped, and it is not an application bug.
 */
export async function updateBookingStatus(id, toStatus, fromStatus) {
  const { rows } = await query(
    `UPDATE bookings SET status = $2, updated_at = now()
      WHERE id = $1 AND status = $3
      RETURNING id`,
    [id, toStatus, fromStatus]
  );
  if (rows.length === 0) return null;
  return findBookingById(id);
}

/**
 * Appends to the trail — FR-511.
 *
 * There is no update or delete counterpart, and there cannot be: migration 006 puts a
 * trigger on the table that refuses both.
 *
 * @param {object} input
 * @returns {Promise<object>}
 * @throws {Error} On a database failure.
 */
export async function insertBookingEvent({ bookingId, actorId = null, fromStatus = null, toStatus, comment = null }) {
  const { rows } = await query(
    `INSERT INTO booking_events (booking_id, actor_id, from_status, to_status, comment)
     VALUES ($1,$2,$3,$4,$5)
     RETURNING id, actor_id, from_status, to_status, comment, created_at`,
    [bookingId, actorId, fromStatus, toStatus, comment]
  );
  return rows[0];
}

/**
 * A booking's trail, oldest first, with each actor's name.
 *
 * @param {string} bookingId
 * @returns {Promise<object[]>}
 * @throws {Error} On a database failure.
 */
export async function findBookingEvents(bookingId) {
  const { rows } = await query(
    `SELECT e.id, e.from_status, e.to_status, e.comment, e.created_at,
            e.actor_id, u.name AS actor_name
       FROM booking_events e
       LEFT JOIN users u ON u.id = e.actor_id
      WHERE e.booking_id = $1
      ORDER BY e.created_at, e.id`,
    [bookingId]
  );
  return rows;
}

/**
 * Bookings where the caller is the renter — FR-513.
 *
 * @param {string} renterId
 * @returns {Promise<object[]>}
 */
export async function findBookingsAsRenter(renterId) {
  const { rows } = await query(
    `SELECT ${BOOKING_COLUMNS} ${FROM_BOOKINGS}
      WHERE b.renter_id = $1 ORDER BY b.created_at DESC`,
    [renterId]
  );
  return rows;
}

/**
 * Bookings on the caller's own listings — FR-513, from the other side.
 *
 * @param {string} ownerId
 * @returns {Promise<object[]>}
 */
export async function findBookingsAsOwner(ownerId) {
  const { rows } = await query(
    `SELECT ${BOOKING_COLUMNS} ${FROM_BOOKINGS}
      WHERE l.owner_id = $1 ORDER BY b.created_at DESC`,
    [ownerId]
  );
  return rows;
}

/**
 * Whether a date range collides with something already holding those dates.
 *
 * A PRE-CHECK FOR A FRIENDLY MESSAGE, NOT THE GUARD. The guard is the exclusion
 * constraint in migration 006, which is the only thing that can answer this correctly
 * under concurrency — between this query and any insert there is a window, and that
 * window is exactly where a double booking would be created.
 *
 * This exists so the ordinary, uncontended case gets "those dates are already taken"
 * instead of a database error code. Deleting it would cost a good error message;
 * relying on it instead of the constraint would cost a double booking.
 *
 * `&&` and the `[)` bounds mirror the constraint exactly, so the two cannot disagree
 * about what "overlap" means.
 *
 * @param {string} listingId
 * @param {Date|string} startsAt
 * @param {Date|string} endsAt
 * @param {string} [excludeBookingId] Ignore one booking — used when accepting, so a
 *        booking is not treated as clashing with itself.
 * @returns {Promise<object | null>} The colliding booking's dates, or null.
 */
export async function findOverlappingBooking(listingId, startsAt, endsAt, excludeBookingId = null) {
  const { rows } = await query(
    `SELECT id, starts_at, ends_at, status
       FROM bookings
      WHERE listing_id = $1
        -- The list comes from the state machine, never written out here — see
        -- DATES_HELD_STATUSES for what four hand-written copies of it cost.
        AND status = ANY($5::text[])
        AND period && tstzrange($2::timestamptz, $3::timestamptz, '[)')
        AND ($4::uuid IS NULL OR id <> $4::uuid)
      LIMIT 1`,
    [listingId, startsAt, endsAt, excludeBookingId, DATES_HELD_STATUSES]
  );
  return rows[0] ?? null;
}

/**
 * REQUESTED bookings older than a cutoff — the expiry sweep's input (FR-508).
 *
 * @param {Date} olderThan
 * @returns {Promise<object[]>}
 */
export async function findExpiredRequests(olderThan) {
  const { rows } = await query(
    `SELECT ${BOOKING_COLUMNS} ${FROM_BOOKINGS}
      WHERE b.status = 'REQUESTED' AND b.created_at < $1`,
    [olderThan]
  );
  return rows;
}

/**
 * Bookings stuck waiting on somebody's confirmation — FR-708's input.
 *
 * `updated_at`, not `created_at`, and the difference is the whole query: these have
 * been through several transitions, so what matters is how long they have sat in
 * THIS state, not how old the booking is. A month-long rental would otherwise be
 * swept the instant it was handed over.
 *
 * Served by `idx_bookings_awaiting_confirmation` (migration 008), which is partial on
 * exactly these two statuses.
 *
 * @param {string} status `HANDED_OVER` or `RETURNED`.
 * @param {Date} olderThan
 * @returns {Promise<object[]>}
 */
export async function findAwaitingConfirmation(status, olderThan) {
  const { rows } = await query(
    `SELECT ${BOOKING_COLUMNS} ${FROM_BOOKINGS}
      WHERE b.status = $1 AND b.updated_at < $2`,
    [status, olderThan]
  );
  return rows;
}

/**
 * Records condition photos for one phase of a booking — FR-702.
 *
 * One statement for the batch rather than one per file, so a partial insert is not a
 * thing that can happen: either every photo of this upload is recorded or none is.
 *
 * @param {string} bookingId
 * @param {string} phase `HANDOVER` or `RETURN`.
 * @param {string} uploadedBy
 * @param {Array<{storageId: string, width: number, height: number, bytes: number, mimeType: string}>} photos
 * @param {string|null} note The uploader's own words about what the photos show.
 * @returns {Promise<object[]>} The created rows.
 * @throws {Error} On a database failure.
 */
export async function insertBookingPhotos(bookingId, phase, uploadedBy, photos, note = null) {
  const { rows } = await query(
    `INSERT INTO booking_photos
       (booking_id, phase, uploaded_by, storage_id, width, height, bytes, mime_type, note)
     SELECT $1, $2, $3, p.storage_id, p.width, p.height, p.bytes, p.mime_type, $4
       FROM jsonb_to_recordset($5::jsonb)
            AS p(storage_id text, width int, height int, bytes int, mime_type text)
     RETURNING id, booking_id, phase, uploaded_by, storage_id, width, height, bytes,
               mime_type, note, created_at`,
    [
      bookingId,
      phase,
      uploadedBy,
      note,
      JSON.stringify(
        photos.map((photo) => ({
          storage_id: photo.storageId,
          width: photo.width,
          height: photo.height,
          bytes: photo.bytes,
          mime_type: photo.mimeType,
        }))
      ),
    ]
  );
  return rows;
}

/**
 * Every condition photo on a booking, oldest first, with who took it.
 *
 * The uploader's NAME is joined in because the whole point of the record is who said
 * what about the item's condition — an id would make the client fetch users to find
 * out. `LEFT JOIN`: `uploaded_by` is `ON DELETE SET NULL`, so a deleted account
 * leaves the evidence with no attribution rather than removing it.
 *
 * @param {string} bookingId
 * @returns {Promise<object[]>}
 * @throws {Error} On a database failure.
 */
export async function findBookingPhotos(bookingId) {
  const { rows } = await query(
    `SELECT p.id, p.phase, p.uploaded_by, p.storage_id, p.width, p.height,
            p.mime_type, p.note, p.created_at, u.name AS uploaded_by_name
       FROM booking_photos p
       LEFT JOIN users u ON u.id = p.uploaded_by
      WHERE p.booking_id = $1
      ORDER BY p.created_at`,
    [bookingId]
  );
  return rows;
}

/**
 * One photo, scoped by its booking.
 *
 * SCOPED BY BOOKING AS WELL AS ID, so knowing a photo's uuid is not enough to fetch
 * it through a booking the caller is party to — the same rule as listing photos, and
 * it matters more here because the caller's right to see anything at all is derived
 * from the booking.
 *
 * @param {string} bookingId
 * @param {string} photoId
 * @returns {Promise<object | null>}
 * @throws {Error} On a database failure.
 */
export async function findBookingPhotoById(bookingId, photoId) {
  const { rows } = await query(
    `SELECT id, booking_id, storage_id, mime_type
       FROM booking_photos
      WHERE booking_id = $1 AND id = $2`,
    [bookingId, photoId]
  );
  return rows[0] ?? null;
}

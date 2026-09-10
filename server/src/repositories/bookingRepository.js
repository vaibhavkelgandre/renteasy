/**
 * Bookings and their event trail. The only place SQL touching those tables lives.
 */

import { query } from "../config/db.js";

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
        AND status IN ('ACCEPTED', 'ACTIVE')
        AND period && tstzrange($2::timestamptz, $3::timestamptz, '[)')
        AND ($4::uuid IS NULL OR id <> $4::uuid)
      LIMIT 1`,
    [listingId, startsAt, endsAt, excludeBookingId]
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

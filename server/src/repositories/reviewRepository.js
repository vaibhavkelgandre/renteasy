/**
 * Database access for reviews — FR-800 to FR-808.
 *
 * Nothing here decides who may write or read one. That is `reviewService`, which
 * owns the blind period (FR-804) and the edit window (FR-805).
 */

import { query } from "../config/db.js";

/**
 * The author's name is joined rather than stored, so a rename is not a data
 * migration. `author_id` comes too, so a caller can tell "mine" from "theirs"
 * without comparing names.
 */
const REVIEW_COLUMNS = `
  r.id, r.booking_id, r.author_id, r.subject_id, r.direction,
  r.rating, r.body, r.published_at, r.reply_body, r.reply_at,
  r.created_at, r.updated_at,
  author.name AS author_name,
  l.title      AS listing_title,
  l.id         AS listing_id
`;

const FROM_REVIEWS = `
  FROM reviews r
  LEFT JOIN users author ON author.id = r.author_id
  JOIN bookings b        ON b.id = r.booking_id
  JOIN listings l        ON l.id = b.listing_id
`;

/**
 * Writes a review.
 *
 * @param {object} input
 * @param {string} input.bookingId
 * @param {string} input.authorId
 * @param {string} input.subjectId
 * @param {"OF_OWNER"|"OF_RENTER"} input.direction
 * @param {number} input.rating
 * @param {string|null} [input.body]
 * @returns {Promise<object>}
 * @throws {Error} 23505 when this author already reviewed this booking.
 */
export async function insertReview({ bookingId, authorId, subjectId, direction, rating, body = null }) {
  const { rows } = await query(
    `WITH inserted AS (
       INSERT INTO reviews (booking_id, author_id, subject_id, direction, rating, body)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *
     )
     SELECT ${REVIEW_COLUMNS}
       FROM inserted r
       LEFT JOIN users author ON author.id = r.author_id
       JOIN bookings b        ON b.id = r.booking_id
       JOIN listings l        ON l.id = b.listing_id`,
    [bookingId, authorId, subjectId, direction, rating, body]
  );
  return rows[0];
}

/**
 * Both reviews of one booking, whatever their state.
 *
 * The service decides which of them the caller may actually read — this returns
 * everything so that "have both been written?" can be answered without a second
 * query.
 *
 * @param {string} bookingId
 * @returns {Promise<object[]>}
 * @throws {Error} On a database failure.
 */
export async function findReviewsForBooking(bookingId) {
  const { rows } = await query(
    `SELECT ${REVIEW_COLUMNS} ${FROM_REVIEWS} WHERE r.booking_id = $1 ORDER BY r.created_at`,
    [bookingId]
  );
  return rows;
}

/**
 * One review by id.
 *
 * @param {string} id
 * @returns {Promise<object | null>}
 * @throws {Error} On a database failure.
 */
export async function findReviewById(id) {
  const { rows } = await query(`SELECT ${REVIEW_COLUMNS} ${FROM_REVIEWS} WHERE r.id = $1`, [id]);
  return rows[0] ?? null;
}

/**
 * Published reviews about one person, newest first — FR-807.
 *
 * PUBLISHED ONLY, and the filter is here rather than in the service on purpose: a
 * public endpoint reading this must not be able to forget it.
 *
 * @param {string} subjectId
 * @param {object} [filter]
 * @param {"OF_OWNER"|"OF_RENTER"} [filter.direction] Both when absent.
 * @param {number} [filter.limit=20]
 * @param {number} [filter.offset=0]
 * @returns {Promise<{ reviews: object[], total: number }>}
 * @throws {Error} On a database failure.
 */
export async function findReviewsAbout(subjectId, { direction = null, limit = 20, offset = 0 } = {}) {
  const { rows } = await query(
    `SELECT ${REVIEW_COLUMNS}, count(*) OVER () AS total_count
     ${FROM_REVIEWS}
      WHERE r.subject_id = $1
        AND r.published_at IS NOT NULL
        AND ($2::text IS NULL OR r.direction = $2)
      ORDER BY r.created_at DESC
      LIMIT $3 OFFSET $4`,
    [subjectId, direction, limit, offset]
  );

  return {
    reviews: rows.map(({ total_count, ...row }) => row),
    total: rows.length > 0 ? Number(rows[0].total_count) : 0,
  };
}

/**
 * Somebody's rating, split by which hat they were wearing — FR-806, FR-033.
 *
 * TWO NUMBERS, NEVER ONE. Being good to lend to says very little about being good
 * to lend TO, and a blended average hides exactly the thing somebody is trying to
 * find out.
 *
 * DERIVED, NOT STORED. The project's habit — `count(*) OVER ()`, ledger-summed
 * balances — is that a number you can compute is a number that cannot drift. At
 * this size the aggregate is trivial; the day it is not, the fix is a denormalised
 * column maintained by the publishing sweep, not a different shape here.
 *
 * @param {string} userId
 * @returns {Promise<{ asOwner: {average: number|null, count: number}, asRenter: {...} }>}
 * @throws {Error} On a database failure.
 */
export async function findRatingFor(userId) {
  const { rows } = await query(
    `SELECT direction,
            round(avg(rating)::numeric, 2)::float AS average,
            count(*)::int AS count
       FROM reviews
      WHERE subject_id = $1 AND published_at IS NOT NULL
      GROUP BY direction`,
    [userId]
  );

  const of = (direction) => {
    const row = rows.find((r) => r.direction === direction);
    // Null rather than zero for "nobody has rated them". Zero is a rating somebody
    // could in principle have earned; null says the question has no answer yet.
    return { average: row ? row.average : null, count: row ? row.count : 0 };
  };

  return { asOwner: of("OF_OWNER"), asRenter: of("OF_RENTER") };
}

/**
 * A listing's rating — FR-806's second half.
 *
 * The average of what RENTERS said about its owner, for bookings of this listing.
 * There is no separate "review of a listing" and there should not be: a review is
 * of a person (FR-800), and inventing a second kind would let the two disagree
 * about the same rental.
 *
 * @param {string[]} listingIds
 * @returns {Promise<Record<string, {average: number|null, count: number}>>}
 * @throws {Error} On a database failure.
 */
export async function findRatingsForListings(listingIds) {
  if (listingIds.length === 0) return {};

  const { rows } = await query(
    `SELECT b.listing_id,
            round(avg(r.rating)::numeric, 2)::float AS average,
            count(*)::int AS count
       FROM reviews r
       JOIN bookings b ON b.id = r.booking_id
      WHERE b.listing_id = ANY($1::uuid[])
        AND r.direction = 'OF_OWNER'
        AND r.published_at IS NOT NULL
      GROUP BY b.listing_id`,
    [listingIds]
  );

  return Object.fromEntries(
    rows.map((row) => [row.listing_id, { average: row.average, count: row.count }])
  );
}

/**
 * Edits a review — FR-805.
 *
 * The WHERE carries the whole rule, so the window cannot be lost between a check
 * and a write: the caller must be the author, and the review must still be
 * unpublished. The service adds the 48-hour test, which needs a configurable
 * constant rather than a literal buried in SQL.
 *
 * @param {string} id
 * @param {string} authorId
 * @param {object} fields
 * @returns {Promise<object | null>} Null when the rule refused it.
 * @throws {Error} On a database failure.
 */
export async function updateReview(id, authorId, { rating, body }) {
  const { rows } = await query(
    `UPDATE reviews
        SET rating = COALESCE($3, rating),
            body = $4,
            updated_at = now()
      WHERE id = $1
        AND author_id = $2
        AND published_at IS NULL
      RETURNING id`,
    [id, authorId, rating ?? null, body ?? null]
  );
  return rows[0] ?? null;
}

/**
 * Adds the subject's single public reply — FR-808.
 *
 * `reply_at IS NULL` makes it one-shot: a second attempt matches no row rather than
 * overwriting the first, so a reply cannot be quietly rewritten later.
 *
 * @param {string} id
 * @param {string} subjectId
 * @param {string} body
 * @returns {Promise<object | null>}
 * @throws {Error} On a database failure.
 */
export async function insertReply(id, subjectId, body) {
  const { rows } = await query(
    `UPDATE reviews
        SET reply_body = $3, reply_at = now(), updated_at = now()
      WHERE id = $1
        AND subject_id = $2
        AND published_at IS NOT NULL
        AND reply_at IS NULL
      RETURNING id`,
    [id, subjectId, body]
  );
  return rows[0] ?? null;
}

/**
 * Publishes every review of one booking — FR-804, when both sides have written.
 *
 * @param {string} bookingId
 * @returns {Promise<number>} How many became visible.
 * @throws {Error} On a database failure.
 */
export async function publishReviewsForBooking(bookingId) {
  const { rowCount } = await query(
    `UPDATE reviews SET published_at = now(), updated_at = now()
      WHERE booking_id = $1 AND published_at IS NULL`,
    [bookingId]
  );
  return rowCount;
}

/**
 * Reviews whose blind period has run out — the sweep's input (FR-804).
 *
 * Measured from the review's own `created_at`, NOT from the booking's end. A review
 * written on day thirteen would otherwise publish the next day while one written on
 * day one waited a fortnight, which makes the window a lottery rather than a rule.
 *
 * @param {Date} writtenBefore
 * @returns {Promise<object[]>} `{ id, booking_id, author_id, subject_id }`
 * @throws {Error} On a database failure.
 */
export async function findReviewsPastBlindPeriod(writtenBefore) {
  const { rows } = await query(
    `SELECT id, booking_id, author_id, subject_id
       FROM reviews
      WHERE published_at IS NULL AND created_at < $1`,
    [writtenBefore]
  );
  return rows;
}

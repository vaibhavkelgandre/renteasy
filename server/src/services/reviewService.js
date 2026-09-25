/**
 * Two-way reviews — FR-800 to FR-808.
 *
 * THE FEATURE TURNS ON FR-804: neither review is visible until both are written, or
 * until the window closes. Without it the second review is a REPLY to the first —
 * you read that they called you difficult, and you mark them down for it — and
 * neither number then measures the rental.
 *
 * Everything else here is downstream of keeping that true.
 */

import {
  insertReview,
  findReviewsForBooking,
  findReviewById,
  findReviewsAbout,
  findRatingFor,
  updateReview,
  insertReply,
  publishReviewsForBooking,
  findReviewsPastBlindPeriod,
} from "../repositories/reviewRepository.js";
import { loadBookingForParty } from "./bookingAccess.js";
import { roleInBooking } from "./bookingStateMachine.js";
import { notifyReviewPublished } from "./notificationService.js";
import { badRequest, conflict, forbidden, notFound } from "../utils/errors.js";

/**
 * How long a review stays blind when the other party never writes one.
 *
 * Long enough that somebody who was away still gets their say, short enough that a
 * rating is not months stale by the time it appears. Airbnb settled on fourteen
 * days for the same trade and it is a reasonable place to stand.
 */
export const REVIEW_WINDOW_DAYS = 14;

/**
 * How long an author may change their mind — FR-805.
 *
 * ⚠️ OR UNTIL IT IS PUBLISHED, WHICHEVER COMES FIRST, and that qualifier is not in
 * the requirement. FR-805 says "editable for 48 hours" and FR-804 says "blind until
 * both submit"; read independently they contradict each other. If the other party
 * writes theirs an hour after yours, both publish — and a 48-hour edit window would
 * then let you rewrite yours having READ theirs, which is exactly the retaliation
 * FR-804 exists to prevent.
 *
 * So publication closes the window early. The cost is real and accepted: two people
 * who both review promptly get no edit window at all. That is the honest reading —
 * once you can see theirs, you can no longer change yours in response.
 */
export const REVIEW_EDIT_HOURS = 48;

/**
 * Asserts the booking can be reviewed at all — FR-801 — AND that FR-804's blind
 * guarantee still holds for a NEW submission.
 *
 * THE GAP THIS CLOSES: the guarantee is "neither review is visible until both are
 * written, or until the window closes" — but "the window closes" was only ever
 * enforced going forward (sweepBlindReviews publishes a lone review after
 * REVIEW_WINDOW_DAYS). Nothing stopped the OTHER party from writing afterwards, once
 * they could see what had already been published about them — at which point their
 * review is not blind at all, it is a reply, which is exactly the retaliation FR-804
 * exists to prevent (see this file's header comment).
 *
 * The rule: once ANY review on this booking is published, nobody who has NOT yet
 * reviewed may write one. Someone who has already reviewed is left to
 * `insertReview`'s own `uq_review_per_author_per_booking` — this must not preempt
 * that with the wrong message, because "both wrote promptly, both published
 * together, the first one clicks submit again by mistake" is not a closed window at
 * all, it is an ordinary duplicate, and the caller needs the "edit it instead"
 * message that case already has. The person this function exists to stop is
 * specifically the one for whom "write one now" and "you can already see theirs" are
 * simultaneously true — which by definition is only someone with NO review yet.
 *
 * @param {object} booking
 * @param {object[]} existingReviews Already-fetched reviews for this booking — the
 *        caller has these on hand either way, so this never issues its own query.
 * @param {string} actorId
 * @throws {AppError} 409.
 */
function assertReviewable(booking, existingReviews, actorId) {
  if (booking.status !== "COMPLETED") {
    throw conflict(
      "You can review each other once the rental is complete.",
      { booking: "Not completed yet" }
    );
  }

  const alreadyWroteOwn = existingReviews.some((review) => review.author_id === actorId);
  if (!alreadyWroteOwn && existingReviews.some((review) => review.published_at)) {
    throw conflict(
      "This booking's review window has closed — the other review is already visible.",
      { booking: "Review window closed" }
    );
  }
}

/**
 * Writes a review — FR-800, FR-801, FR-802, FR-803.
 *
 * @param {string} bookingId
 * @param {object} actor
 * @param {{rating: number, body?: string}} input
 * @returns {Promise<object>}
 * @throws {AppError} 404 / 409.
 */
export async function writeReview(bookingId, actor, { rating, body }) {
  const booking = await loadBookingForParty(bookingId, actor);
  const existingReviews = await findReviewsForBooking(bookingId);
  assertReviewable(booking, existingReviews, actor.id);

  // WHO IS BEING REVIEWED FOLLOWS FROM WHO IS WRITING. Taking a subject id from the
  // request would let somebody aim a review at a third party, and there is nothing
  // to choose anyway: a booking has exactly two people in it.
  const role = roleInBooking(booking, actor);
  const subjectId = role === "owner" ? booking.renter_id : booking.owner_id;
  const direction = role === "owner" ? "OF_RENTER" : "OF_OWNER";

  let review;
  try {
    review = await insertReview({
      bookingId,
      authorId: actor.id,
      subjectId,
      direction,
      rating,
      body: body?.trim() || null,
    });
  } catch (error) {
    // 23505 on uq_review_per_author_per_booking — FR-802. A second review is an
    // edit, and saying so is more useful than a bare "already exists".
    if (error.code === "23505") {
      throw conflict("You have already reviewed this booking. You can edit it instead.");
    }
    throw error;
  }

  await publishIfBothWritten(bookingId);
  return present(review, actor);
}

/**
 * Publishes both reviews once both exist — FR-804's first trigger.
 *
 * The second is the sweep below, for when one party never writes.
 *
 * @param {string} bookingId
 * @returns {Promise<boolean>} Whether this call published them.
 */
async function publishIfBothWritten(bookingId) {
  const reviews = await findReviewsForBooking(bookingId);
  if (reviews.length < 2) return false;

  const published = await publishReviewsForBooking(bookingId);
  if (published === 0) return false;

  // Both parties, because the news is the same for each of them: what was written
  // about you is now readable, and so is what you wrote.
  for (const review of reviews) {
    await notifyReviewPublished({ review, recipientId: review.subject_id });
  }
  return true;
}

/**
 * What the caller may see of a booking's reviews.
 *
 * THREE DIFFERENT ANSWERS from one function, and the blind period is the reason:
 *
 *   the author  always sees their own, published or not
 *   the subject sees it only once published
 *   anybody else sees only published ones
 *
 * @param {string} bookingId
 * @param {object} actor
 * @returns {Promise<{ reviews: object[], canReview: boolean, mine: object|null }>}
 * @throws {AppError} 404.
 */
export async function getBookingReviews(bookingId, actor) {
  const booking = await loadBookingForParty(bookingId, actor);
  const all = await findReviewsForBooking(bookingId);

  const mine = all.find((review) => review.author_id === actor.id) ?? null;
  const visible = all.filter((review) => review.published_at || review.author_id === actor.id);

  return {
    reviews: visible.map((review) => present(review, actor)),
    // FR-801, FR-802 and FR-804 together: completed, you have not written one yet,
    // and nothing on this booking has published already (assertReviewable's rule —
    // kept in sync here so the client never offers a "write a review" action that
    // the server would then refuse).
    canReview: booking.status === "COMPLETED" && !mine && !all.some((r) => r.published_at),
    mine: mine ? present(mine, actor) : null,
  };
}

/**
 * Edits a review — FR-805.
 *
 * @param {string} reviewId
 * @param {object} actor
 * @param {{rating?: number, body?: string}} input
 * @returns {Promise<object>}
 * @throws {AppError} 404 / 403 / 409.
 */
export async function editReview(reviewId, actor, { rating, body }) {
  const review = await findReviewById(reviewId);
  if (!review) throw notFound("Review not found");

  // 403 rather than 404: the caller can see this review exists — it is on a booking
  // they are party to, or it is public — so pretending otherwise would be theatre.
  if (review.author_id !== actor.id) throw forbidden("Only the author can edit a review.");

  if (review.published_at) {
    throw conflict(
      "This review is now visible to the other party, so it can no longer be changed."
    );
  }

  const ageHours = (Date.now() - new Date(review.created_at).getTime()) / 3_600_000;
  if (ageHours > REVIEW_EDIT_HOURS) {
    throw conflict(`A review can only be changed within ${REVIEW_EDIT_HOURS} hours of writing it.`);
  }

  const updated = await updateReview(reviewId, actor.id, { rating, body: body?.trim() || null });
  // The UPDATE re-checks the same rules in its WHERE, so a null here means one of
  // them changed underneath us — a race, answered the same way as the check above.
  if (!updated) throw conflict("This review can no longer be changed.");

  return present(await findReviewById(reviewId), actor);
}

/**
 * The subject's single public reply — FR-808.
 *
 * @param {string} reviewId
 * @param {object} actor
 * @param {string} body
 * @returns {Promise<object>}
 * @throws {AppError} 404 / 403 / 409.
 */
export async function replyToReview(reviewId, actor, body) {
  const review = await findReviewById(reviewId);
  if (!review) throw notFound("Review not found");

  if (review.subject_id !== actor.id) {
    throw forbidden("Only the person a review is about can reply to it.");
  }

  // You cannot answer something you have not been allowed to read.
  if (!review.published_at) throw conflict("This review is not visible yet.");
  if (review.reply_at) throw conflict("You have already replied to this review.");

  const replied = await insertReply(reviewId, actor.id, body.trim());
  if (!replied) throw conflict("You have already replied to this review.");

  return present(await findReviewById(reviewId), actor);
}

/**
 * Published reviews about somebody — FR-807. Public.
 *
 * @param {string} userId
 * @param {object} [page]
 * @returns {Promise<{ reviews: object[], total: number, rating: object }>}
 */
export async function getReviewsAbout(userId, { direction, limit = 20, offset = 0 } = {}) {
  const [{ reviews, total }, rating] = await Promise.all([
    findReviewsAbout(userId, { direction, limit, offset }),
    findRatingFor(userId),
  ]);

  return { reviews: reviews.map((review) => present(review, null)), total, rating, limit, offset };
}

/**
 * Somebody's rating — FR-806, FR-033.
 *
 * @param {string} userId
 * @returns {Promise<object>}
 */
export async function getRatingFor(userId) {
  return findRatingFor(userId);
}

/**
 * Publishes reviews whose blind period has run out — FR-804's second trigger.
 *
 * Joins the existing SWEEPS list rather than starting a timer of its own.
 *
 * NEVER THROWS for one bad row, same shape as the expiry sweep: one review that
 * cannot be published must not stop the rest.
 *
 * @returns {Promise<{ expired: number, failed: number }>} `expired` for the
 *          scheduler's shared reporting shape — here it counts what was published.
 */
export async function sweepBlindReviews() {
  const cutoff = new Date(Date.now() - REVIEW_WINDOW_DAYS * 86_400_000);
  const stale = await findReviewsPastBlindPeriod(cutoff);

  // Grouped, because publishing is per booking: if both parties happened to write
  // and neither was published, one pass should release both rather than the second
  // finding nothing left to do.
  const byBooking = [...new Set(stale.map((review) => review.booking_id))];

  let expired = 0;
  let failed = 0;

  for (const bookingId of byBooking) {
    try {
      const reviews = await findReviewsForBooking(bookingId);
      const published = await publishReviewsForBooking(bookingId);
      if (published === 0) continue;

      expired += published;
      for (const review of reviews.filter((r) => !r.published_at)) {
        await notifyReviewPublished({ review, recipientId: review.subject_id });
      }
    } catch {
      failed += 1;
    }
  }

  return { expired, failed };
}

/**
 * The client's view of a review.
 *
 * `subject_id` stays — the client needs it to decide whether to offer a reply — but
 * nothing else about the two people is added here. Names come from the join.
 *
 * @param {object} row
 * @param {object|null} actor
 * @returns {object}
 */
function present(row, actor) {
  return {
    ...row,
    // Said explicitly rather than left for the client to infer from `published_at`,
    // because "why can nobody see this yet" is the question an author will have.
    isPublished: Boolean(row.published_at),
    isMine: Boolean(actor && row.author_id === actor.id),
  };
}

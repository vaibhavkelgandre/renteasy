/**
 * HTTP for reviews — FR-800 to FR-808.
 */

import {
  writeReview,
  getBookingReviews,
  editReview,
  replyToReview,
  getReviewsAbout,
} from "../services/reviewService.js";
import { sendSuccess } from "../utils/response.js";

/** POST /api/bookings/:id/reviews */
export async function postReview(req, res, next) {
  try {
    const review = await writeReview(req.validatedParams.id, req.user, req.body);
    sendSuccess(res, { status: 201, message: "Thanks for the review", data: { review } });
  } catch (error) {
    next(error);
  }
}

/** GET /api/bookings/:id/reviews */
export async function getReviews(req, res, next) {
  try {
    const data = await getBookingReviews(req.validatedParams.id, req.user);
    sendSuccess(res, { message: "OK", data });
  } catch (error) {
    next(error);
  }
}

/** PATCH /api/reviews/:reviewId */
export async function patchReview(req, res, next) {
  try {
    const review = await editReview(req.validatedParams.reviewId, req.user, req.body);
    sendSuccess(res, { message: "Review updated", data: { review } });
  } catch (error) {
    next(error);
  }
}

/** POST /api/reviews/:reviewId/reply */
export async function postReply(req, res, next) {
  try {
    const review = await replyToReview(req.validatedParams.reviewId, req.user, req.body.body);
    sendSuccess(res, { status: 201, message: "Reply posted", data: { review } });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/users/:id/reviews — public, FR-807.
 *
 * No auth at all: reviews are public by requirement, and the repository filters to
 * published ones so there is nothing here an anonymous caller should not see.
 */
export async function getUserReviews(req, res, next) {
  try {
    const data = await getReviewsAbout(req.validatedParams.id, req.validatedQuery);
    sendSuccess(res, { message: "OK", data });
  } catch (error) {
    next(error);
  }
}

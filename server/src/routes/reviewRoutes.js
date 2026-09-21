/**
 * /api/reviews — the two endpoints that act on a review rather than on a booking.
 *
 * Writing and listing a booking's reviews live on the booking routes, because they
 * are scoped by it. Editing and replying are addressed by review id, because the
 * caller already has one and the booking adds nothing to the question.
 */

import { Router } from "express";
import { requireAuth } from "../middlewares/authMiddleware.js";
import { validateBody, validateParams } from "../validators/validate.js";
import { patchReview, postReply } from "../controllers/reviewController.js";
import { editReviewSchema, replySchema, reviewParamsSchema } from "../validators/reviewValidator.js";

const router = Router();

router.use(requireAuth);

const withReviewId = validateParams(reviewParamsSchema, "Review not found");

router.patch("/:reviewId", withReviewId, validateBody(editReviewSchema), patchReview);
router.post("/:reviewId/reply", withReviewId, validateBody(replySchema), postReply);

export { router as reviewRoutes };

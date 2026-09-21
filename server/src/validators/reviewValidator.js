/**
 * Request validation for reviews — FR-803, FR-808.
 */

import { z } from "zod";

/** FR-803. Integer 1–5 plus optional text. */
export const writeReviewSchema = z.object({
  rating: z.number().int().min(1, "Give a rating from 1 to 5").max(5, "Give a rating from 1 to 5"),
  body: z.string().trim().min(1).max(2000).optional(),
});

/**
 * PATCH — both optional, at least one required.
 *
 * A body of `{}` means nothing, and answering 200 to it would suggest something was
 * saved. Same rule as the listing edit.
 */
export const editReviewSchema = z
  .object({
    rating: z.number().int().min(1).max(5).optional(),
    body: z.string().trim().max(2000).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: "Nothing to update" });

/** FR-808. A reply with no words is not a reply. */
export const replySchema = z.object({
  body: z.string().trim().min(1, "Write a reply").max(2000),
});

/** Public list of reviews about somebody. */
export const reviewListQuerySchema = z.object({
  direction: z.enum(["OF_OWNER", "OF_RENTER"]).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

/** Route params carrying a review id. */
export const reviewParamsSchema = z.object({
  reviewId: z.string().uuid(),
});

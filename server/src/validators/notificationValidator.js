/**
 * Request validation for notifications — FR-986.
 */

import { z } from "zod";

/**
 * GET /api/notifications
 *
 * `z.coerce` because a query string is always strings — `?limit=20` arrives as "20".
 *
 * DEFAULTED AND CAPPED, the same contract as browse. This list is unbounded by time:
 * a user who has rented for a year has hundreds of rows, and a caller that asks for
 * no page must still get a bounded one.
 */
export const notificationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

/** Route params carrying a notification id. */
export const notificationParamsSchema = z.object({
  id: z.string().uuid(),
});

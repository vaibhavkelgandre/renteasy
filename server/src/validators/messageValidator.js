/**
 * Request validation for booking messages.
 */

import { z } from "zod";
import { MAX_BODY_LENGTH } from "../services/messageService.js";

/**
 * GET /api/bookings/:id/messages
 *
 * `since` drives the 3-second poll, `before` pages back through history. Both are
 * `z.coerce.date()` because a query string is always strings.
 */
export const messageQuerySchema = z.object({
  since: z.coerce.date().optional(),
  before: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/**
 * POST /api/bookings/:id/messages
 *
 * The body is OPTIONAL because a message may be a bare attachment — the service
 * refuses "neither", since only it can see whether a file arrived. Validating
 * "one or the other" here would need the schema to know about multipart.
 */
export const sendMessageSchema = z.object({
  body: z.string().trim().min(1).max(MAX_BODY_LENGTH).optional(),
});

/** POST /api/bookings/:id/messages/:messageId/report */
export const reportMessageSchema = z.object({
  reason: z.string().trim().min(1, "Say what is wrong with it").max(500),
});

/** Route params carrying a booking id and a message id. */
export const messageParamsSchema = z.object({
  id: z.string().uuid(),
  messageId: z.string().uuid(),
});

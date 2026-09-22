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

/**
 * The booking a socket event is about — `thread:join`, `thread:leave`, `message:send`.
 *
 * ITS OWN SCHEMA RATHER THAN A FIELD ON THE OTHERS, because an id and a body fail
 * differently: a malformed id must answer what an absent one answers (404, with no
 * field detail — see `validateParams`), while a bad body is a 400 naming the field. A
 * socket handler validates this first and the body second, which is the same pair of
 * checks the HTTP route composes as two middlewares.
 *
 * Over HTTP the id is a route param and this is `bookingParamsSchema`'s job; over a
 * socket there is no path, so it arrives in the payload under its own name.
 */
export const socketBookingSchema = z.object({
  bookingId: z.string().uuid(),
});

/**
 * `thread:typing`.
 *
 * `isTyping` IS REQUIRED AND NOT DEFAULTED, because the two states are equally
 * meaningful and a default would pick one. Defaulting to `true` would turn a
 * malformed payload into a typing indicator that never clears; defaulting to `false`
 * would silently swallow the event this exists to carry. A client that cannot say
 * which it means is sending nothing useful, so it is refused.
 */
export const typingSchema = socketBookingSchema.extend({
  isTyping: z.boolean(),
});

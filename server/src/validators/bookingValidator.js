/**
 * Request validation for the booking routes.
 *
 * Note what is ABSENT: every price field, `status`, `renterId`, `ownerId`. Zod strips
 * unknown keys, so a body carrying `rentPaise` is discarded rather than reaching a
 * service — which is how FR-404's "a client-supplied total is never trusted" becomes
 * structural instead of a rule somebody has to remember. The price is recomputed from
 * the listing at request time, and there is no field through which a caller could
 * influence it.
 */

import { z } from "zod";
import { BOOKING_ACTIONS } from "../services/bookingStateMachine.js";

/**
 * The actions a human may ask for over HTTP.
 *
 * DERIVED FROM THE STATE MACHINE rather than retyped. An action added there is
 * accepted here automatically, and — more importantly — one removed there stops being
 * accepted, instead of lingering as a name the validator allows and the service then
 * rejects.
 *
 * Anything whose only actor is `system` is filtered out: exposing EXPIRE would let an
 * owner expire the very request they are supposed to answer.
 */
const HUMAN_ACTIONS = Object.keys(BOOKING_ACTIONS).filter((name) =>
  BOOKING_ACTIONS[name].actors.some((actor) => actor !== "system")
);

/** POST /api/bookings */
export const createBookingSchema = z.object({
  listingId: z.string().uuid({ message: "Choose a listing" }),

  // ISO instants, not dates: this product rents by the hour as well as the month, so
  // a bare date cannot express a six-hour rental.
  startsAt: z.coerce.date({ message: "Give a start date and time" }),
  endsAt: z.coerce.date({ message: "Give an end date and time" }),

  // Optional, and capped. A renter explaining what they need it for is the single
  // most useful thing an owner reads when deciding.
  message: z.string().trim().min(1).max(1000).optional(),
});

/** POST /api/bookings/:id/actions */
export const bookingActionSchema = z.object({
  action: z.enum(HUMAN_ACTIONS, { message: "Not an action you can take" }),

  // FR-507's "optional message". Required for nothing — an owner declining without a
  // reason is rude rather than invalid, and forcing one produces "." far more often
  // than it produces an explanation.
  comment: z.string().trim().min(1).max(1000).optional(),
});

/** Route params carrying a booking id. */
export const bookingParamsSchema = z.object({
  id: z.string().uuid(),
});

/**
 * GET /api/bookings?side=
 *
 * Defaulted, so a caller that asks for nothing gets their own rentals rather than an
 * error or an ambiguous merge of both sides.
 */
export const bookingListQuerySchema = z.object({
  side: z.enum(["renter", "owner"]).default("renter"),
});

/**
 * POST /api/bookings/:id/photos — FR-702.
 *
 * `multipart/form-data`, so every field arrives as a STRING. No `z.coerce` is needed
 * because both fields already are strings, but the enum is what stops a caller
 * inventing a third phase the service would then have no rule for.
 */
export const bookingPhotoSchema = z.object({
  phase: z.enum(["HANDOVER", "RETURN"], { message: "Say which moment these show" }),

  // The uploader's own words — "scratch on the lens barrel". Optional, and the reason
  // a photograph alone is not always enough to settle anything.
  note: z.string().trim().min(1).max(500).optional(),
});

/** Route params carrying a booking id and a photo id. */
export const bookingPhotoParamsSchema = z.object({
  id: z.string().uuid(),
  photoId: z.string().uuid(),
});

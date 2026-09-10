/**
 * Booking routes.
 *
 * Every route needs a session, applied once at the top rather than per line — a route
 * added later cannot then be left unguarded by omission, which is the failure mode of
 * the per-line style.
 *
 * There is no role gate anywhere. Whether you may act on a booking depends on whether
 * you are its renter or its owner, which is a relationship to a row and can only be
 * answered next to the data.
 */

import { Router } from "express";
import {
  postBooking,
  getMyBookings,
  getOneBooking,
  postBookingAction,
} from "../controllers/bookingController.js";
import {
  createBookingSchema,
  bookingActionSchema,
  bookingParamsSchema,
  bookingListQuerySchema,
} from "../validators/bookingValidator.js";
import { validateBody, validateParams, validateQuery } from "../validators/validate.js";
import { requireAuth, requireVerifiedEmail } from "../middlewares/authMiddleware.js";

const router = Router();

router.use(requireAuth);

/**
 * The message MUST match the service's own 404 exactly, or the pair becomes an oracle:
 * a different wording for a malformed id tells a caller that ids are UUIDs.
 */
const withBookingId = validateParams(bookingParamsSchema, "Booking not found");

/**
 * FR-501 — requesting a booking needs a CONFIRMED email.
 *
 * The requirement calls this "the first real consumer of FR-005". It is not quite:
 * creating a listing got there first at step 3. It is the more consequential one,
 * though — this is somebody committing to collect a stranger's property.
 */
router.post("/", requireVerifiedEmail, validateBody(createBookingSchema), postBooking);

router.get("/", validateQuery(bookingListQuerySchema), getMyBookings);

router.get("/:id", withBookingId, getOneBooking);

router.post("/:id/actions", withBookingId, validateBody(bookingActionSchema), postBookingAction);

export { router as bookingRoutes };

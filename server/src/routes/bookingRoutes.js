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
  postBookingPhotos,
  getBookingPhotos,
  getBookingPhotoFile,
  getMyBookings,
  getOneBooking,
  postBookingAction,
} from "../controllers/bookingController.js";
import {
  createBookingSchema,
  bookingActionSchema,
  bookingPhotoSchema,
  bookingPhotoParamsSchema,
  bookingParamsSchema,
  bookingListQuerySchema,
} from "../validators/bookingValidator.js";
import { validateBody, validateParams, validateQuery } from "../validators/validate.js";
import { requireAuth, requireVerifiedEmail } from "../middlewares/authMiddleware.js";
import { acceptBookingPhotos, handleUploadErrors } from "../middlewares/uploadMiddleware.js";

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

/**
 * ---- Condition photos (FR-702) ----
 *
 * NO NEW ROUTE WAS NEEDED FOR THE TRANSITIONS THEMSELVES. `/:id/actions` already
 * takes every action and its validator derives the enum from the state machine, so
 * step 8's four new transitions arrived with no routing change at all — which is what
 * the one-endpoint design was for.
 *
 * Photos do need their own routes, because they are a resource rather than a move.
 *
 * `requireVerifiedEmail` is deliberately ABSENT. Both parties reached this point
 * through a booking that already required it of the renter, and the moment somebody
 * is standing in a doorway photographing a camera is the worst possible time to
 * discover an unrelated account problem.
 */
router.post(
  "/:id/photos",
  withBookingId,
  acceptBookingPhotos,
  handleUploadErrors,
  validateBody(bookingPhotoSchema),
  postBookingPhotos
);

router.get("/:id/photos", withBookingId, getBookingPhotos);

// Before `/:id/photos/:photoId` would ever be added — there is no such route, and
// the `/file` suffix is deliberate: the bytes and the metadata are different
// resources, and only one of them should ever be cached by a browser as an image.
router.get(
  "/:id/photos/:photoId/file",
  validateParams(bookingPhotoParamsSchema, "Photo not found"),
  getBookingPhotoFile
);

export { router as bookingRoutes };

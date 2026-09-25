/**
 * Ownership/membership guards that run BEFORE a multipart upload is parsed.
 *
 * WHY THIS EXISTS DESPITE THE APP'S OWN "THE SERVICE CHECKS OWNERSHIP ONCE" RULE
 * (see listingRoutes.js's and bookingRoutes.js's own header comments): multer's
 * memory storage (uploadMiddleware.js) buffers an entire multipart body into RAM
 * BEFORE any route handler — and therefore before the service's own
 * loadOwnListing/loadBookingForParty call — ever runs. Without a check ahead of the
 * parser, any signed-in stranger can make the process hold onto real memory (up to
 * MAX_PHOTOS_PER_UPLOAD × MAX_PHOTO_BYTES per request, with no cap on how many
 * concurrent requests) for a resource they were always going to be refused. That is
 * exactly the shape of an unauthenticated-cost attack that the rest of this app's
 * upload limits (fileSize, files, fields — see uploadMiddleware.js) exist to prevent,
 * just from a different angle.
 *
 * NOT A REPLACEMENT for the service-layer check, which still runs and still owns the
 * actual authorization decision — a booking or listing can change state between this
 * middleware and the moment the service runs, so the service re-checking is what
 * keeps the decision correct. This middleware exists purely to move the refusal
 * ahead of the expensive part. The row is loaded twice on the paths that use this;
 * that double read is the accepted cost.
 *
 * Both guards require `req.validatedParams.id` and `req.user` — mount AFTER the
 * route's own `validateParams` and `requireAuth`, and BEFORE the multer parser.
 */

import { loadBookingForParty } from "../services/bookingAccess.js";
import { loadOwnListing } from "../services/listingService.js";

/**
 * Refuses a booking-scoped upload (condition photos, a message attachment) for
 * anyone who is not a party to that booking — same 404-not-403 answer
 * `loadBookingForParty` always gives (FR-512), given here before any bytes are read.
 *
 * @type {import("express").RequestHandler}
 */
export async function requireBookingParty(req, _res, next) {
  try {
    await loadBookingForParty(req.validatedParams.id, req.user);
    next();
  } catch (error) {
    next(error);
  }
}

/**
 * Refuses a listing photo upload for anyone who is not that listing's owner — same
 * 403/404 split `loadOwnListing` always gives, given here before any bytes are read.
 *
 * @type {import("express").RequestHandler}
 */
export async function requireListingOwner(req, _res, next) {
  try {
    await loadOwnListing(req.validatedParams.id, req.user);
    next();
  } catch (error) {
    next(error);
  }
}

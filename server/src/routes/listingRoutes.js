/**
 * Listing routes.
 *
 * Read top to bottom, this file answers "what URLs exist and who may call them?".
 * Middleware order in each line is execution order.
 *
 * NOTE THERE IS NO ROLE GATE ANYWHERE. Ownership is a relationship to a row, so it can
 * only be checked next to the data — `loadOwnListing` in the service does it, once, for
 * every mutating path. A `requireOwner` middleware here would need to load the listing
 * to answer, then the service would load it again.
 */

import { Router } from "express";
import {
  getCategories,
  getBrowse,
  getCities,
  getQuote,
  postListing,
  getMyListings,
  getOneListing,
  patchListing,
  getReadiness,
  postPublish,
  postUnpublish,
  deleteOneListing,
  postPhotos,
  deleteOnePhoto,
  patchPhotoOrder,
} from "../controllers/listingController.js";
import {
  createListingSchema,
  updateListingSchema,
  listingParamsSchema,
  photoParamsSchema,
  reorderPhotosSchema,
  browseQuerySchema,
  quoteQuerySchema,
} from "../validators/listingValidator.js";
import { validateBody, validateParams, validateQuery } from "../validators/validate.js";
import { requireAuth, requireVerifiedEmail, attachUserIfPresent } from "../middlewares/authMiddleware.js";
import { acceptPhotos, handleUploadErrors } from "../middlewares/uploadMiddleware.js";

const router = Router();

/**
 * A listing id, shape-checked before it reaches SQL, answering 404 for a malformed one.
 *
 * The message MUST match the service's own 404 exactly. If they differed the pair would
 * become an oracle: "Not found" versus "Listing not found" tells a caller their id was
 * the wrong SHAPE rather than merely absent.
 */
const withListingId = validateParams(listingParamsSchema, "Listing not found");
const withPhotoIds = validateParams(photoParamsSchema, "Listing not found");

// ---- Public ----

// The category list is public because the browse filters need it before anyone signs
// in, and it discloses nothing.
router.get("/categories", getCategories);

// The cities that currently have something published. Derived, not a fixed list: a
// hardcoded one goes stale in both directions - offering places with nothing to rent,
// and omitting the one somebody just listed in.
router.get("/cities", getCities);

/**
 * BROWSE - FR-300 to FR-309. Public, paginated, filtered.
 *
 * No auth middleware at all, not even attachUserIfPresent: browsing needs no account
 * and the result does not vary by who is asking. The repository restricts to PUBLISHED
 * as its first condition, so there is no caller for whom a draft could appear.
 *
 * `validateQuery`'s first consumer in this application - it was written at step 1 and
 * has had no endpoint taking a query string until now.
 */
router.get("/", validateQuery(browseQuerySchema), getBrowse);

// ---- Owner's own ----
//
// BEFORE `/:id`, and that ordering is load-bearing: Express matches in declaration
// order, so with `/:id` first the literal path "mine" would be captured as an id, fail
// the UUID shape check, and answer 404 — a bug that looks like a missing record.
router.get("/mine", requireAuth, getMyListings);

/**
 * Creating a listing needs a CONFIRMED email — the first route in this application to
 * use `requireVerifiedEmail`, which has existed since step 1 with nothing behind it.
 *
 * Gated at creation as well as at publish, deliberately: letting an unverified account
 * accumulate drafts it can never publish wastes their time and ours.
 */
router.post(
  "/",
  requireAuth,
  requireVerifiedEmail,
  validateBody(createListingSchema),
  postListing
);

router.patch("/:id", requireAuth, withListingId, validateBody(updateListingSchema), patchListing);

router.get("/:id/readiness", requireAuth, withListingId, getReadiness);
router.post("/:id/publish", requireAuth, requireVerifiedEmail, withListingId, postPublish);
router.post("/:id/unpublish", requireAuth, withListingId, postUnpublish);

router.delete("/:id", requireAuth, withListingId, deleteOneListing);

// ---- Photos ----
//
// `handleUploadErrors` sits between the parser and the handler so multer's own errors
// (too big, too many) become this API's envelope. Without it a 5MB overflow reaches the
// generic handler as an unrecognised error and answers 500 — telling someone the server
// is broken when their photo is simply too large.
router.post(
  "/:id/photos",
  requireAuth,
  requireVerifiedEmail,
  withListingId,
  acceptPhotos,
  handleUploadErrors,
  postPhotos
);

router.patch(
  "/:id/photos/order",
  requireAuth,
  withListingId,
  validateBody(reorderPhotosSchema),
  patchPhotoOrder
);

router.delete("/:id/photos/:photoId", requireAuth, withPhotoIds, deleteOnePhoto);

/**
 * A QUOTE - FR-400 to FR-404. Public, and side-effect free.
 *
 * Before `/:id`, or the literal "quote" segment would never be reached.
 *
 * `attachUserIfPresent` only so an owner can price their own draft; for everyone else
 * a draft answers 404 exactly as it does on the detail page.
 */
router.get(
  "/:id/quote",
  attachUserIfPresent,
  withListingId,
  validateQuery(quoteQuerySchema),
  getQuote
);

// ---- Public, but owner-aware ----
//
// LAST, so none of the literal paths above can be swallowed by `:id`.
//
// `attachUserIfPresent` rather than `requireAuth`: anyone may read a PUBLISHED listing,
// including a signed-out visitor, while a draft is visible only to its owner. The
// service makes that decision — this middleware only answers "who is this, if anyone?".
router.get("/:id", attachUserIfPresent, withListingId, getOneListing);

export { router as listingRoutes };

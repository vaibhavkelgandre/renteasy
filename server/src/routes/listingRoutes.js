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
} from "../validators/listingValidator.js";
import { validateBody, validateParams } from "../validators/validate.js";
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

// ---- Public, but owner-aware ----
//
// LAST, so none of the literal paths above can be swallowed by `:id`.
//
// `attachUserIfPresent` rather than `requireAuth`: anyone may read a PUBLISHED listing,
// including a signed-out visitor, while a draft is visible only to its owner. The
// service makes that decision — this middleware only answers "who is this, if anyone?".
router.get("/:id", attachUserIfPresent, withListingId, getOneListing);

export { router as listingRoutes };

/**
 * Listing endpoint controllers.
 *
 * Receive the request, call one service, send the response. The actor always comes from
 * `req.user` — never from the body — so there is no path here that could act on
 * somebody else's behalf.
 */

import {
  listCategories,
  createListing,
  listOwnListings,
  getListing,
  editListing,
  publishListing,
  unpublishListing,
  removeListing,
  getPublishReadiness,
  addPhotos,
  removePhoto,
  reorderListingPhotos,
  browseListings,
  listBrowseCities,
  quoteListing,
} from "../services/listingService.js";
import { assertRealImages } from "../middlewares/uploadMiddleware.js";
import { sendSuccess } from "../utils/response.js";

/**
 * GET /api/categories
 *
 * @param {import("express").Request} _req
 * @param {import("express").Response} res
 * @param {import("express").NextFunction} next
 */
export async function getCategories(_req, res, next) {
  try {
    sendSuccess(res, { message: "OK", data: { categories: await listCategories() } });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/listings
 *
 * 201, not 202: a listing genuinely exists afterwards and the caller is entitled to
 * know it — unlike registration, there is nothing here to withhold.
 */
export async function postListing(req, res, next) {
  try {
    const listing = await createListing(req.user, req.body);
    sendSuccess(res, { status: 201, message: "Draft saved", data: { listing } });
  } catch (error) {
    next(error);
  }
}

/** GET /api/listings/mine */
export async function getMyListings(req, res, next) {
  try {
    sendSuccess(res, { message: "OK", data: { listings: await listOwnListings(req.user) } });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/listings/:id
 *
 * Public: a published listing must be readable by someone with no account. `req.user`
 * is undefined for a visitor, which the service treats as "not the owner".
 */
export async function getOneListing(req, res, next) {
  try {
    const listing = await getListing(req.validatedParams.id, req.user ?? null);
    sendSuccess(res, { message: "OK", data: { listing } });
  } catch (error) {
    next(error);
  }
}

/** PATCH /api/listings/:id */
export async function patchListing(req, res, next) {
  try {
    const listing = await editListing(req.validatedParams.id, req.user, req.body);
    sendSuccess(res, { message: "Listing updated", data: { listing } });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/listings/:id/readiness
 *
 * What the listing still needs before it can go live. Exists so the edit screen can
 * show the checklist continuously, rather than the owner discovering it one item at a
 * time by pressing Publish.
 */
export async function getReadiness(req, res, next) {
  try {
    const readiness = await getPublishReadiness(req.validatedParams.id, req.user);
    sendSuccess(res, { message: "OK", data: readiness });
  } catch (error) {
    next(error);
  }
}

/** POST /api/listings/:id/publish */
export async function postPublish(req, res, next) {
  try {
    const listing = await publishListing(req.validatedParams.id, req.user);
    sendSuccess(res, { message: "Listing published", data: { listing } });
  } catch (error) {
    next(error);
  }
}

/** POST /api/listings/:id/unpublish */
export async function postUnpublish(req, res, next) {
  try {
    const listing = await unpublishListing(req.validatedParams.id, req.user);
    sendSuccess(res, { message: "Listing hidden", data: { listing } });
  } catch (error) {
    next(error);
  }
}

/** DELETE /api/listings/:id */
export async function deleteOneListing(req, res, next) {
  try {
    await removeListing(req.validatedParams.id, req.user);
    sendSuccess(res, { message: "Listing deleted", data: null });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/listings/:id/photos
 *
 * `assertRealImages` runs HERE rather than in multer's `fileFilter`, and the difference
 * matters: a fileFilter runs while the file is still streaming, so all it can see is
 * the client-declared type and filename — both attacker-supplied. By this point the
 * bytes are in memory and the real format can be read from them.
 */
export async function postPhotos(req, res, next) {
  try {
    const files = req.files ?? [];
    assertRealImages(files);

    const listing = await addPhotos(req.validatedParams.id, req.user, files);
    sendSuccess(res, { status: 201, message: "Photos added", data: { listing } });
  } catch (error) {
    next(error);
  }
}

/** DELETE /api/listings/:id/photos/:photoId */
export async function deleteOnePhoto(req, res, next) {
  try {
    const { id, photoId } = req.validatedParams;
    const listing = await removePhoto(id, photoId, req.user);
    sendSuccess(res, { message: "Photo removed", data: { listing } });
  } catch (error) {
    next(error);
  }
}

/** PATCH /api/listings/:id/photos/order */
export async function patchPhotoOrder(req, res, next) {
  try {
    const listing = await reorderListingPhotos(
      req.validatedParams.id,
      req.user,
      req.body.photoIds
    );
    sendSuccess(res, { message: "Photo order updated", data: { listing } });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/listings — browse.
 *
 * Public. `req.validatedQuery`, not `req.query`: in Express 5 `req.query` became a
 * getter with no setter, so `validateQuery` cannot replace it in place. Reading the raw
 * one here would bypass every default, coercion and cap the schema applies — and
 * `limit` would arrive as the string "24".
 */
export async function getBrowse(req, res, next) {
  try {
    const page = await browseListings(req.validatedQuery);
    sendSuccess(res, { message: "OK", data: page });
  } catch (error) {
    next(error);
  }
}

/** GET /api/listings/cities — the cities with something published. */
export async function getCities(_req, res, next) {
  try {
    sendSuccess(res, { message: "OK", data: { cities: await listBrowseCities() } });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/listings/:id/quote
 *
 * Public: the price is what somebody wants before deciding whether to sign up, and
 * FR-401 requires it shown before booking.
 *
 * FR-404 — the quote is computed here and nowhere else. The client renders what this
 * returns and has no arithmetic of its own, which is what makes "a client-supplied
 * total is never trusted" structural rather than a rule somebody has to remember.
 */
export async function getQuote(req, res, next) {
  try {
    const quote = await quoteListing(req.validatedParams.id, req.user ?? null, req.validatedQuery);
    sendSuccess(res, { message: "OK", data: quote });
  } catch (error) {
    next(error);
  }
}

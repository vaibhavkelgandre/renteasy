/**
 * Listings: create, edit, publish, photos, delete.
 *
 * Spec: docs/features/04-listings.md.
 *
 * THE AUTHORIZATION MODEL IS A RELATIONSHIP, NOT A ROLE (FR-111). There is no "listing
 * manager" permission to hold. The only question ever asked is "is this caller the
 * owner of this row?", answered next to the data. The same person lists a camera and
 * rents a bike, so nothing about them is a property of their account.
 */

import { badRequest, conflict, forbidden, notFound } from "../utils/errors.js";
import {
  findActiveCategories,
  findCategoryBySlug,
  insertListing,
  findListingById,
  findListingsByOwner,
  updateListing,
  updateListingStatus,
  deleteListing,
  findPhotosForListing,
  countPhotos,
  insertPhotos,
  deletePhoto,
  reorderPhotos,
  findPublishedListings,
  findBrowseCities,
  insertBlackout,
  findBlackouts,
  deleteBlackout,
  findUnavailablePeriods,
} from "../repositories/listingRepository.js";
import {
  uploadListingPhoto,
  destroyListingPhoto,
  listingPhotoUrl,
} from "../config/cloudinary.js";
import { MAX_PHOTOS_PER_LISTING } from "../middlewares/uploadMiddleware.js";
import { buildQuote } from "../utils/quote.js";

/**
 * Fetches a listing and asserts the caller owns it.
 *
 * THE 403-VERSUS-404 SPLIT IS DELIBERATE, and follows the rule in utils/errors.js.
 *
 *   a PUBLISHED listing → 403. It is world-readable; the caller can see it exists by
 *                         browsing. Pretending otherwise would be theatre.
 *   a DRAFT listing     → 404. Nobody but the owner has any way to know it exists, and
 *                         a 403 would confirm that this particular id is somebody's
 *                         unpublished listing — which is exactly the fact a draft is
 *                         for keeping private.
 *
 * @param {string} id
 * @param {object} actor The session user.
 * @returns {Promise<object>} The listing.
 * @throws {AppError} 404 or 403.
 */
async function loadOwnListing(id, actor) {
  const listing = await findListingById(id);
  if (!listing) throw notFound("Listing not found");

  if (listing.owner_id !== actor.id) {
    if (listing.status === "PUBLISHED") throw forbidden("This listing belongs to someone else.");
    throw notFound("Listing not found");
  }

  return listing;
}

/**
 * Resolves a category slug to its id, or explains what is available.
 *
 * @param {string} slug
 * @returns {Promise<string>} The category id.
 * @throws {AppError} 400 — safe to be specific, since the category list is public.
 */
async function resolveCategory(slug) {
  const category = await findCategoryBySlug(slug);
  if (!category) {
    throw badRequest("That is not a category we have.", { category: "Choose a category from the list" });
  }
  return category.id;
}

/** The public category list — FR-102. */
export async function listCategories() {
  return findActiveCategories();
}

/**
 * Attaches photo URLs to a listing.
 *
 * URLS ARE BUILT ON READ, NEVER STORED. Postgres holds a `storage_id`; every size the
 * product needs is a string derived from it here. That is what makes changing the grid
 * thumbnail an edit to one function rather than a migration across every row — and
 * what would make a move to another provider survivable.
 *
 * @param {object} listing
 * @param {object[]} photos
 * @returns {object}
 */
function withPhotoUrls(listing, photos) {
  return {
    ...listing,
    photos: photos.map((photo) => ({
      id: photo.id,
      sortOrder: photo.sort_order,
      width: photo.width,
      height: photo.height,
      thumbUrl: listingPhotoUrl(photo.storage_id, "thumb"),
      url: listingPhotoUrl(photo.storage_id, "detail"),
    })),
  };
}

/**
 * Creates a listing — FR-100. ALWAYS a draft.
 *
 * Deliberately requires almost nothing beyond a title, description, category and
 * condition. A draft is by definition half-finished; refusing to save one without a
 * price would mean somebody who wants to think about the price overnight cannot start
 * at all. Everything else is checked when they try to publish.
 *
 * @param {object} actor The session user.
 * @param {object} input
 * @returns {Promise<object>} The created listing.
 * @throws {AppError} 400 for an unknown category.
 */
export async function createListing(actor, input) {
  const categoryId = await resolveCategory(input.category);

  const listing = await insertListing({ ...input, categoryId, ownerId: actor.id });
  return withPhotoUrls(listing, []);
}

/**
 * The caller's own listings, drafts included — FR-115.
 *
 * @param {object} actor
 * @returns {Promise<object[]>}
 */
export async function listOwnListings(actor) {
  const rows = await findListingsByOwner(actor.id);

  return rows.map((row) => ({
    ...row,
    coverUrl: row.cover_storage_id ? listingPhotoUrl(row.cover_storage_id, "thumb") : null,
  }));
}

/**
 * One listing, for whoever is asking.
 *
 * A DRAFT or UNPUBLISHED listing is visible ONLY to its owner, and answers 404 to
 * everyone else — including signed-out visitors. Not 403: a stranger has no more reason
 * to learn that an id belongs to somebody's unpublished listing than to learn it
 * belongs to nothing at all.
 *
 * @param {string} id
 * @param {object|null} actor The session user, or null for a visitor.
 * @returns {Promise<object>}
 * @throws {AppError} 404.
 */
export async function getListing(id, actor) {
  const listing = await findListingById(id);
  if (!listing) throw notFound("Listing not found");

  const isOwner = actor && listing.owner_id === actor.id;
  if (listing.status !== "PUBLISHED" && !isOwner) throw notFound("Listing not found");

  return withPhotoUrls(listing, await findPhotosForListing(id));
}

/**
 * Edits a listing — FR-108. Allowed while draft, published or unpublished.
 *
 * Editing a PUBLISHED listing is deliberately permitted rather than forcing an
 * unpublish first: correcting a typo in a live listing is the most ordinary thing an
 * owner does.
 *
 * **FR-112 lives elsewhere, and this is the place to say so.** "Changing the rate card
 * never alters an already-confirmed booking" cannot be enforced here, because a booking
 * must copy the agreed price into itself at the moment it is confirmed. This function
 * changing a rate is precisely the event FR-112 exists to survive. The guarantee will
 * be a column on `bookings`, not a refusal here.
 *
 * @param {string} id
 * @param {object} actor
 * @param {object} fields
 * @returns {Promise<object>}
 * @throws {AppError} 404 / 403 / 400.
 */
export async function editListing(id, actor, fields) {
  const existing = await loadOwnListing(id, actor);

  const patch = { ...fields };
  if (fields.category !== undefined) {
    patch.categoryId = await resolveCategory(fields.category);
    delete patch.category;
  }

  // The merged row is what gets validated, never the patch alone. A body carrying only
  // `maxDurationHours` can invert the range against a stored minimum the schema never
  // sees — the usual shape of this bug.
  const min = patch.minDurationHours !== undefined ? patch.minDurationHours : existing.min_duration_hours;
  const max = patch.maxDurationHours !== undefined ? patch.maxDurationHours : existing.max_duration_hours;
  if (min != null && max != null && max < min) {
    throw badRequest("The longest rental cannot be shorter than the shortest.", {
      maxDurationHours: "Must be at least the minimum duration",
    });
  }

  const updated = await updateListing(id, patch);
  if (!updated) throw notFound("Listing not found");

  return withPhotoUrls(updated, await findPhotosForListing(id));
}

/**
 * Everything standing between a listing and being visible — FR-107.
 *
 * Collected in ONE function on purpose. A publish gate whose conditions are scattered
 * across a controller, a validator and two services is one nobody can audit, and this
 * is the rule that decides what strangers can see.
 *
 * @param {object} listing
 * @param {object} actor
 * @param {number} photoCount
 * @returns {string[]} Human-readable reasons it cannot go live. Empty means it can.
 */
function publishBlockers(listing, actor, photoCount) {
  const blockers = [];

  // The first real consumer of "an unverified account cannot list" (FR-005), which has
  // been a design intention with nothing enforcing it since step 1.
  if (!actor.email_verified_at) blockers.push("Confirm your email address");

  if (photoCount < 1) blockers.push("Add at least one photo");

  const hasRate =
    listing.hourly_rate_paise != null ||
    listing.daily_rate_paise != null ||
    listing.monthly_rate_paise != null;
  if (!hasRate) blockers.push("Set at least one price — hourly, daily or monthly");

  if (!listing.city || !listing.locality) blockers.push("Say roughly where the item is");

  return blockers;
}

/**
 * Reports what a listing still needs, without attempting anything.
 *
 * Exists so the owner's edit screen can show the checklist continuously rather than
 * only discovering it by pressing Publish and being refused. Same function as the gate
 * itself, so the two cannot drift.
 *
 * @param {string} id
 * @param {object} actor
 * @returns {Promise<{ canPublish: boolean, blockers: string[] }>}
 */
export async function getPublishReadiness(id, actor) {
  const listing = await loadOwnListing(id, actor);
  const blockers = publishBlockers(listing, actor, await countPhotos(id));
  return { canPublish: blockers.length === 0, blockers };
}

/**
 * Publishes a listing — FR-107.
 *
 * @param {string} id
 * @param {object} actor
 * @returns {Promise<object>}
 * @throws {AppError} 409 listing every unmet condition at once.
 */
export async function publishListing(id, actor) {
  const listing = await loadOwnListing(id, actor);

  if (listing.status === "PUBLISHED") return withPhotoUrls(listing, await findPhotosForListing(id));

  const blockers = publishBlockers(listing, actor, await countPhotos(id));

  if (blockers.length > 0) {
    // EVERY blocker, not the first. Reporting them one at a time turns publishing into
    // a guessing game where each fix reveals the next obstacle.
    throw conflict(`This listing is not ready yet: ${blockers.join("; ")}.`, {
      publish: blockers.join("; "),
    });
  }

  const published = await updateListingStatus(id, "PUBLISHED");
  return withPhotoUrls(published, await findPhotosForListing(id));
}

/**
 * Takes a listing out of browse — FR-109.
 *
 * **The half of FR-109 about confirmed bookings cannot be built yet**, because there is
 * no bookings table. When there is, unpublishing must leave them untouched: somebody
 * who has already agreed to rent this camera on Saturday is owed that camera on
 * Saturday, regardless of the owner having second thoughts about advertising it.
 *
 * @param {string} id
 * @param {object} actor
 * @returns {Promise<object>}
 */
export async function unpublishListing(id, actor) {
  await loadOwnListing(id, actor);
  const updated = await updateListingStatus(id, "UNPUBLISHED");
  return withPhotoUrls(updated, await findPhotosForListing(id));
}

/**
 * Deletes a listing — FR-110.
 *
 * **The condition FR-110 actually states — "only when no active or upcoming booking
 * exists" — is NOT enforced, because there is no bookings table to consult.** Deletion
 * is currently unconditional. This is a named gap rather than an oversight, and it is
 * the first thing to change when step 6 lands.
 *
 * Remote assets are deleted AFTER the row, and a failure there is logged rather than
 * raised: deleting the row is the operation the user asked for, and a leftover image
 * costs storage, whereas a failed remote delete that undid everything would leave them
 * unable to delete their own listing at all.
 *
 * @param {string} id
 * @param {object} actor
 * @returns {Promise<void>}
 */
export async function removeListing(id, actor) {
  await loadOwnListing(id, actor);

  const photos = await findPhotosForListing(id);

  try {
    await deleteListing(id);
  } catch (error) {
    /**
     * A booking references this listing (migration 006 uses ON DELETE RESTRICT).
     *
     * TWO CODES, AND THE DISTINCTION IS NOT ACADEMIC. `ON DELETE RESTRICT` raises
     * **23001** (`restrict_violation`) the moment the delete is attempted, whereas the
     * default `NO ACTION` defers the check to the end of the statement and raises
     * **23503** (`foreign_key_violation`). Catching only the familiar 23503 — which is
     * what this did first — lets a RESTRICT sail past into a 500.
     *
     * STRICTER THAN FR-110's WORDING, and deliberately. The requirement says a listing
     * may be deleted "only when no active or upcoming booking exists", implying one
     * with only old completed bookings could go. It cannot: a completed booking is the
     * other party's record of what they rented and what they paid, and deleting the
     * listing would leave that receipt referring to nothing. Same reasoning that makes
     * account deletion soft.
     *
     * The owner's remedy is UNPUBLISH, which already hides it from browse — so the
     * message names it rather than leaving them stuck.
     */
    if (error.code === "23001" || error.code === "23503") {
      throw conflict(
        "This listing has bookings, so it cannot be deleted. Unpublish it instead to hide it.",
        { listing: "Has bookings — unpublish instead" }
      );
    }
    throw error;
  }

  for (const photo of photos) {
    await destroyListingPhoto(photo.storage_id);
  }
}

/**
 * Uploads photos and attaches them — FR-105, FR-106.
 *
 * ORDER OF OPERATIONS IS THE WHOLE DESIGN, and it is the order in
 * docs/6.media-storage.md §5:
 *
 *   1. the caller owns the listing
 *   2. the cap is not already reached
 *   3. every file is really an image  (done by the middleware, before this)
 *   4. upload to the provider
 *   5. insert the rows
 *
 * Uploading AFTER every check and BEFORE the insert means a rejected request never
 * creates a remote asset, and a failed upload never leaves a half-attached listing —
 * nothing has touched Postgres at that point.
 *
 * @param {string} id
 * @param {object} actor
 * @param {Express.Multer.File[]} files
 * @returns {Promise<object>} The listing, with its photos.
 * @throws {AppError} 400 if it would exceed the cap.
 */
export async function addPhotos(id, actor, files) {
  await loadOwnListing(id, actor);

  if (files.length === 0) {
    throw badRequest("Choose at least one photo.", { photos: "Choose at least one photo" });
  }

  const existingCount = await countPhotos(id);
  if (existingCount + files.length > MAX_PHOTOS_PER_LISTING) {
    const room = MAX_PHOTOS_PER_LISTING - existingCount;
    throw badRequest(
      room === 0
        ? `This listing already has the maximum of ${MAX_PHOTOS_PER_LISTING} photos.`
        : `You can add ${room} more photo${room === 1 ? "" : "s"} to this listing.`,
      { photos: `Room for ${room} more` }
    );
  }

  const uploaded = [];
  try {
    for (const file of files) {
      const asset = await uploadListingPhoto({ buffer: file.buffer, listingId: id });
      // The SNIFFED type, never the client's claim — see uploadMiddleware.
      uploaded.push({ ...asset, mimeType: file.detectedMimeType ?? asset.mimeType });
    }
  } catch (error) {
    // Anything already uploaded in this batch is now an orphan with no row pointing at
    // it. Clean up before rethrowing rather than leaving it for the sweep.
    for (const asset of uploaded) await destroyListingPhoto(asset.storageId);
    throw error;
  }

  await insertPhotos(id, uploaded);

  const listing = await findListingById(id);
  return withPhotoUrls(listing, await findPhotosForListing(id));
}

/**
 * Removes one photo.
 *
 * @param {string} id
 * @param {string} photoId
 * @param {object} actor
 * @returns {Promise<object>}
 * @throws {AppError} 404 if the photo is not on this listing.
 */
export async function removePhoto(id, photoId, actor) {
  await loadOwnListing(id, actor);

  const storageId = await deletePhoto(id, photoId);
  if (!storageId) throw notFound("Photo not found");

  // Fire and forget after the row is gone, for the same reason as deleting a listing.
  void destroyListingPhoto(storageId);

  const listing = await findListingById(id);
  return withPhotoUrls(listing, await findPhotosForListing(id));
}

/**
 * Reorders photos — FR-106. Position 0 becomes the cover.
 *
 * The request must name EVERY photo of the listing, exactly once. A partial reorder
 * would leave the unnamed ones at positions that now collide, and "what happened to the
 * rest?" has no good answer — so it is refused rather than guessed at.
 *
 * @param {string} id
 * @param {object} actor
 * @param {string[]} photoIds
 * @returns {Promise<object>}
 * @throws {AppError} 400 if the set does not match.
 */
export async function reorderListingPhotos(id, actor, photoIds) {
  await loadOwnListing(id, actor);

  const current = await findPhotosForListing(id);
  const currentIds = new Set(current.map((photo) => photo.id));
  const wanted = new Set(photoIds);

  const sameSet =
    photoIds.length === current.length &&
    wanted.size === photoIds.length &&
    photoIds.every((photoId) => currentIds.has(photoId));

  if (!sameSet) {
    throw badRequest("List every photo of this listing exactly once.", {
      photoIds: "Must contain each of this listing's photos exactly once",
    });
  }

  await reorderPhotos(id, photoIds);

  const listing = await findListingById(id);
  return withPhotoUrls(listing, await findPhotosForListing(id));
}

/**
 * Browse published listings — FR-300 to FR-309.
 *
 * The one endpoint that makes a published listing findable. Until this existed a
 * listing was visible only to somebody who already had its URL, which is not a
 * marketplace.
 *
 * NO ACTOR PARAMETER, and that is the point (FR-300): browsing needs no account. The
 * repository restricts to `status = 'PUBLISHED'` as its first condition, so there is
 * no caller for whom a draft could appear and no authorization decision to forget.
 *
 * @param {object} query Already validated, defaulted and capped by browseQuerySchema.
 * @returns {Promise<{ listings: object[], total: number, limit: number, offset: number }>}
 */
export async function browseListings(query) {
  const {
    limit, offset, sort, category, city, q, unit, minPricePaise, maxPricePaise,
    availableFrom, availableTo,
  } = query;

  const { listings, total } = await findPublishedListings({
    filters: { categorySlug: category, city, q, unit, minPricePaise, maxPricePaise, availableFrom, availableTo },
    sort,
    limit,
    offset,
  });

  return {
    listings: listings.map((listing) => ({
      ...listing,
      // A cover only — a browse tile shows one image, and building URLs for every
      // photo of every listing on the page would be work nobody looks at.
      coverUrl: listing.cover_storage_id ? listingPhotoUrl(listing.cover_storage_id, "thumb") : null,
    })),
    total,

    // Echoed back so the client never has to remember what it asked for, and so a
    // defaulted or capped value is visible rather than silently different from the
    // request. A caller that sent `limit=500` can see it got 48.
    limit,
    offset,
  };
}

/**
 * The cities that currently have something published — for the browse filter.
 *
 * @returns {Promise<string[]>}
 */
export async function listBrowseCities() {
  return findBrowseCities();
}

/**
 * What a rental would cost — FR-400 to FR-404, FR-407.
 *
 * PUBLIC, and deliberately so: the price is the thing somebody wants before deciding
 * whether to sign up, and FR-401 requires it shown "before booking". A draft is still
 * hidden, via the same rule as `getListing`.
 *
 * RETURNS BLOCKERS RATHER THAN REFUSING when the dates fall outside the listing's own
 * limits. The same shape as the publish checklist, and for the same reason: a caller
 * who cannot see the price cannot work out what to change. "₹800, but this listing has
 * a two-day minimum" is actionable; a bare 409 is a guessing game.
 *
 * `quotedAt` is stamped because FR-405 will refuse a stale quote at booking time, and
 * that needs an age to measure.
 *
 * @param {string} id
 * @param {object|null} actor
 * @param {{ start: Date, end: Date }} range
 * @returns {Promise<{ quote: object, blockers: string[], quotedAt: string }>}
 * @throws {AppError} 404 for a hidden listing, 400 for an impossible range.
 */
export async function quoteListing(id, actor, { start, end }) {
  const listing = await findListingById(id);
  if (!listing) throw notFound("Listing not found");

  const isOwner = actor && listing.owner_id === actor.id;
  if (listing.status !== "PUBLISHED" && !isOwner) throw notFound("Listing not found");

  let quote;
  try {
    quote = buildQuote({ start, end, listing });
  } catch (error) {
    // The util throws plain Errors for an inverted range or an unpriced listing. Both
    // are client-fixable and safe to describe, so they become a 400 rather than
    // reaching the generic handler as a 500.
    throw badRequest(error.message, { end: error.message });
  }

  const blockers = [];
  const { min_duration_hours: min, max_duration_hours: max } = listing;

  // FR-504's rule, surfaced early. Checked against the REQUESTED hours rather than the
  // covered ones: someone asking for six hours has asked for six, even though a day is
  // what gets charged — refusing them against a two-hour minimum would be nonsense.
  if (min != null && quote.requestedHours < min) {
    blockers.push(`This listing has a minimum rental of ${describeHours(min)}`);
  }
  if (max != null && quote.requestedHours > max) {
    blockers.push(`This listing has a maximum rental of ${describeHours(max)}`);
  }

  return { quote, blockers, quotedAt: new Date().toISOString() };
}

/** Hours as something a person would say. */
function describeHours(hours) {
  if (hours % (24 * 30) === 0) {
    const months = hours / (24 * 30);
    return `${months} month${months === 1 ? "" : "s"}`;
  }
  if (hours % 24 === 0) {
    const days = hours / 24;
    return `${days} day${days === 1 ? "" : "s"}`;
  }
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

/**
 * Adds a blackout — FR-200, FR-206.
 *
 * @param {string} id
 * @param {object} actor
 * @param {object} input
 * @returns {Promise<object>}
 * @throws {AppError} 404 / 403 / 400 / 409.
 */
export async function addBlackout(id, actor, { startsAt, endsAt, reason }) {
  await loadOwnListing(id, actor);

  if (new Date(endsAt) <= new Date(startsAt)) {
    throw badRequest("A blackout must end after it starts.", { endsAt: "Must be after the start" });
  }

  try {
    return await insertBlackout({ listingId: id, startsAt, endsAt, reason: reason ?? null });
  } catch (error) {
    // 23P01 — the EXCLUDE constraint: this overlaps another blackout.
    if (error.code === "23P01") {
      throw conflict("That overlaps a period you have already blocked out.", {
        startsAt: "Overlaps an existing block",
      });
    }

    /**
     * 23514 — the trigger from migration 007: FR-206.
     *
     * The database's message names the colliding dates, and it is passed through
     * rather than replaced. The owner can see that booking in their own list, and a
     * refusal that will not say which one just produces a second attempt.
     */
    if (error.code === "23514") {
      throw conflict(
        "You have a confirmed booking in that period. Cancel it first, or choose different dates.",
        { startsAt: "Overlaps a confirmed booking" }
      );
    }
    throw error;
  }
}

/**
 * The owner's own blackouts, with their ids and their reasons — FR-204.
 *
 * SEPARATE FROM `getAvailability`, AND THE SPLIT IS THE POINT. That function answers
 * "when is this unavailable" for anybody, and deliberately returns no id and no
 * reason: an id is a handle for deleting a row, and a reason is the owner's private
 * note. Adding either to a world-readable response to save a request would leak both
 * to every visitor.
 *
 * So the calendar is fed by the public endpoint and the editable LIST beneath it by
 * this one. Two requests, and the owner-only data never travels on the public path.
 *
 * @param {string} id
 * @param {object} actor
 * @param {{from?: Date|null, to?: Date|null}} [window]
 * @returns {Promise<object[]>}
 * @throws {AppError} 404 / 403.
 */
export async function listBlackouts(id, actor, { from = null, to = null } = {}) {
  await loadOwnListing(id, actor);
  return findBlackouts(id, { from, to });
}

/**
 * Removes a blackout.
 *
 * @param {string} id
 * @param {string} blockId
 * @param {object} actor
 * @returns {Promise<void>}
 * @throws {AppError} 404 / 403.
 */
export async function removeBlackout(id, blockId, actor) {
  await loadOwnListing(id, actor);
  if (!(await deleteBlackout(id, blockId))) throw notFound("Not found");
}

/**
 * When a listing is unavailable — FR-204 for the owner, FR-205 for everyone else.
 *
 * ONE FUNCTION, TWO AUDIENCES, and the difference is a single field. A renter is told
 * that a period is taken; the OWNER is additionally told which of the two kinds it is,
 * because one of them is theirs to change and the other is not.
 *
 * A renter must not learn the difference: "blocked by the owner" versus "booked by
 * somebody else" is a fact about the owner's business and about another renter's
 * arrangements, and neither is any of theirs.
 *
 * @param {string} id
 * @param {object|null} actor
 * @param {object} window
 * @returns {Promise<{ unavailable: object[], noticePeriodHours: number|null, bookableFrom: string }>}
 * @throws {AppError} 404 for a listing the caller may not see.
 */
export async function getAvailability(id, actor, { from = null, to = null } = {}) {
  const listing = await findListingById(id);
  if (!listing) throw notFound("Listing not found");

  const isOwner = actor && listing.owner_id === actor.id;
  if (listing.status !== "PUBLISHED" && !isOwner) throw notFound("Listing not found");

  const periods = await findUnavailablePeriods(id, { from, to });

  return {
    unavailable: periods.map((period) => ({
      startsAt: period.starts_at,
      endsAt: period.ends_at,
      ...(isOwner ? { kind: period.kind } : {}),
    })),

    noticePeriodHours: listing.notice_period_hours,

    // FR-203, resolved to an instant rather than left as a number for the client to
    // apply. The rule is the server's, and a client computing "now + 24h" would drift
    // from it the moment the definition changed.
    bookableFrom: earliestBookableFrom(listing).toISOString(),
  };
}

/**
 * The earliest instant a booking may start — FR-203.
 *
 * Exported because the booking service enforces the same rule and the two must not
 * drift; a second copy of `now + notice` is how a listing page and a refusal end up
 * disagreeing by an hour.
 *
 * @param {object} listing
 * @returns {Date}
 */
export function earliestBookableFrom(listing) {
  const hours = listing.notice_period_hours ?? 0;
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

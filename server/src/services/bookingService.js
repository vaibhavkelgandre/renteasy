/**
 * Booking requests and their lifecycle — FR-500 to FR-514.
 *
 * Spec: docs/features/06-bookings.md.
 *
 * TWO GUARANTEES LIVE HERE, and neither is enforced by code in this file:
 *
 *   no double booking   an EXCLUDE constraint in migration 006. This file's job is to
 *                       turn the refusal into a sentence a person can act on.
 *   the price is frozen a booking carries its own copy of every figure, so a later
 *                       edit to the rate card has nothing to reach.
 *
 * Anything this file appears to guarantee on its own is a pre-check for a good error
 * message, and is labelled as such.
 */

import { badRequest, conflict, forbidden, notFound } from "../utils/errors.js";
import {
  insertBooking,
  findBookingById,
  updateBookingStatus,
  insertBookingEvent,
  findBookingEvents,
  findBookingsAsRenter,
  findBookingsAsOwner,
  findOverlappingBooking,
  findExpiredRequests,
  findAwaitingConfirmation,
  insertBookingPhotos,
  findBookingPhotos,
  findBookingPhotoById,
} from "../repositories/bookingRepository.js";
import {
  findListingById,
  findOverlappingBlackout,
} from "../repositories/listingRepository.js";
import { earliestBookableFrom } from "./listingService.js";
import {
  listingPhotoUrl,
  uploadPrivateAsset,
  fetchPrivateAsset,
  destroyPrivateAsset,
} from "../config/cloudinary.js";
import { buildQuote, billableHours } from "../utils/quote.js";
import {
  BOOKING_ACTIONS,
  checkTransition,
  roleInBooking,
  availableActions,
} from "./bookingStateMachine.js";

/**
 * How long an owner has to answer before a request expires — FR-508.
 *
 * 48 hours. Short enough that a renter is not left waiting on a weekend trip they
 * needed to plan; long enough that an owner who does not check the app daily is not
 * losing business to the clock.
 */
export const REQUEST_EXPIRY_HOURS = 48;

/** Adds the derived bits a client needs, and nothing it does not. */
function present(booking, actor) {
  return {
    ...booking,
    coverUrl: booking.cover_storage_id ? listingPhotoUrl(booking.cover_storage_id, "thumb") : null,
    // The buttons that will actually work. Derived from the state machine, so the UI
    // cannot offer a control the server refuses, or hide one it would allow.
    availableActions: availableActions(booking, actor),
    yourRole: roleInBooking(booking, actor),
  };
}

/**
 * Loads a booking and asserts the caller is party to it — FR-512.
 *
 * 404 FOR EVERYONE ELSE, never 403. A booking is a private arrangement between two
 * people; a stranger has no more reason to learn that a particular id is somebody's
 * camera rental than to learn it is nothing at all. A 403 would confirm it exists.
 *
 * @param {string} id
 * @param {object} actor
 * @returns {Promise<object>}
 * @throws {AppError} 404.
 */
async function loadBookingForParty(id, actor) {
  const booking = await findBookingById(id);
  if (!booking) throw notFound("Booking not found");

  if (!roleInBooking(booking, actor)) throw notFound("Booking not found");
  return booking;
}

/**
 * Requests a booking — FR-500 to FR-504.
 *
 * The refusals here are ordered from cheapest to most expensive, and from most to
 * least obvious to the caller.
 *
 * @param {object} actor The renter. Already known to have a verified email (FR-501,
 *        enforced at the route).
 * @param {object} input
 * @returns {Promise<object>} The created booking.
 * @throws {AppError} 404 / 400 / 409.
 */
export async function requestBooking(actor, { listingId, startsAt, endsAt, message }) {
  const listing = await findListingById(listingId);

  // A draft answers 404 to everyone but its owner, and its owner cannot book it
  // anyway — so from here a hidden listing is simply absent.
  if (!listing || listing.status !== "PUBLISHED") throw notFound("Listing not found");

  /**
   * FR-502 — YOU CANNOT BOOK YOUR OWN LISTING.
   *
   * 403 rather than 404: the caller demonstrably knows this listing exists, because
   * they wrote it. Pretending otherwise would be absurd rather than discreet.
   *
   * Checked before anything expensive, and before the overlap check in particular —
   * an owner probing their own listing should not learn anything about who else has
   * booked it from the shape of the refusal.
   */
  if (listing.owner_id === actor.id) {
    throw forbidden("You cannot book your own listing.");
  }

  // FR-500's shape: a valid range at all. `billableHours` owns this rule, so the
  // message is the same one the quote endpoint gives.
  let hours;
  try {
    hours = billableHours(startsAt, endsAt);
  } catch (error) {
    throw badRequest(error.message, { endsAt: error.message });
  }

  /**
   * FR-203 — the notice period, which subsumes "must be in the future".
   *
   * `earliestBookableFrom` is imported rather than reimplemented, so this refusal and
   * the `bookableFrom` the listing page advertises cannot drift. A second copy of
   * `now + notice` is exactly how a page and a rejection end up an hour apart.
   *
   * With no notice period set this is `now`, so the old "must be in the future" check
   * is still there — it is just the zero case of a more general rule now.
   */
  const earliest = earliestBookableFrom(listing);
  if (new Date(startsAt) < earliest) {
    // `noticeHours`, not `hours` — the outer `hours` is the BILLABLE duration and is
    // used again below for the min/max check. Shadowing it here would be legal and
    // would read as though the two were the same quantity.
    const noticeHours = listing.notice_period_hours ?? 0;
    throw badRequest(
      noticeHours > 0
        ? `This owner needs ${noticeHours} hours' notice, so the earliest start is ${earliest.toISOString()}.`
        : "Choose a start in the future.",
      { startsAt: noticeHours > 0 ? `Needs ${noticeHours} hours' notice` : "Must be in the future" }
    );
  }

  // FR-504 — the listing's own limits.
  const { min_duration_hours: min, max_duration_hours: max } = listing;
  if (min != null && hours < min) {
    throw conflict(`This listing has a minimum rental of ${min} hours.`, {
      endsAt: `Minimum ${min} hours`,
    });
  }
  if (max != null && hours > max) {
    throw conflict(`This listing has a maximum rental of ${max} hours.`, {
      endsAt: `Maximum ${max} hours`,
    });
  }

  /**
   * FR-503, the friendly half.
   *
   * This does NOT prevent a double booking — a REQUESTED booking holds no dates, so
   * nothing is being claimed here yet, and the real guard fires when the owner
   * accepts. What it prevents is a renter waiting two days for an answer on dates that
   * were already committed to somebody else.
   *
   * Both halves of FR-503 are checked, and they give DIFFERENT messages on purpose.
   * "Already booked" and "the owner has marked those dates unavailable" send a renter
   * to different next steps — the first invites trying adjacent dates, the second
   * suggests asking the owner. One vague message for both would help with neither.
   */
  const clash = await findOverlappingBooking(listingId, startsAt, endsAt);
  if (clash) {
    throw conflict("Those dates are already booked. Try different ones.", {
      startsAt: "Already booked",
    });
  }

  const blocked = await findOverlappingBlackout(listingId, startsAt, endsAt);
  if (blocked) {
    // The REASON is never returned. It is the owner's private note — "lending it to my
    // brother" is not a renter's business.
    throw conflict("The owner has marked those dates as unavailable.", {
      startsAt: "Unavailable",
    });
  }

  // FR-405 — THE QUOTE IS RECOMPUTED HERE, from the listing as it is right now, and
  // the client's figures are never read. A stale quote is not "refused" so much as
  // ignored: there is nothing for a caller to submit that could influence the price.
  let quote;
  try {
    quote = buildQuote({ start: startsAt, end: endsAt, listing });
  } catch (error) {
    throw badRequest(error.message);
  }

  const created = await insertBooking({
    listingId,
    renterId: actor.id,
    startsAt,
    endsAt,
    quote,
    renterMessage: message ?? null,
  });

  await insertBookingEvent({
    bookingId: created.id,
    actorId: actor.id,
    fromStatus: null,
    toStatus: "REQUESTED",
    comment: message ?? null,
  });

  return present(await findBookingById(created.id), actor);
}

/**
 * Applies an action to a booking — FR-505, FR-506, FR-507, FR-509, FR-510.
 *
 * EVERY STATUS CHANGE GOES THROUGH HERE. That is what makes the audit trail complete:
 * a second path that wrote `status` would be a state change with no event, and a trail
 * with holes is not evidence.
 *
 * @param {string} id
 * @param {object|null} actor Null for the system (the expiry sweep).
 * @param {string} action
 * @param {string} [comment]
 * @returns {Promise<object>}
 * @throws {AppError} 404 / 403 / 409.
 */
export async function actOnBooking(id, actor, action, comment = null) {
  const booking = actor
    ? await loadBookingForParty(id, actor)
    : await findBookingById(id);

  if (!booking) throw notFound("Booking not found");

  const role = actor ? roleInBooking(booking, actor) : "system";
  const check = checkTransition({ action, status: booking.status, role });

  if (!check.ok) {
    // WRONG_ACTOR is a 403 rather than a 404: the caller is party to this booking, so
    // they legitimately know it exists — they are just the wrong one of the two. The
    // stranger case never reaches here; `loadBookingForParty` already answered 404.
    if (check.reason === "WRONG_ACTOR") {
      throw forbidden("Only the other party can do that.");
    }
    // FR-506. 409, because nothing is malformed and nobody is forbidden — the
    // booking's current state simply does not allow it.
    throw conflict(`A ${booking.status.toLowerCase()} booking cannot be ${action.toLowerCase().replace(/_/g, " ")}ed.`);
  }

  /**
   * The friendly pre-check before claiming dates.
   *
   * Only on an action that moves INTO a dates-holding state. Several renters may hold
   * REQUESTED bookings for one weekend — that is by design — so the collision surfaces
   * the moment an owner accepts a second one.
   *
   * The constraint below is still what decides. This only buys a better message.
   */
  if (BOOKING_ACTIONS[action].claimsDates) {
    const clash = await findOverlappingBooking(
      booking.listing_id,
      booking.starts_at,
      booking.ends_at,
      booking.id
    );
    if (clash) {
      throw conflict(
        "You have already accepted another booking that overlaps these dates.",
        { action: "Overlaps a confirmed booking" }
      );
    }
  }

  let updated;
  try {
    updated = await updateBookingStatus(id, check.to, booking.status);
  } catch (error) {
    /**
     * 23P01 — THE EXCLUSION CONSTRAINT REFUSED IT.
     *
     * This is the real guard firing, and reaching it means two accepts raced past the
     * pre-check above. It is the ordinary outcome of concurrency, not an application
     * fault, so it must not surface as a 500.
     *
     * The loser is told the same thing the pre-check would have told them, so the two
     * paths are indistinguishable from outside — which is the point: correctness does
     * not depend on which one caught it.
     */
    if (error.code === "23P01") {
      throw conflict(
        "Those dates were taken while you were deciding. Only one booking can hold them.",
        { action: "Overlaps a confirmed booking" }
      );
    }
    throw error;
  }

  // Null means the status moved between our read and our write — somebody else acted
  // first. Same answer as an illegal transition, because from here it is one.
  if (!updated) {
    throw conflict("This booking has already moved on. Reload and try again.");
  }

  await insertBookingEvent({
    bookingId: id,
    actorId: actor?.id ?? null,
    fromStatus: booking.status,
    toStatus: check.to,
    comment,
  });

  return present(updated, actor);
}

/**
 * One booking, for a party to it — FR-512.
 *
 * @param {string} id
 * @param {object} actor
 * @returns {Promise<object>} The booking, with its full trail.
 */
export async function getBooking(id, actor) {
  const booking = await loadBookingForParty(id, actor);
  return { ...present(booking, actor), events: await findBookingEvents(id) };
}

/**
 * The caller's bookings, from whichever side they ask — FR-513.
 *
 * @param {object} actor
 * @param {"renter"|"owner"} side
 * @returns {Promise<object[]>}
 */
export async function listBookings(actor, side) {
  const rows =
    side === "owner" ? await findBookingsAsOwner(actor.id) : await findBookingsAsRenter(actor.id);
  return rows.map((booking) => present(booking, actor));
}

/**
 * Expires requests the owner never answered — FR-508.
 *
 * NO ACTOR, and the event records that. Writing down the owner as having expired a
 * request they simply never saw would put a false action in an append-only trail; the
 * whole value of that trail is that everything in it happened.
 *
 * Reuses `actOnBooking` rather than updating in bulk, so an expiry is subject to the
 * same state machine and produces the same kind of event as every other transition.
 * A sweep with its own UPDATE would be the second write path this file exists to
 * prevent.
 *
 * Scheduled hourly by `scheduler.js`, which `server.js` starts — never `app.js`, or
 * it would run during the tests. Returns counts rather than throwing, because the
 * caller is a timer with nobody to report to: one booking that cannot be expired,
 * because somebody accepted it a moment ago, must not stop the rest of the sweep.
 *
 * @returns {Promise<{ expired: number, failed: number }>}
 */
/**
 * How long a booking may sit waiting on the other party's confirmation — FR-708.
 *
 * 48 hours each, and they are separate constants because the two waits are not the
 * same thing. A renter confirming receipt has the item in their hands and needs only
 * to tap once; an owner confirming a return has to actually inspect the thing, which
 * may mean getting home first. If either ever needs tuning it will be the second.
 */
export const RECEIPT_CONFIRMATION_HOURS = 48;
export const RETURN_CONFIRMATION_HOURS = 48;

/**
 * FR-708 — neither party can complete unilaterally, but neither can stall forever.
 *
 * The requirement is a single sentence with two halves, and the second is what this
 * is: "without a timeout". Without one, a renter who never confirms receipt leaves a
 * booking holding its dates for good, and an owner who never inspects a return leaves
 * the renter's booking — and eventually their deposit — open indefinitely. Neither
 * party can force the other's hand, so time does it.
 *
 * NO ACTOR IS RECORDED, exactly as for the expiry sweep. Writing down the renter as
 * having confirmed receipt of something they never acknowledged would put a false
 * statement in an append-only trail whose entire value is that everything in it
 * happened. The event says the system did it, on the strength of the other party's
 * assertion going unchallenged for two days.
 *
 * Goes through `actOnBooking` rather than an UPDATE, so a swept booking passes the
 * same state machine and writes the same kind of event as a human one.
 *
 * @returns {Promise<{ expired: number, failed: number }>} Named to match the other
 *          sweep, so the scheduler can log both without special-casing either.
 */
export async function sweepStalledConfirmations() {
  const phases = [
    { status: "HANDED_OVER", action: "CONFIRM_RECEIPT", hours: RECEIPT_CONFIRMATION_HOURS },
    { status: "RETURNED", action: "COMPLETE", hours: RETURN_CONFIRMATION_HOURS },
  ];

  let expired = 0;
  let failed = 0;

  for (const phase of phases) {
    const cutoff = new Date(Date.now() - phase.hours * 60 * 60 * 1000);

    for (const booking of await findAwaitingConfirmation(phase.status, cutoff)) {
      try {
        await actOnBooking(booking.id, null, phase.action);
        expired += 1;
      } catch {
        // One booking somebody confirmed a moment ago must not stop the rest.
        failed += 1;
      }
    }
  }

  return { expired, failed };
}

export async function sweepExpiredRequests() {
  const cutoff = new Date(Date.now() - REQUEST_EXPIRY_HOURS * 60 * 60 * 1000);
  const stale = await findExpiredRequests(cutoff);

  let expired = 0;
  let failed = 0;

  for (const booking of stale) {
    try {
      await actOnBooking(booking.id, null, "EXPIRE");
      expired += 1;
    } catch {
      // One booking that cannot be expired — because somebody accepted it a moment
      // ago — must not stop the rest of the sweep.
      failed += 1;
    }
  }

  return { expired, failed };
}

/**
 * The states in which a condition photo of each kind still makes sense — FR-702.
 *
 * HANDOVER photos while the item is going out or is out; RETURN photos from the
 * moment it comes back. Both windows stay open a step longer than the strict moment,
 * because the realistic case is somebody photographing the item in a car park and
 * uploading it when they get signal.
 *
 * They close at COMPLETED. After that the record is settled and a late addition is
 * not evidence of the handover, it is evidence of an argument.
 */
const PHOTO_PHASES = {
  HANDOVER: ["ACCEPTED", "HANDED_OVER", "ACTIVE"],
  RETURN: ["ACTIVE", "HANDED_OVER", "RETURNED"],
};

/**
 * Attaches condition photos to a booking — FR-702.
 *
 * OPTIONAL, NEVER REQUIRED, and that was a product decision rather than an oversight.
 * Making them mandatory would block a handover happening in a car park with one bar
 * of signal, and a handover that cannot be recorded is worse than one recorded
 * without pictures. The booking detail page says plainly when a phase has none, which
 * is the honest version of the same nudge.
 *
 * EITHER PARTY, at either phase. The requirement says "by both parties" and the
 * reason is adversarial: a scratch is worth photographing by whoever thinks it helps
 * them, and a record only one side can contribute to is not a record.
 *
 * @param {string} id
 * @param {object} actor Must be a party to the booking.
 * @param {object} input
 * @param {"HANDOVER"|"RETURN"} input.phase
 * @param {string} [input.note]
 * @param {Array<{buffer: Buffer, detectedMimeType?: string}>} files
 * @returns {Promise<object[]>} The stored rows, each with a proxy URL.
 * @throws {AppError} 404 for a non-party, 400 for no files, 409 out of phase.
 */
export async function addBookingPhotos(id, actor, { phase, note = null }, files) {
  const booking = await loadBookingForParty(id, actor);

  if (files.length === 0) {
    throw badRequest("Choose at least one photo.", { photos: "Choose at least one photo" });
  }

  if (!PHOTO_PHASES[phase].includes(booking.status)) {
    throw conflict(
      phase === "HANDOVER"
        ? "Handover photos can only be added around the handover itself."
        : "Return photos can only be added once the item is on its way back.",
      { phase: `Not while this booking is ${booking.status.toLowerCase()}` }
    );
  }

  const uploaded = [];
  try {
    for (const file of files) {
      // PRIVATE, not the listing pipeline. These are taken wherever an item changes
      // hands, so they show doorways, number plates, the inside of a home.
      const asset = await uploadPrivateAsset({ buffer: file.buffer, scope: id });
      uploaded.push({ ...asset, mimeType: file.detectedMimeType ?? asset.mimeType });
    }
  } catch (error) {
    // Anything already uploaded in this batch has no row pointing at it. Clean up
    // rather than leaving an orphan nobody will ever find — same as listing photos.
    for (const asset of uploaded) await destroyPrivateAsset(asset.storageId);
    throw error;
  }

  const rows = await insertBookingPhotos(id, phase, actor.id, uploaded, note?.trim() || null);
  return rows.map((row) => presentPhoto(row, id));
}

/**
 * Every condition photo on a booking, for a party to it.
 *
 * @param {string} id
 * @param {object} actor
 * @returns {Promise<object[]>}
 * @throws {AppError} 404 for a non-party.
 */
export async function listBookingPhotos(id, actor) {
  await loadBookingForParty(id, actor);
  return (await findBookingPhotos(id)).map((row) => presentPhoto(row, id));
}

/**
 * Fetches one photo's bytes, for a party to the booking.
 *
 * STREAMED THROUGH THIS APPLICATION RATHER THAN REDIRECTED TO, and that is the whole
 * design. A signed Cloudinary URL is a bearer credential for the five minutes it
 * lives: anyone who gets hold of it can fetch the image, and a redirect puts it in
 * the browser's address bar, its history, and any referrer header that follows. By
 * streaming, the signed URL exists only inside this process and the client only ever
 * sees a path it must be authorised for on every single request.
 *
 * @param {string} id
 * @param {string} photoId
 * @param {object} actor
 * @returns {Promise<{ stream: ReadableStream, mimeType: string }>}
 * @throws {AppError} 404 for a non-party or an unknown photo.
 */
export async function getBookingPhotoFile(id, photoId, actor) {
  await loadBookingForParty(id, actor);

  const photo = await findBookingPhotoById(id, photoId);
  if (!photo) throw notFound("Photo not found");

  const stream = await fetchPrivateAsset(photo.storage_id);

  // An asset gone from the provider while its row survives. A 404 rather than a 500:
  // the caller can do nothing about either, and from outside the two are the same
  // answer — there is no photo here.
  if (!stream) throw notFound("Photo not found");

  return { stream, mimeType: photo.mime_type };
}

/**
 * Shapes a photo row for the client.
 *
 * NO URL TO THE PROVIDER — a path on this application. A signed URL would expire in
 * the client's hands, and storing or sending one would leak a credential; the proxy
 * path can be re-requested forever and is checked every time.
 *
 * @param {object} row
 * @param {string} bookingId
 * @returns {object}
 */
function presentPhoto(row, bookingId) {
  return {
    id: row.id,
    phase: row.phase,
    note: row.note,
    uploadedBy: row.uploaded_by,
    uploadedByName: row.uploaded_by_name ?? null,
    width: row.width,
    height: row.height,
    createdAt: row.created_at,
    url: `/api/bookings/${bookingId}/photos/${row.id}/file`,
  };
}

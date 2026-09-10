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
} from "../repositories/bookingRepository.js";
import {
  findListingById,
  findOverlappingBlackout,
} from "../repositories/listingRepository.js";
import { earliestBookableFrom } from "./listingService.js";
import { listingPhotoUrl } from "../config/cloudinary.js";
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

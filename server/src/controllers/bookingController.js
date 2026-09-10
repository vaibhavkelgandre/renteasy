/**
 * Booking endpoint controllers.
 *
 * Receive the request, call one service, send the response. The actor always comes
 * from `req.user`, so no path here can act on somebody else's behalf.
 */

import {
  requestBooking,
  actOnBooking,
  getBooking,
  listBookings,
} from "../services/bookingService.js";
import { sendSuccess } from "../utils/response.js";

/**
 * POST /api/bookings
 *
 * 201: a booking genuinely exists afterwards and both parties are entitled to know
 * it — unlike registration, there is nothing here to withhold.
 */
export async function postBooking(req, res, next) {
  try {
    const booking = await requestBooking(req.user, req.body);
    sendSuccess(res, { status: 201, message: "Booking requested", data: { booking } });
  } catch (error) {
    next(error);
  }
}

/** GET /api/bookings?side=renter|owner */
export async function getMyBookings(req, res, next) {
  try {
    const { side } = req.validatedQuery;
    sendSuccess(res, {
      message: "OK",
      data: { bookings: await listBookings(req.user, side), side },
    });
  } catch (error) {
    next(error);
  }
}

/** GET /api/bookings/:id — includes the full append-only trail. */
export async function getOneBooking(req, res, next) {
  try {
    const booking = await getBooking(req.validatedParams.id, req.user);
    sendSuccess(res, { message: "OK", data: { booking } });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/bookings/:id/actions
 *
 * ONE ENDPOINT FOR EVERY TRANSITION, rather than /accept, /decline, /cancel.
 *
 * The state machine already decides what is legal and for whom. A route per action
 * would duplicate that decision in the routing table, and the two would drift the
 * first time an action's rules changed. It also means a new action needs no new route
 * and — because the validator's enum is derived from the machine — no new validation
 * either.
 */
export async function postBookingAction(req, res, next) {
  try {
    const booking = await actOnBooking(
      req.validatedParams.id,
      req.user,
      req.body.action,
      req.body.comment ?? null
    );
    sendSuccess(res, {
      message: `Booking ${booking.status.toLowerCase()}`,
      data: { booking },
    });
  } catch (error) {
    next(error);
  }
}

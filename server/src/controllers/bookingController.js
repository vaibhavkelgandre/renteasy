/**
 * Booking endpoint controllers.
 *
 * Receive the request, call one service, send the response. The actor always comes
 * from `req.user`, so no path here can act on somebody else's behalf.
 */

import {
  requestBooking,
  actOnBooking,
  addBookingPhotos,
  listBookingPhotos,
  getBookingPhotoFile as fetchBookingPhotoFile,
  getBooking,
  listBookings,
} from "../services/bookingService.js";
import { sendSuccess } from "../utils/response.js";
import { assertRealImages } from "../middlewares/uploadMiddleware.js";

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

/** POST /api/bookings/:id/photos — FR-702. */
export async function postBookingPhotos(req, res, next) {
  try {
    // The SNIFFED type, never the filename or the client's Content-Type. Same guard
    // as listing photos: an extension is a claim, magic bytes are evidence.
    //
    // It MUTATES and returns nothing — it stamps `detectedMimeType` onto each file in
    // place. Reading a return value out of it yields undefined, which surfaces three
    // frames away as "cannot read properties of undefined".
    const files = req.files ?? [];
    assertRealImages(files);

    const photos = await addBookingPhotos(req.validatedParams.id, req.user, req.body, files);
    sendSuccess(res, { status: 201, message: "Photos added", data: { photos } });
  } catch (error) {
    next(error);
  }
}

/** GET /api/bookings/:id/photos */
export async function getBookingPhotos(req, res, next) {
  try {
    const photos = await listBookingPhotos(req.validatedParams.id, req.user);
    sendSuccess(res, { message: "OK", data: { photos } });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/bookings/:id/photos/:photoId/file
 *
 * Streams the bytes rather than redirecting to a signed URL — see
 * `getBookingPhotoFile` for why that distinction is the whole point.
 *
 * `private, max-age=300` on the response: private so no shared cache holds an image
 * whose access depends on who asked, and five minutes so a detail page re-rendering
 * does not re-fetch every photo.
 */
export async function getBookingPhotoFile(req, res, next) {
  try {
    const { id, photoId } = req.validatedParams;
    const { stream, mimeType } = await fetchBookingPhotoFile(id, photoId, req.user);

    res.set("Content-Type", mimeType);
    res.set("Cache-Control", "private, max-age=300");

    // `inline`, so an <img> renders it rather than the browser offering to save it.
    // The filename is deliberately generic — the stored id is not the caller's
    // business and a real filename would leak whatever the uploader's phone called it.
    res.set("Content-Disposition", 'inline; filename="photo"');

    const { Readable } = await import("node:stream");
    Readable.fromWeb(stream).pipe(res);
  } catch (error) {
    next(error);
  }
}

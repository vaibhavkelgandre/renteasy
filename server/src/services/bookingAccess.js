/**
 * The one rule for who may touch a booking.
 *
 * EXTRACTED FROM `bookingService`, not copied, and the reason is a circular import
 * that turned out to be pointing at a real design issue. `messageService` needs the
 * identical question answered — "is this caller one of the two parties" — while
 * `bookingService` needs to write a SYSTEM line into a thread when a booking moves.
 * Each importing the other is a cycle.
 *
 * The tempting fix is four duplicated lines in the message service. That would give
 * this application TWO opinions about who may read a booking, which is precisely the
 * kind of divergence that ends with one of them forgetting a case. A shared module
 * has neither problem.
 */

import { findBookingById } from "../repositories/bookingRepository.js";
import { roleInBooking } from "./bookingStateMachine.js";
import { notFound } from "../utils/errors.js";

/**
 * Loads a booking, or 404s for anybody who is not a party to it.
 *
 * 404 RATHER THAN 403, deliberately — FR-512. A stranger has no more legitimate
 * reason to learn that this booking exists than to learn the id was wrong, and a
 * 403 would confirm that a particular uuid is somebody's real rental.
 *
 * @param {string} id
 * @param {object} actor
 * @returns {Promise<object>} The booking.
 * @throws {AppError} 404.
 */
export async function loadBookingForParty(id, actor) {
  const booking = await findBookingById(id);
  if (!booking) throw notFound("Booking not found");

  if (!roleInBooking(booking, actor)) throw notFound("Booking not found");
  return booking;
}

/**
 * Who gets told what — FR-985, FR-986.
 *
 * EVERY BOOKING NOTIFICATION IS THE SAME SENTENCE: a transition happened, tell the
 * OTHER party. `actOnBooking` is the single funnel every state change passes through,
 * so one hook there covers eight of the nine events and `requestBooking` covers the
 * ninth. The alternative — a `notify()` call beside each transition — would put the
 * same decision in nine places and let a future action quietly notify nobody.
 *
 * A MAP MEANS AN OMISSION IS VISIBLE. Adding an action to the state machine without
 * adding it here leaves a blank cell in a table somebody reads, rather than silence
 * nobody notices. There is a test asserting the two agree.
 */

import {
  insertNotification,
  findNotifications,
  countUnreadNotifications,
  markNotificationRead,
  markAllNotificationsRead,
} from "../repositories/notificationRepository.js";
import { countUnreadInThread } from "../repositories/messageRepository.js";
import { notFound } from "../utils/errors.js";

/**
 * Per action: who hears about it, and what they are told.
 *
 * `to` is a ROLE IN THIS BOOKING, resolved against the booking itself — never a user
 * id, because the whole point is that it is the party who did NOT act.
 *
 * The wording is second-person and says what to do next where there is something to
 * do. "Your booking was accepted" is a fact; "confirm you have it" is the reason the
 * notification was worth sending.
 *
 * FR-987 IS OBSERVED HERE EVEN THOUGH THIS IS NOT EMAIL: no figure and no address in
 * any of these strings. They appear in a list somebody reads on a phone in public,
 * and "₹80,000 camera, Kothrud" on a lock screen is an advert for a burglary. The
 * price is on the booking page, one tap away, behind a session.
 */
export const BOOKING_NOTIFICATIONS = {
  ACCEPT: {
    to: "renter",
    type: "BOOKING_ACCEPTED",
    message: (listing) => `Your booking for "${listing}" was accepted.`,
  },
  DECLINE: {
    to: "renter",
    type: "BOOKING_DECLINED",
    message: (listing) => `Your booking request for "${listing}" was declined.`,
  },
  CANCEL: {
    to: "owner",
    type: "BOOKING_CANCELLED",
    message: (listing) => `A booking for your "${listing}" was cancelled by the renter.`,
  },
  CANCEL_AS_OWNER: {
    to: "renter",
    type: "BOOKING_CANCELLED_BY_OWNER",
    message: (listing) => `Your confirmed booking for "${listing}" was cancelled by the owner.`,
  },
  EXPIRE: {
    // The RENTER, not the owner. The owner is the one who let it lapse, and telling
    // somebody their own inaction expired something reads as a reprimand from a
    // system that could simply have reminded them. The renter is the one left
    // waiting on an answer that is now never coming.
    to: "renter",
    type: "BOOKING_EXPIRED",
    message: (listing) => `Your request for "${listing}" expired — the owner did not reply in time.`,
  },
  START: {
    to: "renter",
    type: "BOOKING_HANDED_OVER",
    message: (listing) => `The owner says they have handed over "${listing}". Confirm you have it.`,
  },
  CONFIRM_RECEIPT: {
    to: "owner",
    type: "BOOKING_RECEIPT_CONFIRMED",
    message: (listing) => `The renter confirmed they have your "${listing}".`,
  },
  RETURN: {
    to: "owner",
    type: "BOOKING_RETURNED",
    message: (listing) => `"${listing}" has been returned. Confirm the condition to finish up.`,
  },
  COMPLETE: {
    to: "renter",
    type: "BOOKING_COMPLETED",
    message: (listing) => `Your rental of "${listing}" is complete.`,
  },
};

/**
 * Writes a notification, swallowing anything that goes wrong — FR-985.
 *
 * THE `catch` IS THE REQUIREMENT, not defensiveness. "A notification failure never
 * fails the action that triggered it" means a booking must still be accepted when
 * the notifications table is unreachable. A bell that misses a row is a nuisance; an
 * accept that 500s because of one is a bug in the wrong feature entirely.
 *
 * It logs, because a silently swallowed error that nobody can see is how this stops
 * working for a fortnight without anyone noticing.
 *
 * @param {object} input See `insertNotification`.
 * @returns {Promise<boolean>} Whether it was written. Nothing depends on this today;
 *          it exists so a caller CAN know, rather than having to assume.
 */
async function notify(input) {
  try {
    await insertNotification(input);
    return true;
  } catch (error) {
    console.error(`[notify] ${input.type} for ${input.userId} failed: ${error.message}`);
    return false;
  }
}

/**
 * Tells the other party about a booking transition.
 *
 * NEVER NOTIFIES THE ACTOR, and that guard is here rather than at each call site
 * because it is the bug this kind of feature always ships with: "your booking was
 * accepted" arriving for the person who just pressed Accept. Resolving the recipient
 * from a ROLE and then comparing against the actor makes it structural — there is no
 * call site that could get it wrong.
 *
 * A `system` actor (the sweeps) has no id, so both parties remain notifiable and the
 * map's `to` decides alone. That is right: nobody acted, so nobody is being told
 * about their own action.
 *
 * @param {object} booking Must carry `owner_id`, `renter_id`, `listing_title`.
 * @param {string} action
 * @param {object|null} actor The person who acted, or null for a sweep.
 * @returns {Promise<void>} Never rejects.
 */
export async function notifyBookingTransition(booking, action, actor) {
  const rule = BOOKING_NOTIFICATIONS[action];

  // An action with no entry notifies nobody. Deliberate rather than a throw: a
  // missing rule must not break the transition it hangs off, and the test that
  // compares this map against the state machine is what catches the omission.
  if (!rule) return;

  const recipientId = rule.to === "owner" ? booking.owner_id : booking.renter_id;
  if (actor && recipientId === actor.id) return;

  await notify({
    userId: recipientId,
    type: rule.type,
    entityType: "BOOKING",
    entityId: booking.id,
    message: rule.message(booking.listing_title),
  });
}

/**
 * Tells an owner somebody wants to rent their item — the one event that is not a
 * transition, because the booking did not exist a moment ago.
 *
 * @param {object} booking
 * @returns {Promise<void>} Never rejects.
 */
export async function notifyBookingRequested(booking) {
  await notify({
    userId: booking.owner_id,
    type: "BOOKING_REQUESTED",
    entityType: "BOOKING",
    entityId: booking.id,
    message: `Someone wants to rent your "${booking.listing_title}".`,
  });
}

/**
 * Tells somebody they have a new message — but only once per burst.
 *
 * THE DEDUPE IS THE WHOLE POINT. A chat is bursty by nature: somebody sends four
 * lines in twenty seconds, and four rings turns the bell from a signal into
 * something people learn to ignore — at which point it stops working for the
 * booking notifications too, which are the ones that actually need answering.
 *
 * So: ring only if the recipient has NOTHING unread in this thread already. Once
 * they read it the counter resets, and the next message rings again. One `EXISTS`
 * check buys the difference between a useful bell and a noisy one.
 *
 * Never rejects, same contract as every other notify (FR-985) — a bell that missed
 * a message must not fail the message.
 *
 * @param {object} input
 * @param {object} input.booking Needs `id` and `listing_title`.
 * @param {string} input.recipientId
 * @param {string} input.senderName
 * @returns {Promise<void>}
 */
export async function notifyNewMessage({ booking, recipientId, senderName }) {
  try {
    // Checked BEFORE the message is counted as unread would be wrong — this runs
    // after the insert, so the new message itself is already in the count. What is
    // being asked is whether there was more than one.
    // `> 1`, not `> 0`: this runs AFTER the insert, so the message that triggered it
    // is already counted. One means "this is the only thing waiting" — ring. More
    // means they have not looked since the last one — stay quiet.
    if ((await countUnreadInThread(booking.id, recipientId)) > 1) return;
  } catch (error) {
    // A failed check must not swallow the notification; ring rather than stay quiet.
    console.error(`[notify] unread check for ${booking.id} failed: ${error.message}`);
  }

  await notify({
    userId: recipientId,
    type: "BOOKING_MESSAGE",
    entityType: "BOOKING",
    entityId: booking.id,
    // FR-987 again: the sender and the item, never the message body. A chat line
    // could contain anything, and this is read on a lock screen.
    message: `${senderName} sent you a message about "${booking.listing_title}".`,
  });
}

/**
 * One page of the caller's notifications — FR-986.
 *
 * @param {object} actor
 * @param {{limit: number, offset: number}} page
 * @returns {Promise<{ notifications: object[], total: number, limit: number, offset: number }>}
 */
export async function listNotifications(actor, { limit, offset }) {
  const { notifications, total } = await findNotifications(actor.id, { limit, offset });

  // Echoed back so a defaulted or capped value is visible in the response rather than
  // silently different from what was asked for — same contract as browse.
  return { notifications, total, limit, offset };
}

/**
 * The unread badge's number.
 *
 * @param {object} actor
 * @returns {Promise<{ unread: number }>}
 */
export async function getUnreadCount(actor) {
  return { unread: await countUnreadNotifications(actor.id) };
}

/**
 * Marks one read.
 *
 * 404 for somebody else's id AND for one already read, which are deliberately the
 * same answer: both mean "there is no unread notification of yours here", and
 * distinguishing them would tell a caller whether a uuid they guessed exists.
 *
 * @param {object} actor
 * @param {string} id
 * @returns {Promise<object>}
 * @throws {AppError} 404.
 */
export async function readNotification(actor, id) {
  const updated = await markNotificationRead(actor.id, id);
  if (!updated) throw notFound("Notification not found");
  return updated;
}

/**
 * Marks all of the caller's read.
 *
 * @param {object} actor
 * @returns {Promise<{ read: number }>} How many were actually unread.
 */
export async function readAllNotifications(actor) {
  return { read: await markAllNotificationsRead(actor.id) };
}

/**
 * Messages between the two parties to a booking.
 *
 * WHY THIS IS NOT A CHAT SYSTEM. There is no conversation entity, no participant
 * list, no presence and no rooms. A booking already names exactly two people and
 * already has a rule for who may see it, so the whole feature is "append a row to a
 * thread the caller is party to" — and every permission question was answered before
 * this file existed.
 *
 * `loadBookingForParty` is imported rather than reimplemented for that reason: the
 * one place that decides who may touch a booking must not gain a second opinion.
 */

import {
  insertMessage,
  findMessages,
  findMessageById,
  markThreadRead,
  countUnreadMessages,
  findThreads,
  insertMessageReport,
} from "../repositories/messageRepository.js";
import { loadBookingForParty } from "./bookingAccess.js";
import { canMessage, roleInBooking, CHAT_GRACE_DAYS } from "./bookingStateMachine.js";
import { uploadPrivateAsset, fetchPrivateAsset } from "../config/cloudinary.js";
import { notifyNewMessage } from "./notificationService.js";
import { publishMessage } from "../ws/socketPublisher.js";
import { badRequest, conflict, notFound } from "../utils/errors.js";

/** Long enough for a real message, short enough that nobody pastes an essay. */
export const MAX_BODY_LENGTH = 2000;

/**
 * Refuses when the thread is closed to new messages, saying which kind of closed.
 *
 * Two different messages on purpose. "This booking was declined" is permanent and
 * the reader should stop; "the window has passed" tells somebody with a genuine
 * loose end that they are late rather than forbidden, and that the owner's other
 * contact details are the way forward.
 *
 * @param {object} booking
 * @throws {AppError} 409.
 */
function assertThreadIsOpen(booking) {
  if (canMessage(booking)) return;

  if (booking.status === "COMPLETED") {
    throw conflict(
      `Messages close ${CHAT_GRACE_DAYS} days after a rental ends. You can still read this conversation.`
    );
  }

  throw conflict(
    "This booking is closed, so no new messages can be sent. You can still read the conversation."
  );
}

/**
 * The party who is not the actor.
 *
 * Extracted once it had a third caller. A booking names exactly two people, so "the
 * other one" is a single expression — but it was written out twice for the two
 * notification recipients, and a thread's counterparty is now also who presence and
 * read receipts are about. Three copies of a ternary is three places to get the sides
 * the wrong way round.
 *
 * @param {object} booking
 * @param {object} actor
 * @returns {string} The other party's user id.
 */
function counterpartyOf(booking, actor) {
  return roleInBooking(booking, actor) === "owner" ? booking.renter_id : booking.owner_id;
}

/**
 * The thread, and whether the caller may add to it.
 *
 * MARKS THE THREAD READ AS A SIDE EFFECT of fetching it, which is the honest
 * meaning of "opened the conversation" — a separate "mark read" call the client has
 * to remember is a call the client eventually forgets on one of its two screens.
 *
 * @param {string} bookingId
 * @param {object} actor
 * @param {object} [window] `{ since, before, limit }`.
 * @returns {Promise<{ messages: object[], canSend: boolean, bookingStatus: string,
 *          otherPartyId: string }>} (`closedReason` was named here and never
 *          returned; `canSend` plus `bookingStatus` is what callers actually read.)
 * @throws {AppError} 404 for anybody who is not a party.
 */
export async function listMessages(bookingId, actor, window = {}) {
  const booking = await loadBookingForParty(bookingId, actor);
  const messages = await findMessages(bookingId, window);

  // Only when reading the LIVE end of the thread. Paging back through history with
  // `before` must not mark anything read — somebody scrolling up to re-read an old
  // message has not seen the new one waiting at the bottom.
  if (!window.before) await markThreadRead(bookingId, actor.id);

  return {
    messages: messages.map(present),
    canSend: canMessage(booking),
    bookingStatus: booking.status,

    // WHO THE OTHER PARTY IS, so a caller can ask about them — their presence, and
    // how far they have read. Costs nothing: the booking is already loaded and this
    // is the same line `sendMessage` uses to pick a notification's recipient.
    //
    // An ID AND NOTHING ELSE, deliberately. Their name is already on the page that
    // renders this, and a service handing out more of somebody than the caller asked
    // for is how a projection stops being one.
    otherPartyId: counterpartyOf(booking, actor),
  };
}

/**
 * Records that the caller has read a thread up to now.
 *
 * ITS OWN ENTRY POINT BECAUSE READING IS NO LONGER IMPLIED BY FETCHING. While the
 * only way to see a message was to poll for it, `listMessages` marking the thread
 * read was exactly right — asking for the thread WAS opening it. A pushed message
 * arrives without anyone asking for anything, so "I have seen this" became a separate
 * statement the client has to make.
 *
 * @param {string} bookingId
 * @param {object} actor
 * @returns {Promise<{ bookingId: string, userId: string }>} Echoed back so the caller
 *          can broadcast it without re-deriving who it was about.
 * @throws {AppError} 404 for anybody who is not a party.
 */
export async function markThreadAsRead(bookingId, actor) {
  // Authorized like everything else here, and not skipped because it "only" writes a
  // timestamp: without it, anybody could move a stranger's read watermark and quietly
  // clear their unread badge.
  await loadBookingForParty(bookingId, actor);
  await markThreadRead(bookingId, actor.id);

  return { bookingId, userId: actor.id };
}

/**
 * Sends a message.
 *
 * @param {string} bookingId
 * @param {object} actor
 * @param {object} input
 * @param {string} [input.body]
 * @param {object} [input.file] `{ buffer, detectedMimeType }` from the upload middleware.
 * @returns {Promise<object>}
 * @throws {AppError} 404 / 409 / 400.
 */
export async function sendMessage(bookingId, actor, { body, file } = {}) {
  const booking = await loadBookingForParty(bookingId, actor);
  assertThreadIsOpen(booking);

  const text = body?.trim() || null;
  if (!text && !file) {
    throw badRequest("Write something, or attach a photo.", { body: "Cannot be empty" });
  }

  let attachment = null;
  let kind = "TEXT";

  if (file) {
    // Scoped to the booking, so the provider's folder tree groups a thread's
    // attachments the way `booking_photos` groups its evidence.
    const asset = await uploadPrivateAsset({ buffer: file.buffer, scope: `booking-${bookingId}` });
    attachment = {
      storageId: asset.storageId,
      // The SNIFFED type, never the client's claim — same rule as every other upload.
      mimeType: file.detectedMimeType ?? asset.mimeType,
      bytes: asset.bytes,
    };
    kind = "IMAGE";
  }

  const message = await insertMessage({
    bookingId,
    senderId: actor.id,
    kind,
    body: text,
    attachment,
  });

  // Sending is also reading: your own message must not leave you with an unread
  // badge on your own thread.
  await markThreadRead(bookingId, actor.id);

  const recipientId = counterpartyOf(booking, actor);
  await notifyNewMessage({ booking, recipientId, senderName: actor.name });

  const presented = present(message);

  // THE SECOND SIDE EFFECT, beside the notification above and under the same rule
  // (NFR-10): the row has already committed, so neither of them may fail this call.
  // The difference between them is only urgency — a notification is for somebody who
  // is not looking, this is for somebody who is.
  //
  // Published from the SERVICE rather than from either transport, which is the whole
  // reason both of them get it: this line fires for an HTTP POST and for a socket
  // `message:send` alike, so the two can never disagree about who was told.
  publishMessage(bookingId, presented);

  return presented;
}

/**
 * Shares the caller's own phone number into the thread, as a message.
 *
 * A MESSAGE RATHER THAN A FIELD ON THE BOOKING, and deliberately not the automatic
 * reveal-on-accept this product first considered. Making it an explicit act means
 * it is consensual, one-directional until the other party reciprocates, and — since
 * the thread is append-only — permanently recorded as having happened.
 *
 * The number is copied into the body rather than referenced, so it says what was
 * shared at the time even if the account's number changes later.
 *
 * @param {string} bookingId
 * @param {object} actor
 * @returns {Promise<object>}
 * @throws {AppError} 404 / 409 / 400.
 */
export async function shareContact(bookingId, actor) {
  const booking = await loadBookingForParty(bookingId, actor);
  assertThreadIsOpen(booking);

  if (!actor.phone) {
    throw badRequest("Add a phone number to your profile first.", {
      phone: "No number on your profile",
    });
  }

  const message = await insertMessage({
    bookingId,
    senderId: actor.id,
    kind: "CONTACT_SHARED",
    body: actor.phone,
  });

  await markThreadRead(bookingId, actor.id);

  const recipientId = counterpartyOf(booking, actor);
  await notifyNewMessage({ booking, recipientId, senderName: actor.name });

  const presented = present(message);
  publishMessage(bookingId, presented);

  return presented;
}

/**
 * The line a transition writes into the thread.
 *
 * NEUTRAL WORDING, unlike the notification map's. A notification is addressed to one
 * person ("Your booking was accepted"); a system line is read by both, so it states
 * the event rather than taking a side.
 *
 * Not every action gets one. DECLINE, CANCEL and EXPIRE all close the thread to new
 * messages anyway, and a closing line reading "Booking declined" above a box you can
 * no longer type in is worse than the box simply being gone — the booking's own
 * status is already on the page above it.
 */
export const SYSTEM_LINES = {
  ACCEPT: "Booking accepted.",
  START: "Owner marked the item as handed over.",
  CONFIRM_RECEIPT: "Renter confirmed they have the item.",
  RETURN: "Renter marked the item as returned.",
  COMPLETE: "Rental complete.",
};

/**
 * Writes a SYSTEM line into a thread — "Booking accepted", "Handed over".
 *
 * Gives the conversation a spine, so it reads as the story of the rental rather than
 * a detached box beside it. Never notifies: the transition that caused it already
 * sent its own notification, and a second one for the same event is noise.
 *
 * NEVER THROWS, for the same reason `notify` does not (FR-985). A booking must not
 * fail to be accepted because a decorative line could not be written.
 *
 * @param {string} bookingId
 * @param {string} text
 * @returns {Promise<void>}
 */
export async function postSystemMessage(bookingId, text) {
  try {
    const message = await insertMessage({ bookingId, senderId: null, kind: "SYSTEM", body: text });

    // Published like any other message, so "Booking accepted." appears in an open
    // thread the moment the owner accepts. It still never NOTIFIES — the transition
    // sent its own notification, and a second one for the same event is noise. A push
    // to a thread somebody is already looking at is not a second notification.
    publishMessage(bookingId, present(message));
  } catch (error) {
    console.error(`[messages] system line for ${bookingId} failed: ${error.message}`);
  }
}

/**
 * The inbox — every conversation the caller has.
 *
 * No authorization check of its own, and it does not need one: the query is scoped
 * to bookings the caller is a party to. There is no id coming in to be abused.
 *
 * @param {object} actor
 * @returns {Promise<{ threads: object[] }>}
 */
export async function listThreads(actor) {
  return { threads: await findThreads(actor.id) };
}

/**
 * Unread counts across every thread the caller is party to.
 *
 * @param {object} actor
 * @returns {Promise<{ total: number, byBooking: Record<string, number> }>}
 */
export async function getUnreadMessageCounts(actor) {
  return countUnreadMessages(actor.id);
}

/**
 * Reports a message.
 *
 * @param {string} bookingId
 * @param {string} messageId
 * @param {object} actor
 * @param {string} reason
 * @returns {Promise<{ reported: true }>}
 * @throws {AppError} 404.
 */
export async function reportMessage(bookingId, messageId, actor, reason) {
  await loadBookingForParty(bookingId, actor);

  const message = await findMessageById(messageId);
  // Scoped by booking as well as id, so knowing a uuid is not enough to report a
  // message in a thread the caller has nothing to do with.
  if (!message || message.booking_id !== bookingId) throw notFound("Message not found");

  if (message.sender_id === actor.id) {
    throw badRequest("You cannot report your own message.");
  }

  await insertMessageReport({ messageId, reportedBy: actor.id, reason });

  // Always the same answer, whether or not a row was written. A second press of the
  // button is not a stronger complaint, and telling somebody "you already reported
  // this" serves nobody.
  return { reported: true };
}

/**
 * One message, for a party to the booking, resolved for the attachment proxy.
 *
 * @param {string} bookingId
 * @param {string} messageId
 * @param {object} actor
 * @returns {Promise<object>}
 * @throws {AppError} 404.
 */
export async function getMessageForParty(bookingId, messageId, actor) {
  await loadBookingForParty(bookingId, actor);

  const message = await findMessageById(messageId);
  if (!message || message.booking_id !== bookingId) throw notFound("Message not found");
  return message;
}

/**
 * An attachment's bytes, for a party to the booking.
 *
 * STREAMED THROUGH THIS APPLICATION rather than redirecting to a signed URL, the
 * same decision condition photos made. A signed URL is a bearer credential: once it
 * reaches the browser it can be copied out of devtools, pasted, and it works for
 * anybody until it expires. Proxying means the check runs on every single fetch.
 *
 * @param {string} bookingId
 * @param {string} messageId
 * @param {object} actor
 * @returns {Promise<{ stream: ReadableStream, mimeType: string }>}
 * @throws {AppError} 404.
 */
export async function getAttachmentFile(bookingId, messageId, actor) {
  const message = await getMessageForParty(bookingId, messageId, actor);
  if (!message.storage_id) throw notFound("Attachment not found");

  const stream = await fetchPrivateAsset(message.storage_id);

  // Gone from the provider while its row survives. A 404 rather than a 500: the
  // caller can do nothing about either, and from outside they are the same answer.
  if (!stream) throw notFound("Attachment not found");

  return { stream, mimeType: message.mime_type ?? "application/octet-stream" };
}

/**
 * The client's view of a message.
 *
 * `storage_id` NEVER LEAVES THE SERVER — the client gets a boolean and fetches the
 * bytes through the proxy, exactly like a condition photo. A storage id in the DOM
 * is the first half of a leak.
 *
 * @param {object} row
 * @returns {object}
 */
function present(row) {
  const { storage_id, ...rest } = row;
  return { ...rest, hasAttachment: Boolean(storage_id) };
}

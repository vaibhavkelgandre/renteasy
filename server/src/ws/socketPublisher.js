/**
 * How the rest of the application pushes something to a live client.
 *
 * WHY THIS FILE EXISTS RATHER THAN SERVICES IMPORTING THE SERVER. `socketServer.js`
 * imports the handlers, the handlers import `messageService`, and `messageService`
 * needs to publish — so a service importing the server closes a cycle. This module
 * holds the reference instead: the server hands itself over once at boot, and every
 * publisher reads it from here. Nothing upstream knows Socket.IO exists.
 *
 * WHERE A PUBLISH BELONGS: beside the `notifyNewMessage` call that is already there,
 * and under the same rule (NFR-10, and the comment on `notificationService`) — it is a
 * SIDE EFFECT OF A WRITE THAT HAS ALREADY SUCCEEDED, so it must never throw and never
 * be awaited for correctness. A message that reached Postgres has been sent; whether
 * a socket happened to be holding the other end is not part of that.
 *
 * THE DATABASE REMAINS THE SOURCE OF TRUTH. Nothing here is the only copy of anything:
 * a client that missed a publish — offline, reconnecting, or never connected — asks
 * for what it missed with `since`, which is the same query the HTTP poll uses. That is
 * the whole reason this can be fire-and-forget.
 */

import { userRoom } from "./connectionRegistry.js";

/**
 * The live server, or null.
 *
 * NULL IS A FIRST-CLASS STATE, NOT AN ERROR, and this is the single most important
 * line in the file. Every one of the 340 existing integration tests drives `app`
 * through Supertest with no socket server anywhere — so `sendMessage` calling
 * `publishMessage` has to be a no-op in all of them. Throwing, or even warning, would
 * turn a feature addition into 340 failures with nothing actually wrong.
 *
 * It is also the honest production state twice: before `createSocketServer` runs, and
 * after shutdown has dropped it.
 */
let server = null;

/**
 * Hands the socket server over. Called once, by `createSocketServer`.
 *
 * @param {import("socket.io").Server | null} io Null on shutdown, so a publish racing
 *        a drain does not reach a server that is closing.
 * @returns {void}
 */
export function setSocketServer(io) {
  server = io;
}

/**
 * Exported so the disconnect handler can pick a socket's booking rooms out of
 * `socket.rooms`, which also holds its own id and its `user:` room.
 *
 * A shared constant rather than the same literal in two files: a room name fails
 * SILENTLY when it is wrong — an emit that reaches nobody, and no error anywhere.
 */
export const BOOKING_ROOM_PREFIX = "booking:";

/**
 * The room holding everybody currently reading one booking's thread.
 *
 * Joined on request and authorized when joined (see `threadHandlers.js`), unlike
 * `userRoom`, which a socket joins automatically because it needs no permission to
 * address its own owner.
 *
 * @param {string} bookingId
 * @returns {string}
 */
export function bookingRoom(bookingId) {
  return `${BOOKING_ROOM_PREFIX}${bookingId}`;
}

/**
 * Pushes a notification to every device its recipient has open.
 *
 * Addressed to the PERSON rather than to a thread, which is why it uses `userRoom`:
 * a notification is about something that happened elsewhere in the app, so the
 * recipient is by definition not looking at the page it concerns.
 *
 * Called from `notificationService`'s single `notify` choke point, so every
 * notification type — present and future — reaches the bell without its own wiring.
 * Same rule as `publishMessage`: the row is already written, so this must never throw.
 *
 * @param {string} userId The recipient.
 * @param {object} notification The row, as `NOTIFICATION_COLUMNS` returns it.
 * @returns {void}
 * @throws Never.
 */
export function publishNotification(userId, notification) {
  if (!server) return;

  try {
    server.to(userRoom(userId)).emit("notification:new", { notification });
  } catch (error) {
    console.error(`[ws] notification publish to ${userId} failed: ${error.message}`);
  }
}

/**
 * Pushes a new message to everyone reading that thread.
 *
 * SENT TO THE WHOLE ROOM, INCLUDING THE SENDER, which looks like a bug and is not.
 * The sender's OTHER tabs must receive it, and there is no way to say "every socket of
 * this person except the one that asked" from here — the service does not know which
 * socket, or whether the write even came from a socket rather than the HTTP route.
 * Clients therefore merge by message id and ignore one they already hold, which is the
 * same rule that lets a socket update and a poll response overlap harmlessly.
 *
 * @param {string} bookingId
 * @param {object} message Already through `present()` — so it carries `hasAttachment`
 *        and never `storage_id`. Publishing a raw row would put a storage id in the
 *        DOM, which is the first half of a leak.
 * @returns {void}
 * @throws Never.
 */
export function publishMessage(bookingId, message) {
  if (!server) return;

  try {
    server.to(bookingRoom(bookingId)).emit("message:new", { bookingId, message });
  } catch (error) {
    // Logged and swallowed, exactly as every `notify*` helper does. The write has
    // already committed and been answered; failing the caller now would report a
    // message that exists as a message that failed.
    console.error(`[ws] publish to ${bookingId} failed: ${error.message}`);
  }
}

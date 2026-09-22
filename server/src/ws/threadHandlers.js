/**
 * What a client may ask for over a socket: join a thread, leave it, send a message.
 *
 * THIS IS A CONTROLLER, and it is written to be exactly that — the same job
 * `messageController.js` does for HTTP. It unpacks a payload, validates it, calls the
 * service, and shapes the answer. There is no business logic here and no
 * authorization rule of its own: `messageService` runs `loadBookingForParty` on every
 * call, so a stranger gets the same 404 over a socket that they get over HTTP, from
 * the same line of code.
 *
 * THE ONE THING GENUINELY DIFFERENT FROM A CONTROLLER: a socket has no middleware
 * chain, so `requireAuth`'s database read does not happen on its own. Each handler
 * therefore re-reads the actor — see `currentActor` below.
 *
 * SENDING A MESSAGE STAYS AVAILABLE OVER HTTP TOO, and neither path is a copy of the
 * other: both call `messageService.sendMessage`. That function is where "who may
 * write to this thread" is decided, so the two transports cannot drift into
 * disagreeing about it. Attachments are HTTP only — the multipart route already owns
 * the magic-byte sniffing and the size limit, and a file has no business being
 * reassembled out of socket frames.
 */

import { listMessages, markThreadAsRead, sendMessage } from "../services/messageService.js";
import {
  messageQuerySchema,
  sendMessageSchema,
  socketBookingSchema,
  typingSchema,
} from "../validators/messageValidator.js";
import { validatePayload } from "../validators/validate.js";
import { findReadWatermark } from "../repositories/messageRepository.js";
import { findPresenceById, findUserById } from "../repositories/userRepository.js";
import { badRequest, notFound, unauthorized } from "../utils/errors.js";
import { isOnline } from "./connectionRegistry.js";
import { bookingRoom } from "./socketPublisher.js";
import { READ_LIMIT, TYPING_LIMIT, withinRateLimit } from "./socketRateLimit.js";

/**
 * The acknowledgement envelope.
 *
 * DELIBERATELY `utils/response.js`'s TWO SHAPES, so the client's existing error
 * handling works unchanged — the point of having one envelope is that a caller never
 * guesses per endpoint, and a second transport must not reintroduce the guessing.
 *
 * ONE FIELD DIFFERS: `status`. Over HTTP the code lives in the response line, which an
 * acknowledgement does not have — so without it, a socket reply would be strictly less
 * informative than the HTTP reply it mirrors, and a client could not tell a 409
 * (this thread is closed) from a 404 (no such booking).
 */
function ok(data) {
  return { success: true, status: 200, message: "OK", data };
}

/**
 * Turns a thrown error into a refusal the client can read.
 *
 * The `expose` gate and the log-5xx-only rule are both copied from app.js's error
 * handler, for the reasons written there: an unexpected error's message is not ours to
 * publish, and logging expected refusals buries the real failures — in the test suite
 * as much as in production.
 *
 * @param {Error & { status?: number, expose?: boolean, errors?: object }} error
 * @returns {object}
 */
function fail(error) {
  const status = error.status ?? 500;

  if (status >= 500) console.error("[ws]", error);

  return {
    success: false,
    status,
    message: error.expose ? error.message : "Something went wrong",
    errors: error.expose ? (error.errors ?? {}) : {},
  };
}

/**
 * Calls the client's acknowledgement callback, if it supplied one.
 *
 * An `emit` with no callback is legal and ordinary, so this must not assume one. The
 * guard is also why `thread:leave` needs no reply at all.
 *
 * @param {unknown} ack Whatever arrived in the callback position.
 * @param {object} payload
 * @returns {void}
 */
function respond(ack, payload) {
  if (typeof ack === "function") ack(payload);
}

/**
 * Re-reads the connected user from the database.
 *
 * THE OTHER HALF OF NFR-5, and the reason it is per event rather than per connection.
 * `socketAuth.js` established who opened this socket, possibly hours ago; an HTTP
 * request would have re-read the row on every single call. Doing the same here costs
 * one query per event — exactly what the equivalent HTTP request already pays, so this
 * is parity and not a new cost — and it means a suspended account stops being able to
 * act immediately, instead of when the five-minute sweep next runs.
 *
 * `socket.data.user` is refreshed rather than only checked, so a handler downstream
 * never works from a stale name or verification state.
 *
 * @param {import("socket.io").Socket} socket
 * @returns {Promise<object>} The current user row.
 * @throws {AppError} 401 if the account is gone or no longer ACTIVE.
 */
async function currentActor(socket) {
  const user = await findUserById(socket.data.user.id);
  if (!user || user.status !== "ACTIVE") throw unauthorized();

  socket.data.user = user;
  return user;
}

/**
 * Runs a handler, answers the client, and drops the socket if the session died.
 *
 * DISCONNECTING ON A 401 IS THE POINT. Over HTTP a 401 ends the request and the next
 * one fails the same way; a socket would otherwise sit there authenticated-by-history,
 * still in its rooms, still receiving every published message. Closing it is the
 * socket equivalent of the session simply no longer working — and the client's
 * reconnect attempt then fails at the handshake, which is where that answer belongs.
 *
 * @param {import("socket.io").Socket} socket
 * @param {unknown} ack
 * @param {(actor: object) => Promise<object>} work Receives the freshly-read actor.
 * @returns {Promise<void>}
 * @throws Never. A socket handler that rejects is an unhandled rejection, which ends
 *         the process.
 */
async function handle(socket, ack, work) {
  try {
    const actor = await currentActor(socket);
    respond(ack, ok(await work(actor)));
  } catch (error) {
    respond(ack, fail(error));
    if ((error.status ?? 500) === 401) socket.disconnect(true);
  }
}

/**
 * Everything the caller needs to render the other side of a conversation.
 *
 * ONLY ON JOIN, never on the HTTP list. Both lookups are cheap but neither is free,
 * and `listMessages` is also what the 3-second fallback poll calls — adding two
 * queries there would make the degraded path more expensive than the one it replaced.
 * A socket asks once and is then told about changes.
 *
 * `online` COMES FROM MEMORY, NOT THE DATABASE. Being online is having a live socket
 * in this process, which no row can truthfully record — see migration 012. So
 * `last_seen_at` is read only to answer "and if not, when were they last here".
 *
 * @param {string} bookingId
 * @param {string} otherPartyId
 * @returns {Promise<{ id: string, online: boolean, lastSeenAt: Date|null, readAt: Date|null }>}
 * @throws {Error} On a database failure.
 */
async function describeOtherParty(bookingId, otherPartyId) {
  const online = isOnline(otherPartyId);

  // Skipped entirely while they are online, because the answer is not shown then —
  // "last seen" only has a reader when somebody is absent.
  const presence = online ? null : await findPresenceById(otherPartyId);

  return {
    id: otherPartyId,
    online,
    lastSeenAt: presence?.last_seen_at ?? null,

    // How far they have read OUR messages, so receipts survive a reload. Without it,
    // a message would show as read only if you happened to be watching when they
    // opened it, and would forget again the moment you refreshed.
    readAt: await findReadWatermark(bookingId, otherPartyId),
  };
}

/**
 * Wires one connection's thread events.
 *
 * Called once per socket, from `socketServer.js`'s connection handler.
 *
 * @param {import("socket.io").Socket} socket
 * @returns {void}
 */
export function registerThreadHandlers(socket) {
  /**
   * `thread:join` — start receiving a thread, and catch up on what was missed.
   *
   * ONE EVENT DOES THREE JOBS, and that is why it reuses `listMessages` rather than
   * having a service function of its own: authorizing the caller, replaying the gap,
   * and reporting whether the thread is still writable are the three things that
   * function already returns. Joining the room afterwards is the only new line.
   *
   * IT IS THE RECONNECT PATH AS WELL AS THE FIRST JOIN. A client that was offline
   * sends the `created_at` of the newest message it holds as `since`, and the reply
   * carries only what it does not have — which is the same `?since=` contract the
   * 3-second poll uses. The transport changed; the question did not.
   *
   * The window is validated with `messageQuerySchema`, the identical schema the HTTP
   * GET uses, so the two cannot diverge on what a legal window is.
   */
  socket.on("thread:join", (payload, ack) =>
    handle(socket, ack, async (actor) => {
      const { bookingId } = validatePayload(socketBookingSchema, payload, () =>
        // 404 with no field detail, matching `validateParams`: from outside, "that id
        // is the wrong shape" and "no such booking" are the same answer, and the
        // message must be the one the service itself uses or the pair is an oracle.
        notFound("Booking not found")
      );

      const window = validatePayload(messageQuerySchema, payload, (errors) =>
        badRequest("Invalid query parameters", errors)
      );

      // BEFORE joining the room. `listMessages` throws 404 for anyone who is not a
      // party, so a caller who is refused never becomes a member of the room and
      // never receives a publish. Joining first and authorizing second would deliver
      // one message to a stranger before the refusal landed.
      const thread = await listMessages(bookingId, actor, window);
      const room = bookingRoom(bookingId);

      socket.join(room);

      // TELLS THE PERSON ALREADY IN THE ROOM THAT WE ARE HERE. Presence is broadcast
      // on join rather than on connect because a connection is not attached to any
      // conversation yet — and it is scoped to this room because that is the whole
      // privacy rule: you learn I am online because we have a booking together, not
      // because you looked me up.
      //
      // `socket.to(room)` excludes the sender, who does not need telling.
      //
      // KNOWN ASYMMETRY, AND IT IS THE CHEAP END OF A REAL TRADE. "Online" means "has
      // the app open somewhere" (`isOnline`, a global answer), while this event only
      // fires when somebody OPENS A CONVERSATION. So if the other party connects and
      // goes to their inbox instead, nobody watching this thread is told, and it keeps
      // showing them as away until they open it or the page is reloaded.
      //
      // Closing it properly would mean notifying, on every connect, each room for each
      // booking that person has — which is a query per connection to answer a question
      // nobody asked, or else redefining "online" as "in this room", which is then
      // wrong for somebody who is plainly around and reading something else. The lag
      // is one-directional and resolves itself the moment they look at the thread,
      // which is also the moment it starts to matter.
      socket.to(room).emit("presence:changed", { bookingId, userId: actor.id, online: true });

      return { ...thread, otherParty: await describeOtherParty(bookingId, thread.otherPartyId) };
    })
  );

  /**
   * `thread:leave` — stop receiving it.
   *
   * NO AUTHORIZATION AND NO ACKNOWLEDGEMENT, both deliberate. Leaving a room you were
   * never in is a no-op in Socket.IO, so there is nothing an attacker gains and
   * nothing to refuse; and the client emits this while unmounting, where there is
   * nobody left to receive a reply.
   *
   * Validated all the same, because an unvalidated value here would build a room name
   * out of arbitrary client input.
   */
  socket.on("thread:leave", (payload) => {
    const parsed = socketBookingSchema.safeParse(payload);
    if (parsed.success) socket.leave(bookingRoom(parsed.data.bookingId));
  });

  /**
   * `message:send` — post a text message.
   *
   * The service publishes to the room, so this acknowledgement is NOT how the message
   * reaches anybody: it is how the sender learns their own message was accepted, and
   * what id it was given. The sender is in the room too and will receive the broadcast
   * as well — clients merge by id, so holding both is harmless.
   *
   * `sendMessageSchema` is reused with `body` still OPTIONAL, even though a socket
   * cannot carry an attachment, because the service already refuses "neither a body
   * nor a file" with a message written for a human ("Write something, or attach a
   * photo."). Tightening the schema here would answer the same case with a generic
   * validation error instead.
   */
  socket.on("message:send", (payload, ack) =>
    handle(socket, ack, async (actor) => {
      const { bookingId } = validatePayload(socketBookingSchema, payload, () =>
        notFound("Booking not found")
      );

      const { body } = validatePayload(sendMessageSchema, payload, (errors) =>
        badRequest("Validation failed", errors)
      );

      return { message: await sendMessage(bookingId, actor, { body }) };
    })
  );

  /**
   * `thread:typing` — relay that somebody is composing.
   *
   * NEVER PERSISTED, NEVER REPLAYED, NEVER ACKNOWLEDGED. Typing is true only for the
   * instant it is delivered; a typing state that survived a reload, or arrived in a
   * catch-up after a reconnect, would show somebody composing a message they finished
   * ten minutes ago. It is the one thing in this file that is pure transport.
   *
   * RELAYED WITHOUT RE-READING THE ACTOR, unlike every other handler — deliberately.
   * `currentActor`'s per-event database read exists to stop a stale session ACTING;
   * this changes nothing and grants nothing, and paying a query per keystroke to
   * confirm the right to say "typing" would make the cheapest event in the app the
   * most expensive. Room membership is the authorization, and that was checked at
   * join.
   *
   * THE NAME COMES FROM THE HANDSHAKE, so the client needs no lookup to render "Rohan
   * is typing" — and it is the only field here that is not already on their screen.
   */
  socket.on("thread:typing", (payload) => {
    // Dropped silently when over the limit. There is no acknowledgement to refuse
    // through, and a client hitting this ceiling is either broken or hostile —
    // neither is owed an explanation, and disconnecting them over a typing ping
    // would turn a cosmetic feature into a way to drop somebody's connection.
    if (!withinRateLimit(socket, "thread:typing", TYPING_LIMIT)) return;

    const parsed = typingSchema.safeParse(payload);
    if (!parsed.success) return;

    const { bookingId, isTyping } = parsed.data;
    const room = bookingRoom(bookingId);

    // NOT IN THE ROOM, NOT RELAYED. `socket.rooms` is the membership `thread:join`
    // authorized, so checking it here is what stops an unjoined socket from
    // broadcasting into a conversation it was refused.
    if (!socket.rooms.has(room)) return;

    socket.to(room).emit("thread:typing", {
      bookingId,
      userId: socket.data.user.id,
      name: socket.data.user.name,
      isTyping,
    });
  });

  /**
   * `thread:read` — the caller has seen everything up to now.
   *
   * ITS OWN EVENT BECAUSE FETCHING NO LONGER IMPLIES READING. While a message could
   * only arrive by being asked for, `listMessages` moving the watermark was exact. A
   * pushed message arrives unasked, so the client now has to say when somebody
   * actually looked — and it only says so when the tab is visible, which quietly
   * fixes an older bug: a thread left open in a BACKGROUND tab used to keep polling,
   * and every poll marked it read while nobody was looking.
   *
   * Broadcast to the room so the other party's messages can show as seen.
   */
  socket.on("thread:read", (payload, ack) => {
    if (!withinRateLimit(socket, "thread:read", READ_LIMIT)) return;

    void handle(socket, ack, async (actor) => {
      const { bookingId } = validatePayload(socketBookingSchema, payload, () =>
        notFound("Booking not found")
      );

      // Authorized in the service, not by room membership — this one writes, so it
      // gets the same `loadBookingForParty` check every other write gets rather than
      // trusting a room the socket could have joined for another reason.
      const read = await markThreadAsRead(bookingId, actor);

      socket.to(bookingRoom(bookingId)).emit("thread:read", { ...read, readAt: new Date().toISOString() });

      return read;
    });
  });
}

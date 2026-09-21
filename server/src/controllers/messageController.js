/**
 * HTTP for booking messages.
 *
 * Every endpoint is scoped by the service via `loadBookingForParty`, so a stranger
 * gets 404 rather than 403 — the same answer the rest of the booking surface gives.
 */

import {
  listMessages,
  sendMessage,
  shareContact,
  reportMessage,
  getUnreadMessageCounts,
  getAttachmentFile,
  listThreads,
} from "../services/messageService.js";
import { sendSuccess } from "../utils/response.js";

/**
 * GET /api/bookings/messages/threads — the inbox.
 *
 * Takes no id, so there is nothing to scope: the query only ever returns bookings
 * the caller is a party to.
 */
export async function getThreads(req, res, next) {
  try {
    sendSuccess(res, { message: "OK", data: await listThreads(req.user) });
  } catch (error) {
    next(error);
  }
}

/** GET /api/bookings/:id/messages */
export async function getMessages(req, res, next) {
  try {
    const thread = await listMessages(req.validatedParams.id, req.user, req.validatedQuery);
    sendSuccess(res, { message: "OK", data: thread });
  } catch (error) {
    next(error);
  }
}

/** POST /api/bookings/:id/messages — JSON, or multipart with one `attachment`. */
export async function postMessage(req, res, next) {
  try {
    const message = await sendMessage(req.validatedParams.id, req.user, {
      body: req.body?.body,
      // `req.file` is multer's single-file shape; absent for a plain text message.
      file: req.file,
    });
    sendSuccess(res, { status: 201, message: "Sent", data: { message } });
  } catch (error) {
    next(error);
  }
}

/** POST /api/bookings/:id/messages/share-contact */
export async function postShareContact(req, res, next) {
  try {
    const message = await shareContact(req.validatedParams.id, req.user);
    sendSuccess(res, { status: 201, message: "Contact shared", data: { message } });
  } catch (error) {
    next(error);
  }
}

/** POST /api/bookings/:id/messages/:messageId/report */
export async function postReportMessage(req, res, next) {
  try {
    const { id, messageId } = req.validatedParams;
    const result = await reportMessage(id, messageId, req.user, req.body.reason);
    sendSuccess(res, { message: "Reported. Thank you — we will look into it.", data: result });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/bookings/messages/unread-count
 *
 * Its own endpoint, like the notification count and for the same reason: the
 * bookings list badges every row, and one count per row would be an N+1 growing
 * with somebody's rental history.
 */
export async function getUnreadMessages(req, res, next) {
  try {
    sendSuccess(res, { message: "OK", data: await getUnreadMessageCounts(req.user) });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/bookings/:id/messages/:messageId/file
 *
 * Streams the bytes rather than redirecting to a signed URL — a signed URL in the
 * browser is a bearer credential that works for anyone holding it until it expires.
 */
export async function getMessageAttachment(req, res, next) {
  try {
    const { id, messageId } = req.validatedParams;
    const { stream, mimeType } = await getAttachmentFile(id, messageId, req.user);

    res.set("Content-Type", mimeType);
    // `private` so no shared cache holds something whose access depends on who asked.
    res.set("Cache-Control", "private, max-age=300");
    // Generic filename: the stored id is not the caller's business, and a real one
    // would leak whatever the uploader's phone called it.
    res.set("Content-Disposition", 'inline; filename="attachment"');

    const { Readable } = await import("node:stream");
    Readable.fromWeb(stream).pipe(res);
  } catch (error) {
    next(error);
  }
}

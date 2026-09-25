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
import { assertRealImages } from "../middlewares/uploadMiddleware.js";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

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
    // Same guard the listing- and booking-photo controllers already apply, and for
    // the identical reason: multer's own `fileFilter` only ever sees the
    // client-declared mimetype and filename, both attacker-supplied. This sniffs the
    // real bytes and stamps `file.detectedMimeType`, which sendMessage/cloudinary
    // storage use instead of trusting the upload. Skipped entirely when there is no
    // file — `assertRealImages` takes an array, and a plain text message has none.
    if (req.file) assertRealImages([req.file]);

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

    // `pipeline`, never bare `.pipe()`. `.pipe()` only forwards DATA — an error on
    // either stream (Cloudinary resetting mid-transfer, the client disconnecting)
    // fires an `'error'` event with no listener, which Node treats as an uncaught
    // exception and kills the whole process. `pipeline` forwards errors from either
    // side into this `await`, and destroys both streams on failure so a dropped
    // client doesn't leak the still-open upstream response body.
    await pipeline(Readable.fromWeb(stream), res);
  } catch (error) {
    // If bytes have already reached the client, the response is no longer ours to
    // reshape into a JSON error envelope — `res.status().json()` would itself throw
    // trying to set a header after Node has already sent the head. Ending the
    // connection is the only honest option left at that point.
    if (res.headersSent) {
      res.destroy(error);
      return;
    }
    next(error);
  }
}

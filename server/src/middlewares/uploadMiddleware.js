/**
 * Accepting image uploads — FR-105.
 *
 * MEMORY STORAGE, NOT DISK, and that is a decision rather than a default. Bytes that
 * never touch our filesystem cannot be left behind by a request that dies halfway, and
 * there is no upload directory to permission, to fill up, or to accidentally serve.
 * The whole point of object storage is that the app server holds nothing.
 *
 * Multer enforces SIZE and COUNT here, because those are cheap and belong at the edge —
 * a 400MB request should be refused before any handler sees it. It deliberately does
 * NOT decide what a file is: see `assertRealImages` below.
 */

import multer from "multer";
import { badRequest } from "../utils/errors.js";
import { sniffImageType, ACCEPTED_IMAGE_TYPES } from "../utils/imageType.js";

/** A phone photo is 3–5MB, so this bounds a request without restricting anyone. */
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

/** FR-105. Enough to show an item properly; few enough to keep a page fast. */
export const MAX_PHOTOS_PER_LISTING = 8;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_PHOTO_BYTES,
    files: MAX_PHOTOS_PER_LISTING,

    // Without this, a request can carry unlimited non-file fields and multer will
    // happily buffer them all. A LISTING photo upload needs no text fields at all,
    // so zero is right here — booking photos, which do, get their own parser below
    // rather than relaxing this one.
    fields: 0,
  },
});

/** A booking carries fewer photos per upload than a listing does: one moment, not a gallery. */
export const MAX_PHOTOS_PER_UPLOAD = 6;

/**
 * The same parser, but allowing the two text fields a condition photo needs.
 *
 * A SEPARATE INSTANCE RATHER THAN RAISING `fields` ON THE SHARED ONE. The listing
 * endpoint genuinely accepts no text at all, and that zero is a real limit on what an
 * unauthenticated-ish multipart body can make the server buffer; widening it for
 * every caller to suit one would trade that away for nothing.
 *
 * `fields: 2` is exactly `phase` and `note`. A third would be a mistake worth
 * catching, and LIMIT_FIELD_COUNT is mapped below so it says so.
 */
const bookingUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PHOTO_BYTES, files: MAX_PHOTOS_PER_UPLOAD, fields: 2 },
});

/**
 * Parses `multipart/form-data` for booking condition photos — FR-702.
 *
 * @type {import("express").RequestHandler}
 */
export const acceptBookingPhotos = bookingUpload.array("photos", MAX_PHOTOS_PER_UPLOAD);

/**
 * Parses `multipart/form-data` with up to eight files under the field name `photos`.
 *
 * @type {import("express").RequestHandler}
 */
export const acceptPhotos = upload.array("photos", MAX_PHOTOS_PER_LISTING);

/**
 * Turns multer's own errors into this API's envelope.
 *
 * Without it a `LIMIT_FILE_SIZE` reaches the generic error handler as an unrecognised
 * error and answers 500 — telling the user the server is broken when in fact their
 * photo is simply too big, which is something they can act on.
 *
 * @type {import("express").ErrorRequestHandler}
 */
export function handleUploadErrors(error, _req, _res, next) {
  if (!(error instanceof multer.MulterError)) return next(error);

  const messages = {
    LIMIT_FILE_SIZE: `Each photo must be under ${MAX_PHOTO_BYTES / 1024 / 1024}MB.`,
    LIMIT_FILE_COUNT: `A listing can have at most ${MAX_PHOTOS_PER_LISTING} photos.`,
    LIMIT_UNEXPECTED_FILE: 'Upload photos using the field name "photos".',

    // Mapped because its absence cost a debugging session: a booking photo upload
    // sent `phase` as a text field against a parser configured `fields: 0`, and the
    // resulting LIMIT_FIELD_COUNT fell through to the generic "that upload could not
    // be read" — which says nothing about the actual cause and sends you looking at
    // the image.
    LIMIT_FIELD_COUNT: "That upload carried unexpected form fields.",
    LIMIT_PART_COUNT: "That upload carried too many parts.",
  };

  return next(badRequest(messages[error.code] ?? "That upload could not be read.", { photos: messages[error.code] ?? "That upload could not be read." }));
}

/**
 * Verifies every uploaded file is REALLY one of the accepted image formats.
 *
 * Separate from multer's `fileFilter` on purpose, and this is the important part:
 * multer's filter runs while the file is still streaming, so all it can inspect is the
 * client-declared `mimetype` and the filename. Both are attacker-supplied. This runs
 * after the bytes are in memory, so it can read the actual signature.
 *
 * Rejecting the WHOLE request rather than skipping bad files: a listing that silently
 * came out with three photos when four were chosen is a bug the user cannot see or
 * explain.
 *
 * @param {Express.Multer.File[]} files
 * @returns {void}
 * @throws {AppError} 400 naming the offending file.
 */
export function assertRealImages(files) {
  for (const file of files) {
    const actualType = sniffImageType(file.buffer);

    if (!actualType) {
      throw badRequest(`"${file.originalname}" is not a ${ACCEPTED_IMAGE_TYPES} image.`, {
        photos: `"${file.originalname}" is not a ${ACCEPTED_IMAGE_TYPES} image.`,
      });
    }

    // The sniffed type replaces whatever the client claimed, everywhere downstream.
    // Storing the client's value would put an attacker-chosen string in a column the
    // frontend later uses to decide how to render.
    file.detectedMimeType = actualType;
  }
}

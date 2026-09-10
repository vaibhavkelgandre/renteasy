/**
 * What a file actually IS, read from its first bytes.
 *
 * NEVER THE EXTENSION, NEVER THE CLIENT'S `Content-Type`. Both are supplied by whoever
 * is uploading, so both are claims rather than facts — `payload.php` renamed to
 * `holiday.jpg` arrives with an extension of `.jpg` and a `Content-Type` of
 * `image/jpeg`, because the uploader chose them.
 *
 * The bytes at the start of the file are the one part the format itself dictates.
 */

/**
 * The three raster formats this product accepts.
 *
 * SVG IS DELIBERATELY ABSENT and must stay absent. It is a document, not an image: it
 * can carry `<script>`, and it would be served from our own CDN domain — so accepting
 * one is accepting stored XSS with our domain's trust attached to it. Nothing about a
 * rental listing needs vector graphics.
 */
const SIGNATURES = [
  { mimeType: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  { mimeType: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
];

/**
 * Identifies an image from its leading bytes.
 *
 * @param {Buffer} buffer The whole file, or at least its first 12 bytes.
 * @returns {string | null} A MIME type, or null when it is not one of the three
 *          accepted formats — including when it is a perfectly valid image of some
 *          other kind. "Not something we take" and "not an image" are the same answer
 *          to the caller.
 */
export function sniffImageType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;

  for (const { mimeType, bytes } of SIGNATURES) {
    if (bytes.every((byte, index) => buffer[index] === byte)) return mimeType;
  }

  // WebP needs two checks in two places, which is why it is not in the table above:
  // the container is RIFF (shared with .wav and .avi) and only bytes 8–11 say which
  // kind of RIFF file it is. Checking "RIFF" alone would accept an audio file.
  if (buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    return "image/webp";
  }

  return null;
}

/** Human-readable list for an error message, so the rule is stated once. */
export const ACCEPTED_IMAGE_TYPES = "JPEG, PNG or WebP";

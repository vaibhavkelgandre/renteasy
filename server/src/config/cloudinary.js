/**
 * The only module that knows where images physically live.
 *
 * It exports FUNCTIONS, not a configured client — the same deviation `config/mailer.js`
 * makes, for the same reason. Handing callers a provider object leaks that provider's
 * shape into every call site, and docs/6.media-storage.md §3 names a specific migration
 * we might make (Cloudflare R2, if bandwidth ever becomes the binding cost). Keeping
 * the surface to `upload / destroy / url` is what keeps that a one-file change.
 *
 * Three behaviours, chosen the same way the mailer chooses:
 *
 *   test                     → an in-memory fake. Never touches the network.
 *   configured               → Cloudinary
 *   not configured           → refuses, so a missing key is a loud failure at the
 *                              first upload rather than a silent one at deploy
 *
 * WHY THE SDK, when mailer.js deliberately has none: Brevo's send is one JSON POST, so
 * a package would buy nothing. A Cloudinary upload is a multipart POST whose signature
 * is a SHA-1 over sorted parameters — a real algorithm with a real chance of getting it
 * subtly wrong, and a wrong signature fails identically to a wrong key. The SDK is the
 * reference implementation of exactly that. The wrapper below is what stops it
 * spreading.
 */

import { v2 as cloudinary } from "cloudinary";
import { env } from "./env.js";

/** Everything lands under one prefix, so a sweep can list "our" assets. */
const LISTINGS_FOLDER = "renteasy/listings";

/**
 * Private assets — condition photos today, identity documents when trust tiers land.
 *
 * A SEPARATE FOLDER FROM LISTINGS, and not only for tidiness: if the delivery type of
 * these ever has to be audited or bulk-changed, "everything under renteasy/private"
 * is a question the provider can answer. "Everything that happens to have been
 * uploaded with type authenticated" is not.
 */
const PRIVATE_FOLDER = "renteasy/private";

/** How long a minted private URL is good for. */
const PRIVATE_URL_TTL_SECONDS = 5 * 60;

/** @type {Array<{ storageId: string, bytes: number, folder: string }>} */
const fakeUploads = [];

/** Every asset "uploaded" during a test run. */
export function getFakeUploads() {
  return fakeUploads;
}

/** Empties the fake store. Called between tests. */
export function clearFakeUploads() {
  fakeUploads.length = 0;
}

/**
 * Whether there is enough configuration to reach the provider.
 *
 * All three together, never two of three. A half-filled environment is the common
 * `.env` state, and Cloudinary answers a missing secret with an authentication error
 * that reads exactly like a wrong one.
 *
 * @returns {boolean}
 */
export function isMediaConfigured() {
  return Boolean(env.cloudinaryCloudName && env.cloudinaryApiKey && env.cloudinaryApiSecret);
}

/** Configures the SDK lazily, so importing this module never requires credentials. */
function client() {
  cloudinary.config({
    cloud_name: env.cloudinaryCloudName,
    api_key: env.cloudinaryApiKey,
    api_secret: env.cloudinaryApiSecret,
    secure: true,
  });
  return cloudinary;
}

/**
 * The upload options for a listing photo.
 *
 * EXTRACTED SO IT CAN BE TESTED. Under NODE_ENV=test the uploader returns a fake and
 * never builds these, so nothing would notice if the EXIF-stripping transformation were
 * deleted — which is exactly how the previous version of this shipped broken for a
 * fortnight. `cloudinary.test.js` asserts on what this returns.
 *
 * @param {string} listingId
 * @returns {object} Options for `uploader.upload_stream`.
 */
export function listingUploadOptions(listingId) {
  return {
    folder: `${LISTINGS_FOLDER}/${listingId}`,

    // PUBLIC, and this is a deliberate decision rather than a default — see
    // docs/6.media-storage.md §4. Signing a listing photo would be a bug, not extra
    // safety: a signed URL expires, so the CDN cannot cache it, every visitor
    // re-fetches from origin, and a grid of twenty listings needs twenty freshly
    // minted URLs per page load. The content is public by design.
    type: "upload",

    resource_type: "image",

    // STRIPS EXIF, AND THIS IS A SAFETY CONTROL, NOT AN OPTIMISATION.
    //
    // A phone photo carries GPS coordinates. Publishing a listing photo with them
    // intact publishes the owner's home address to anyone who downloads it — the
    // difference between "someone wants to rent my camera" and "someone knows where I
    // keep it".
    //
    // THIS IS AN INCOMING TRANSFORMATION, AND IT HAS TO BE. The first version passed
    // `image_metadata: false`, which reads like the right thing and is not: that
    // parameter controls whether the API *returns* metadata in its response, not
    // whether the stored asset keeps it. Cloudinary strips metadata from DERIVED
    // images, so the thumbnails this app serves were clean either way — but the
    // untransformed original stayed retrievable at `/image/upload/<public_id>` with the
    // coordinates intact, and the public_id is right there in the page's HTML.
    //
    // An incoming transformation REPLACES the stored original with the transformed
    // version, so there is no original left to hold them. Verified by uploading a file
    // with a known Exif GPS marker and re-downloading the stored bytes: 246 bytes in,
    // 160 out, marker gone.
    //
    // `quality: auto:good` is what forces the re-encode even for an image already under
    // the size limit — `c_limit` alone only acts when something is too big, so a small
    // photo would pass straight through. `strip_profile` drops the colour profile too.
    transformation: [
      { width: 2400, height: 2400, crop: "limit", quality: "auto:good", flags: "strip_profile" },
    ],

    // Belt and braces against a file that passed our own sniffing but is not really an
    // image: Cloudinary refuses anything it cannot decode as one.
    allowed_formats: ["jpg", "jpeg", "png", "webp"],
  };
}

/**
 * The upload options for a PRIVATE asset.
 *
 * Extracted and exported for the same reason `listingUploadOptions` is: under test the
 * uploader returns a fake and never builds these, so a mistake in here would be
 * invisible to the whole suite. `cloudinary.test.js` asserts on what this returns —
 * and on this one, `type` is the assertion that matters most.
 *
 * @param {string} scope A folder segment grouping related assets, e.g. a booking id.
 * @returns {object} Options for `uploader.upload_stream`.
 */
export function privateUploadOptions(scope) {
  return {
    folder: `${PRIVATE_FOLDER}/${scope}`,

    // `authenticated`, AND THIS IS THE WHOLE POINT OF THE FUNCTION. A listing photo is
    // `type: "upload"`, which is world-readable at a guessable-ish URL forever — right
    // for a shop window, catastrophic for a photograph of the inside of somebody's
    // house or of their ID. An authenticated asset has no public URL at all: it can
    // only be reached through a signed one, which this module mints and which expires.
    //
    // Note the cost this accepts, deliberately: a signed URL cannot be CDN-cached, so
    // every view is an origin fetch. That is the correct trade for evidence nobody
    // looks at twice, and the wrong one for a grid of twenty listings — which is why
    // the two paths exist rather than one.
    type: "authenticated",

    resource_type: "image",

    // Same EXIF reasoning as a listing photo, and it matters MORE here rather than
    // less: a handover photo is taken at the moment and place the item changes hands,
    // so its GPS tag is a home address with a timestamp. Smaller cap than a listing's
    // 2400px — this is evidence, not a shop window.
    transformation: [
      { width: 1600, height: 1600, crop: "limit", quality: "auto:good", flags: "strip_profile" },
    ],

    allowed_formats: ["jpg", "jpeg", "png", "webp"],
  };
}

/**
 * Uploads one image buffer as a PRIVATE asset.
 *
 * Deliberately a separate function from `uploadListingPhoto` rather than a flag on it.
 * The two differ in delivery type, folder, size cap and — most importantly — in who
 * may ever see the result, and a boolean parameter is how a caller ends up publishing
 * a document by passing the wrong one.
 *
 * @param {object} input
 * @param {Buffer} input.buffer
 * @param {string} input.scope Folder segment, e.g. a booking id.
 * @returns {Promise<{ storageId: string, width: number, height: number, bytes: number, mimeType: string }>}
 * @throws {Error} If the provider rejects it, or nothing is configured.
 */
export async function uploadPrivateAsset({ buffer, scope }) {
  if (env.isTest) {
    const storageId = `${PRIVATE_FOLDER}/${scope}/test-${fakeUploads.length + 1}`;
    fakeUploads.push({ storageId, bytes: buffer.length, folder: PRIVATE_FOLDER });
    return { storageId, width: 1200, height: 900, bytes: buffer.length, mimeType: "image/jpeg" };
  }

  if (!isMediaConfigured()) {
    throw new Error(
      "Image storage is not configured. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET."
    );
  }

  const result = await new Promise((resolve, reject) => {
    const stream = client().uploader.upload_stream(
      privateUploadOptions(scope),
      (error, uploaded) => (error ? reject(error) : resolve(uploaded))
    );

    stream.end(buffer);
  });

  return {
    storageId: result.public_id,
    width: result.width,
    height: result.height,
    bytes: result.bytes,
    mimeType: `image/${result.format}`,
  };
}

/**
 * Mints a short-lived signed URL for a private asset.
 *
 * MINTED PER REQUEST AND NEVER STORED. Five minutes is long enough to load an image
 * and short enough that a URL copied out of devtools, or left in a browser history,
 * stops working before it is useful to anybody. Caching one would defeat both halves.
 *
 * This URL is still a bearer credential for the five minutes it lives — anyone holding
 * it can fetch the bytes. That is why the endpoint serving it streams through this
 * application instead of redirecting the browser to it: see the photo proxy. The
 * signed URL never reaches the DOM.
 *
 * @param {string} storageId
 * @returns {string}
 * @throws {Error} If nothing is configured — a URL that cannot be signed is worthless.
 */
export function privateAssetUrl(storageId) {
  if (!isMediaConfigured()) {
    throw new Error("Image storage is not configured, so a private asset cannot be signed.");
  }

  return client().url(storageId, {
    type: "authenticated",
    resource_type: "image",
    secure: true,
    sign_url: true,
    expires_at: Math.floor(Date.now() / 1000) + PRIVATE_URL_TTL_SECONDS,
  });
}

/**
 * Fetches a private asset's bytes.
 *
 * HERE RATHER THAN IN THE SERVICE, because this file is "the only module that knows
 * where images physically live" and a `fetch` of a signed URL in a service would make
 * that false. It also keeps the test branch beside the other two: without one, every
 * test that reads a photo would either reach the network or fail on an id that was
 * never really uploaded.
 *
 * @param {string} storageId
 * @returns {Promise<ReadableStream | null>} Null when the provider does not have it.
 * @throws {Error} If nothing is configured.
 */
export async function fetchPrivateAsset(storageId) {
  if (env.isTest) {
    // A one-pixel GIF. Real bytes, so a caller can stream and measure them, and the
    // smallest thing that is unambiguously an image.
    const known = fakeUploads.some((asset) => asset.storageId === storageId);
    if (!known) return null;

    const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
    return new Blob([gif]).stream();
  }

  const response = await fetch(privateAssetUrl(storageId));
  return response.ok ? response.body : null;
}

/**
 * Deletes a private asset. Best effort, same reasoning as `destroyListingPhoto`.
 *
 * `type: "authenticated"` must be passed here too — `destroy` defaults to `upload`
 * and silently reports success for an id it never found, so the wrong type looks
 * exactly like a successful delete while the asset stays.
 *
 * @param {string} storageId
 * @returns {Promise<boolean>}
 */
export async function destroyPrivateAsset(storageId) {
  if (env.isTest) {
    const index = fakeUploads.findIndex((asset) => asset.storageId === storageId);
    if (index >= 0) fakeUploads.splice(index, 1);
    return true;
  }

  if (!isMediaConfigured()) return false;

  try {
    await client().uploader.destroy(storageId, {
      resource_type: "image",
      type: "authenticated",
    });
    return true;
  } catch (error) {
    console.error(`[media] failed to delete private ${storageId}: ${error.message}`);
    return false;
  }
}

/**
 * Uploads one image buffer and returns what Postgres needs to store.
 *
 * @param {object} input
 * @param {Buffer} input.buffer The bytes. Never written to disk — see uploadMiddleware.
 * @param {string} input.listingId Used only to group assets in the folder tree.
 * @returns {Promise<{ storageId: string, width: number, height: number, bytes: number, mimeType: string }>}
 * @throws {Error} If the provider rejects it, or nothing is configured.
 */
export async function uploadListingPhoto({ buffer, listingId }) {
  if (env.isTest) {
    // A deterministic fake, so a test can assert on what was "stored" without a
    // network call and without credentials. This branch is FIRST and unconditional:
    // env.js calls dotenv.config() on import, so real credentials in `.env` are
    // visible to the suite whether or not `.env.test` mentions them. Without this
    // guard ahead of everything, one test touching an upload path would write real
    // assets into the real account, and nothing would ever clean them up.
    const storageId = `${LISTINGS_FOLDER}/${listingId}/test-${fakeUploads.length + 1}`;
    fakeUploads.push({ storageId, bytes: buffer.length, folder: LISTINGS_FOLDER });
    return { storageId, width: 1200, height: 900, bytes: buffer.length, mimeType: "image/jpeg" };
  }

  if (!isMediaConfigured()) {
    throw new Error(
      "Image storage is not configured. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET."
    );
  }

  const result = await new Promise((resolve, reject) => {
    const stream = client().uploader.upload_stream(
      listingUploadOptions(listingId),
      (error, uploaded) => (error ? reject(error) : resolve(uploaded))
    );

    stream.end(buffer);
  });

  return {
    storageId: result.public_id,
    width: result.width,
    height: result.height,
    bytes: result.bytes,
    mimeType: `image/${result.format}`,
  };
}

/**
 * Deletes an asset. Best effort by design — see docs/6.media-storage.md §7.
 *
 * Deleting the ROW is the operation that matters. A leftover asset costs storage; a
 * failed remote delete that rolled back the transaction would leave a user unable to
 * delete their own listing, which is far worse.
 *
 * @param {string} storageId
 * @returns {Promise<boolean>} True if it was deleted.
 * @throws Never. Logs and returns false.
 */
export async function destroyListingPhoto(storageId) {
  if (env.isTest) {
    const index = fakeUploads.findIndex((asset) => asset.storageId === storageId);
    if (index >= 0) fakeUploads.splice(index, 1);
    return true;
  }

  if (!isMediaConfigured()) return false;

  try {
    await client().uploader.destroy(storageId, { resource_type: "image" });
    return true;
  } catch (error) {
    // The id, never the credentials.
    console.error(`[media] failed to delete ${storageId}: ${error.message}`);
    return false;
  }
}

/**
 * Builds a delivery URL for a stored id.
 *
 * THE REASON `storage_id` IS STORED INSTEAD OF A URL. Every size the product needs is
 * a string built here, so changing the grid thumbnail from 400px to 500px is an edit to
 * this function rather than a migration across every row.
 *
 * `f_auto,q_auto` are not decoration: `f_auto` serves WebP or AVIF to browsers that
 * accept them and JPEG to those that do not, and `q_auto` picks a quality per image.
 * Together they routinely halve the bytes for no visible difference — which on a
 * marketplace grid over mobile data is the difference between usable and not.
 *
 * @param {string} storageId
 * @param {"thumb"|"detail"|"original"} [variant="detail"]
 * @returns {string}
 */
export function listingPhotoUrl(storageId, variant = "detail") {
  const transformations = {
    // c_fill crops to exactly fill the tile, so a grid of mixed aspect ratios does not
    // become a ragged mess.
    thumb: "w_400,h_300,c_fill,f_auto,q_auto",
    // c_limit only ever shrinks — it never upscales a small photo into a blurry big one.
    detail: "w_1200,c_limit,f_auto,q_auto",
    original: "f_auto,q_auto",
  };

  const cloud = env.cloudinaryCloudName || "unconfigured";
  return `https://res.cloudinary.com/${cloud}/image/upload/${transformations[variant]}/${storageId}`;
}

/**
 * One line describing how image storage will behave, for the startup banner.
 *
 * Same reason `describeMailMode()` exists: "not configured" is otherwise invisible
 * until the first person tries to upload a photo, at which point it looks like a bug
 * in listings rather than a missing environment variable.
 *
 * Names the cloud but NEVER the key or secret — this goes to stdout, and a deployed
 * log is not a private place.
 *
 * @returns {string}
 */
export function describeMediaMode() {
  if (env.isTest) return "in-memory fake (test) — nothing is uploaded";
  if (isMediaConfigured()) return `Cloudinary, cloud "${env.cloudinaryCloudName}"`;
  return "NOT CONFIGURED — photo upload will refuse. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET";
}

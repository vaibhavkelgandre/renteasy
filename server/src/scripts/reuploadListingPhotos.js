/**
 * Re-uploads the photo for each demo listing from seedFromImages.js's manifest,
 * using WHATEVER Cloudinary credentials are in the environment at the moment this
 * runs — never the ones seedFromImages.js originally uploaded with.
 *
 * WHY THIS EXISTS: seedFromImages.js was run once against the production database
 * with only DATABASE_URL/DB_SSL pointed at production — CLOUDINARY_* was never
 * overridden, so config/env.js's dotenv.config() (which never overwrites an
 * already-set var, only fills in what's missing) silently fell back to the LOCAL
 * dev Cloudinary account for every upload. The listing rows and storage_id values
 * landed correctly in the production database; the actual image bytes did not —
 * they're sitting in the dev cloud, which the production app never reads from. This
 * script re-does just the photo half, this time against whatever Cloudinary account
 * the caller's shell actually points at.
 *
 * `node src/scripts/reuploadListingPhotos.js <manifest.json>`               plan only
 * `node src/scripts/reuploadListingPhotos.js <manifest.json> --yes`         actually write
 *
 * SAME MANIFEST FORMAT AS seedFromImages.js, and matches listings the identical way
 * that script assigned them: entry index % 5 → demo1..demo5, entry title → the
 * listing's title. That's the only link available — the manifest has no listing id
 * in it — so this script re-derives the same owner/title pairing rather than
 * inventing a new mapping.
 *
 * GOES THROUGH THE REAL SERVICE, both ways: removePhoto() to delete the row
 * pointing at the wrong cloud (and fire off a best-effort destroy against it, which
 * is expected to no-op since these credentials can't reach that asset — harmless),
 * then addPhotos() to upload fresh bytes and insert a new row. Never touches
 * listing_photos with raw SQL — the same rule seedFromImages.js follows and for the
 * same reason: nothing here can produce a row the application itself wouldn't.
 *
 * REFUSES TO RUN AGAINST WHAT LOOKS LIKE PRODUCTION without --allow-production, same
 * guard as seedDemo.js/seedFromImages.js — but note this script's whole POINT is to
 * be run against production with production Cloudinary credentials, so that flag is
 * expected here, not a sign something's wrong.
 */

import { readFile } from "node:fs/promises";
import { query, closeDatabase } from "../config/db.js";
import { findUserByEmail } from "../repositories/userRepository.js";
import { findListingsByOwner } from "../repositories/listingRepository.js";
import { addPhotos, removePhoto } from "../services/listingService.js";
import { getListing } from "../services/listingService.js";
import { sniffImageType, ACCEPTED_IMAGE_TYPES } from "../utils/imageType.js";
import { env } from "../config/env.js";
import { isMediaConfigured } from "../config/cloudinary.js";

/** Must match seedFromImages.js's PEOPLE list — same emails, same order. */
const PEOPLE_EMAILS = [
  "demo1@renteasy.test",
  "demo2@renteasy.test",
  "demo3@renteasy.test",
  "demo4@renteasy.test",
  "demo5@renteasy.test",
];

const args = process.argv.slice(2);
const write = args.includes("--yes");
const allowProduction = args.includes("--allow-production");
const manifestPath = args.find((a) => !a.startsWith("--"));

const log = (...parts) => console.log(...parts);

function assertTargetIsSafe(database) {
  const looksProduction = process.env.NODE_ENV === "production" || Boolean(process.env.DATABASE_URL);
  if (looksProduction && !allowProduction) {
    throw new Error(
      `Refusing to touch ${database}: NODE_ENV=production or DATABASE_URL is set. ` +
        `Pass --allow-production if that is genuinely what you want.`
    );
  }
}

async function loadManifest() {
  if (!manifestPath) {
    throw new Error("Give a manifest JSON file, e.g.: node reuploadListingPhotos.js ./manifest.json");
  }
  const raw = await readFile(manifestPath, "utf8");
  const entries = JSON.parse(raw);
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error(`${manifestPath} must be a JSON array with at least one entry.`);
  }
  return entries;
}

async function main() {
  const { rows } = await query("SELECT current_database() AS db");
  const database = rows[0].db;
  assertTargetIsSafe(database);

  if (write && !isMediaConfigured()) {
    throw new Error(
      "Image storage is not configured in THIS shell — set CLOUDINARY_CLOUD_NAME/API_KEY/API_SECRET " +
        "to the credentials of the account you actually want these photos to land in, then re-run."
    );
  }

  const entries = await loadManifest();

  const actors = [];
  for (const email of PEOPLE_EMAILS) {
    const user = await findUserByEmail(email);
    if (!user) throw new Error(`Demo account ${email} does not exist in ${database} — run seedFromImages.js first.`);
    actors.push(user);
  }

  log(`\n[reupload] target database: ${database}`);
  log(`[reupload] cloud: ${write ? env.cloudinaryCloudName || "(unconfigured)" : "(not checked in plan mode)"}`);
  log(`[reupload] ${entries.length} listing(s) from the manifest\n`);

  if (!write) {
    log("[reupload] PLAN ONLY — nothing written. Re-run with --yes to apply.\n");
  }

  let fixed = 0;
  let skipped = 0;

  for (const [index, entry] of entries.entries()) {
    const owner = actors[index % actors.length];
    const { file, title } = entry;

    const ownListings = await findListingsByOwner(owner.id);
    const target = ownListings.find((row) => row.title === title);
    if (!target) {
      log(`  ! "${title}" (owner: ${owner.email}) — no matching listing found, skipping`);
      skipped += 1;
      continue;
    }

    const listing = await getListing(target.id, owner);
    const photos = listing.photos ?? [];
    if (photos.length === 0) {
      log(`  ! "${title}" — listing has no photo rows at all, skipping (investigate separately)`);
      skipped += 1;
      continue;
    }

    if (!write) {
      log(`  + would replace ${photos.length} photo(s) on "${title}" (owner: ${owner.email}) with ${file}`);
      continue;
    }

    const buffer = await readFile(file);
    const detectedMimeType = sniffImageType(buffer);
    if (!detectedMimeType) {
      throw new Error(`"${file}" is not a ${ACCEPTED_IMAGE_TYPES} image — refusing to upload it.`);
    }

    for (const photo of photos) {
      await removePhoto(target.id, photo.id, owner);
    }
    await addPhotos(target.id, owner, [{ buffer, detectedMimeType }]);

    fixed += 1;
    log(`  + fixed "${title}" (owner: ${owner.email})`);
  }

  log(`\n[reupload] done — ${fixed} listing(s) re-uploaded, ${skipped} skipped\n`);
}

main()
  .catch((error) => {
    console.error(`\n[reupload] failed: ${error.message}\n`);
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());

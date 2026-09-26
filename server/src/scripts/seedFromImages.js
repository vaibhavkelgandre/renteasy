/**
 * Five demo accounts plus one published listing per image in a manifest.
 *
 * `node src/scripts/seedFromImages.js <manifest.json>`               plan only
 * `node src/scripts/seedFromImages.js <manifest.json> --yes`         actually write
 *
 * THE MANIFEST IS A JSON ARRAY, each entry:
 *   { "file": "<absolute or relative path to the image>",
 *     "title": "<listing title>",
 *     "category": "<a real category slug — cameras, bikes, tools, appliances,
 *                    electronics, audio, camping, party, sports, other>",
 *     "description": "<optional — a generic one is used if omitted>" }
 *
 * A MANIFEST RATHER THAN A BARE LIST OF FILE PATHS, which is what this script
 * started as: the images this was actually built for have meaningless numeric
 * filenames (uploaded via chat, saved as "17.jpg" etc.), so deriving a title from
 * the filename produced nonsense. The manifest is where a human-reviewed title and
 * category — decided by actually looking at each photo — travels with the file.
 *
 * SAME THREE RULES AS seedDemo.js, and for the identical reasons — read that file's
 * header before changing this one:
 *
 * 1. Accounts are inserted directly (no real verification email sent to a made-up
 *    address).
 * 2. Everything else — the listing, its photo, publishing — goes through the real
 *    services (`listingService.js`), so nothing here can produce a listing the
 *    application itself would refuse.
 * 3. Idempotent by email (accounts) and by title-per-owner (listings): re-running
 *    this with the same manifest does not create duplicates or touch an existing
 *    row.
 *
 * IMAGES COME FROM LOCAL DISK, not a network fetch. Each file's REAL bytes are
 * sniffed with the app's own `sniffImageType`, the same check the upload middleware
 * runs on a real request, so a file that would be rejected as "not really an image"
 * by the API is rejected here too rather than silently uploaded anyway.
 */

import { readFile } from "node:fs/promises";
import { query, closeDatabase } from "../config/db.js";
import { findUserByEmail, insertUser, markEmailVerified } from "../repositories/userRepository.js";
import { hashPassword } from "../utils/password.js";
import { createListing, addPhotos, publishListing } from "../services/listingService.js";
import { findListingsByOwner } from "../repositories/listingRepository.js";
import { sniffImageType, ACCEPTED_IMAGE_TYPES } from "../utils/imageType.js";
import { env } from "../config/env.js";

/** One password for every demo account, printed at the end so it is never guessed at. */
const PASSWORD = "DemoRent!2345";

/** Five generic accounts — deliberately not real names, per direct request. */
const PEOPLE = [
  { name: "Demo Owner 1", email: "demo1@renteasy.test" },
  { name: "Demo Owner 2", email: "demo2@renteasy.test" },
  { name: "Demo Owner 3", email: "demo3@renteasy.test" },
  { name: "Demo Owner 4", email: "demo4@renteasy.test" },
  { name: "Demo Owner 5", email: "demo5@renteasy.test" },
];

/** Fields the publish gate (FR-107) requires, used when a manifest entry omits them. */
const PLACEHOLDER = {
  condition: "GOOD",
  dailyRatePaise: 50_000, // ₹500/day
  depositPaise: 100_000, // ₹1,000
  locality: "Kothrud",
  city: "Pune",
};

const VALID_CATEGORIES = new Set([
  "cameras", "bikes", "tools", "appliances", "electronics",
  "audio", "camping", "party", "sports", "other",
]);

const args = process.argv.slice(2);
const write = args.includes("--yes");
const allowProduction = args.includes("--allow-production");
const manifestPath = args.find((a) => !a.startsWith("--"));

const log = (...parts) => console.log(...parts);

/** Same guard as seedDemo.js, and for the identical reason — see that file's comment. */
function assertTargetIsSafe(database) {
  const looksProduction = process.env.NODE_ENV === "production" || Boolean(process.env.DATABASE_URL);
  if (looksProduction && !allowProduction) {
    throw new Error(
      `Refusing to seed ${database}: NODE_ENV=production or DATABASE_URL is set. ` +
        `Pass --allow-production if that is genuinely what you want.`
    );
  }
}

/**
 * Loads and validates the manifest, so a mistake in it (a bad category, a missing
 * file) is reported clearly before anything is written — not discovered halfway
 * through a run that has already created some listings.
 *
 * @returns {Promise<object[]>}
 */
async function loadManifest() {
  if (!manifestPath) {
    throw new Error("Give a manifest JSON file, e.g.: node seedFromImages.js ./manifest.json");
  }

  const raw = await readFile(manifestPath, "utf8");
  const entries = JSON.parse(raw);
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error(`${manifestPath} must be a JSON array with at least one entry.`);
  }

  const problems = [];
  entries.forEach((entry, index) => {
    if (!entry.file) problems.push(`entry ${index}: missing "file"`);
    if (!entry.title) problems.push(`entry ${index}: missing "title"`);
    if (!entry.category) problems.push(`entry ${index}: missing "category"`);
    else if (!VALID_CATEGORIES.has(entry.category)) {
      problems.push(`entry ${index}: "${entry.category}" is not a real category (${[...VALID_CATEGORIES].join(", ")})`);
    }
  });

  if (problems.length > 0) {
    throw new Error(`Manifest problems:\n  ${problems.join("\n  ")}`);
  }

  return entries;
}

async function seedPeople() {
  const actors = [];
  let created = 0;
  const passwordHash = await hashPassword(PASSWORD);

  for (const person of PEOPLE) {
    const already = await findUserByEmail(person.email);
    if (already) {
      log(`  · ${person.email} already exists — left alone`);
      actors.push(already);
      continue;
    }

    const user = await insertUser({
      name: person.name,
      email: person.email,
      passwordHash,
      phone: null,
      acceptedTermsVersion: env.termsVersion,
    });
    actors.push(await markEmailVerified(user.id, user.email));
    created += 1;
    log(`  + ${person.email}`);
  }

  return { actors, created };
}

async function seedListingsFromManifest(actors, entries) {
  const published = [];

  for (const [index, entry] of entries.entries()) {
    const owner = actors[index % actors.length];
    const { file, title, category, description } = entry;

    // Idempotent per owner+title, same rule as seedDemo.js — matches PUBLISHED only,
    // since anything else means a previous run stopped partway through.
    const existingRow = (await findListingsByOwner(owner.id)).find((row) => row.title === title);
    if (existingRow?.status === "PUBLISHED") {
      published.push(existingRow);
      log(`  · ${title} (owner: ${owner.email}) — already published`);
      continue;
    }

    const buffer = await readFile(file);
    const detectedMimeType = sniffImageType(buffer);
    if (!detectedMimeType) {
      throw new Error(`"${file}" is not a ${ACCEPTED_IMAGE_TYPES} image — refusing to upload it.`);
    }

    const created =
      existingRow ??
      (await createListing(owner, {
        title,
        category,
        description: description || "Demo listing — edit these details.",
        ...PLACEHOLDER,
      }));

    if (!existingRow) {
      await addPhotos(created.id, owner, [{ buffer, detectedMimeType }]);
    }
    const listing = await publishListing(created.id, owner);

    published.push(listing);
    log(`  + ${title} (${category}, owner: ${owner.email})`);
  }

  return published;
}

async function main() {
  const { rows } = await query("SELECT current_database() AS db");
  const database = rows[0].db;

  assertTargetIsSafe(database);
  const entries = await loadManifest();

  log(`\n[seed] target database: ${database}`);
  log(`[seed] ${PEOPLE.length} demo accounts · ${entries.length} listing(s) from the manifest\n`);

  if (!write) {
    log("[seed] PLAN ONLY — nothing written. Re-run with --yes to apply.\n");
    for (const person of PEOPLE) {
      const already = await findUserByEmail(person.email);
      log(`  ${already ? "·" : "+"} ${person.email.padEnd(24)} ${already ? "exists, would be left alone" : "would be created"}`);
    }
    for (const [index, entry] of entries.entries()) {
      log(`  + ${entry.title} (${entry.category}) → owner ${PEOPLE[index % PEOPLE.length].email}`);
    }
    log(`\n[seed] password for every demo account: ${PASSWORD}\n`);
    return;
  }

  log("[seed] accounts");
  const { actors, created } = await seedPeople();

  log("\n[seed] listings — uploading to Cloudinary");
  const listings = await seedListingsFromManifest(actors, entries);

  log(`\n[seed] done — ${created} account(s) created, ${listings.length} listing(s) published`);
  log(`[seed] sign in as any demo account with: ${PASSWORD}\n`);
}

main()
  .catch((error) => {
    console.error(`\n[seed] failed: ${error.message}\n`);
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());

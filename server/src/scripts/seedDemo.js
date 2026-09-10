/**
 * Demo data — ten people, their listings, and enough activity to see the product work.
 *
 * `npm run seed`            plan only, writes nothing
 * `npm run seed -- --yes`   actually write
 *
 * THREE RULES, and each one is load-bearing rather than tidiness.
 *
 * 1. USERS ARE INSERTED DIRECTLY. Everything else goes through the services, so the
 *    obvious thing would be to POST /auth/register ten times — and it would send ten
 *    real verification emails, through Brevo, to addresses that do not exist. Ten
 *    hard bounces is a measurable hit to a sending domain's reputation, and this
 *    project's mail is live. A user row plus `email_verified_at` has no derived state
 *    hanging off it, so writing it directly costs nothing; that is exactly why the
 *    exception is safe here and not below.
 *
 * 2. EVERYTHING ELSE GOES THROUGH THE SERVICES. Listings are created, photographed
 *    and published by `listingService`; bookings by `bookingService`. A direct INSERT
 *    would let this script produce data the application itself would refuse — a
 *    published listing with no photo, two overlapping confirmed bookings, a booking
 *    whose price does not match its own quote. Seed data that could not have been
 *    created by using the app is worse than no seed data, because it makes the app
 *    look broken when it is the fixture that is wrong.
 *
 * 3. IT NEVER MODIFIES AN EXISTING ROW. Idempotency is by email lookup, and an email
 *    that already exists is reported and left completely alone. This runs against a
 *    development database somebody else is also using by hand.
 *
 * The `.test` TLD is reserved by RFC 6761 and never resolves, so even a mistake that
 * did try to mail one of these accounts could not deliver anywhere real.
 */

import { query, closeDatabase } from "../config/db.js";
import { findUserByEmail, insertUser, markEmailVerified } from "../repositories/userRepository.js";
import { hashPassword } from "../utils/password.js";
import { createListing, addPhotos, publishListing, addBlackout } from "../services/listingService.js";
import { findListingsByOwner, countPhotos } from "../repositories/listingRepository.js";
import { requestBooking, actOnBooking } from "../services/bookingService.js";
import { env } from "../config/env.js";

/** One password for every demo account, so a reviewer needs to remember one thing. */
const PASSWORD = "DemoRent!2345";

const PEOPLE = [
  { name: "Asha Patil", email: "asha@renteasy.test", city: "Pune", locality: "Kothrud" },
  { name: "Rohan Mehta", email: "rohan@renteasy.test", city: "Pune", locality: "Baner" },
  { name: "Priya Nair", email: "priya@renteasy.test", city: "Pune", locality: "Viman Nagar" },
  { name: "Imran Shaikh", email: "imran@renteasy.test", city: "Mumbai", locality: "Bandra" },
  { name: "Sneha Kulkarni", email: "sneha@renteasy.test", city: "Mumbai", locality: "Andheri" },
  { name: "Vikram Rao", email: "vikram@renteasy.test", city: "Bengaluru", locality: "Indiranagar" },
  { name: "Meera Joshi", email: "meera@renteasy.test", city: "Bengaluru", locality: "Koramangala" },
  { name: "Arjun Desai", email: "arjun@renteasy.test", city: "Delhi", locality: "Hauz Khas" },
  { name: "Fatima Ansari", email: "fatima@renteasy.test", city: "Delhi", locality: "Saket" },
  { name: "Karthik Iyer", email: "karthik@renteasy.test", city: "Hyderabad", locality: "Gachibowli" },
];

/**
 * The catalogue. `owner` indexes into PEOPLE; `photos` are loremflickr search terms.
 *
 * Rates are deliberately uneven — some hourly only, some daily only, some all three —
 * because the quote engine's whole job is picking the cheapest combination, and a
 * catalogue where everything is priced identically demonstrates none of it.
 */
const CATALOGUE = [
  {
    owner: 0, category: "cameras", title: "Canon EOS R6 with two lenses",
    description: "Full-frame mirrorless body, 24-105mm and a 50mm prime, two batteries and a charger. Ideal for a weekend shoot or a wedding.",
    condition: "GOOD", hourlyRatePaise: 30_000, dailyRatePaise: 150_000, monthlyRatePaise: 2_500_000,
    depositPaise: 1_000_000, minDurationHours: 4, photos: ["camera,dslr", "camera,lens"],
    noticePeriodHours: 24,
  },
  {
    owner: 0, category: "tools", title: "Bosch hammer drill kit",
    description: "Corded SDS-plus drill with a full bit set in a carry case. Handles concrete without complaint.",
    condition: "GOOD", dailyRatePaise: 40_000, depositPaise: 200_000, photos: ["drill,tool"],
  },
  {
    owner: 1, category: "bikes", title: "Royal Enfield Classic 350",
    description: "Well-serviced, papers in order, two helmets included. Pickup from Baner.",
    condition: "GOOD", dailyRatePaise: 120_000, monthlyRatePaise: 2_200_000,
    depositPaise: 1_500_000, minDurationHours: 24, photos: ["motorcycle,classic"],
    noticePeriodHours: 24,
  },
  {
    owner: 2, category: "camping", title: "Four-person tent and camping set",
    description: "Waterproof tent, two sleeping bags, a mat and a gas stove. Everything for a weekend in the hills.",
    condition: "LIKE_NEW", dailyRatePaise: 60_000, depositPaise: 300_000, photos: ["tent,camping", "campfire"],
  },
  {
    owner: 3, category: "audio", title: "JBL PA system with two speakers",
    description: "800W powered pair, stands, cables and a wired mic. Enough for a hall of about 150 people.",
    condition: "GOOD", hourlyRatePaise: 50_000, dailyRatePaise: 250_000,
    depositPaise: 2_000_000, minDurationHours: 4, photos: ["speaker,concert"],
  },
  {
    owner: 4, category: "party", title: "Fairy lights and decor kit",
    description: "Forty metres of warm string lights, paper lanterns and bunting. Collected the morning after, no rush.",
    condition: "GOOD", dailyRatePaise: 25_000, depositPaise: 100_000, photos: ["fairylights"],
  },
  {
    owner: 5, category: "electronics", title: "MacBook Pro 14in M3",
    description: "18GB RAM, 512GB. For a sprint, a shoot or a month of remote work. Charger and sleeve included.",
    condition: "LIKE_NEW", dailyRatePaise: 200_000, monthlyRatePaise: 3_500_000,
    depositPaise: 5_000_000, minDurationHours: 24, photos: ["laptop,macbook"],
    noticePeriodHours: 48,
  },
  {
    owner: 6, category: "sports", title: "Decathlon road bike, 54cm frame",
    description: "21-speed, recently serviced, comes with a helmet, lock and pump.",
    condition: "GOOD", hourlyRatePaise: 15_000, dailyRatePaise: 50_000, monthlyRatePaise: 900_000,
    depositPaise: 400_000, photos: ["bicycle"],
  },
  {
    owner: 7, category: "appliances", title: "Pressure washer, 1800W",
    description: "For a car, a balcony or a very tired driveway. Hose and three nozzles included.",
    condition: "FAIR", dailyRatePaise: 45_000, depositPaise: 250_000, photos: ["washer,cleaning"],
  },
  {
    owner: 8, category: "cameras", title: "DJI Mini 3 Pro drone",
    description: "Under 250g, three batteries and ND filters. Please fly it somewhere it is legal to.",
    condition: "LIKE_NEW", dailyRatePaise: 180_000, depositPaise: 3_000_000,
    minDurationHours: 24, photos: ["drone,aerial"], noticePeriodHours: 48,
  },
  {
    owner: 9, category: "audio", title: "Yamaha acoustic guitar",
    description: "FG800, steel strung, with a soft case, capo and a spare set of strings.",
    condition: "GOOD", dailyRatePaise: 30_000, monthlyRatePaise: 500_000,
    depositPaise: 200_000, photos: ["guitar"],
  },
  {
    owner: 9, category: "tools", title: "Extending aluminium ladder",
    description: "Reaches about 6.5 metres. Too big for most cars — collection by van or a small truck.",
    condition: "FAIR", dailyRatePaise: 35_000, depositPaise: 150_000, photos: ["ladder"],
    fulfilment: "PICKUP",
  },
  {
    owner: 1, category: "party", title: "Folding tables and twenty chairs",
    description: "Four trestle tables and twenty stacking chairs. Delivery within Pune can be arranged.",
    condition: "GOOD", dailyRatePaise: 80_000, depositPaise: 300_000,
    photos: ["chairs,event"], fulfilment: "BOTH",
  },
  {
    owner: 4, category: "electronics", title: "Projector, 1080p, 3000 lumens",
    description: "HDMI and USB-C, ceiling mount or a tripod. Watchable with the lights on.",
    condition: "GOOD", hourlyRatePaise: 20_000, dailyRatePaise: 90_000,
    depositPaise: 800_000, photos: ["projector,cinema"],
  },
];

/**
 * loremflickr answers **403 to any term containing a space**, and nothing about the
 * response says so — it is an 895-byte error page, not a message.
 *
 * Checked here, before a single row is written or a single image uploaded, because
 * of where the first version failed: two listings in, after their photos were
 * already in Cloudinary. A network-shaped mistake in a static table should be caught
 * while it is still just a static table.
 *
 * @throws {Error} Naming every bad term at once, not the first.
 */
function assertPhotoTermsAreUsable() {
  const bad = CATALOGUE.flatMap((item) =>
    item.photos.filter((term) => /\s/.test(term)).map((term) => `${item.title}: "${term}"`)
  );

  if (bad.length > 0) {
    throw new Error(
      "loremflickr refuses terms containing spaces (403). " +
        "Use single or comma-separated words: " +
        bad.join("; ")
    );
  }
}

const args = new Set(process.argv.slice(2));
const write = args.has("--yes");
const allowProduction = args.has("--allow-production");

const log = (...parts) => console.log(...parts);
const hoursFromNow = (h) => new Date(Date.now() + h * 60 * 60 * 1000);
const days = (d) => hoursFromNow(d * 24);

/**
 * Refuses to run anywhere that looks like production unless told twice.
 *
 * Same shape as the migration runner's baseline guard, and for the same reason: this
 * writes rows AND uploads images to a real Cloudinary account, neither of which has
 * an undo.
 */
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
 * Fetches one image as a buffer.
 *
 * 640x480, which lands between 40KB and 80KB. Small on purpose: these go through the
 * real Cloudinary pipeline, on an account shared with another project, and a demo
 * catalogue is not worth megabytes of anybody's quota.
 *
 * `lock` makes loremflickr deterministic, so re-running this after a wipe gives the
 * same catalogue rather than reshuffling every photo.
 *
 * @param {string} term Comma-separated search terms.
 * @param {number} lock Any stable integer.
 * @returns {Promise<Buffer>}
 */
async function fetchPhoto(term, lock) {
  const url = `https://loremflickr.com/640/480/${encodeURIComponent(term)}?lock=${lock}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });

  if (!response.ok) throw new Error(`${url} → ${response.status}`);

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < 1000) throw new Error(`${url} returned ${buffer.length} bytes`);
  return buffer;
}

/**
 * Creates the ten accounts, verified and ready to sign in.
 *
 * @returns {Promise<{ actors: object[], created: number, existing: number }>}
 */
async function seedPeople() {
  const actors = [];
  let created = 0;
  let existing = 0;

  const passwordHash = await hashPassword(PASSWORD);

  for (const person of PEOPLE) {
    const already = await findUserByEmail(person.email);
    if (already) {
      // Reported and untouched. It might be somebody's real account, or one they have
      // been testing with by hand.
      log(`  · ${person.email} already exists — left alone`);
      actors.push(already);
      existing += 1;
      continue;
    }

    const user = await insertUser({
      name: person.name,
      email: person.email,
      passwordHash,
      phone: null,
      acceptedTermsVersion: env.termsVersion,
    });

    // Verified directly. Publishing a listing requires it (FR-107), and the real path
    // to it is an emailed token — which is the thing this script must not send.
    actors.push(await markEmailVerified(user.id, user.email));
    created += 1;
    log(`  + ${person.email}`);
  }

  return { actors, created, existing };
}

/**
 * Creates, photographs and publishes the catalogue.
 *
 * @param {object[]} actors
 * @returns {Promise<object[]>} The published listings, in CATALOGUE order.
 */
async function seedListings(actors) {
  const listings = [];
  let lock = 1;

  for (const [index, item] of CATALOGUE.entries()) {
    const owner = actors[item.owner];
    const person = PEOPLE[item.owner];
    const { photos, ...fields } = item;

    /**
     * RESUME, RATHER THAN SKIP.
     *
     * The first run of this script died two listings in, on a 403 from the photo
     * host — and it died BETWEEN `createListing` and `addPhotos`, leaving a row that
     * existed, had no photo and was still a draft. The first version of this check
     * matched on title alone, decided that row was done, and moved on: the recovery
     * pass reported success while leaving a listing nobody could ever see.
     *
     * So "already there" has to mean PUBLISHED, which is the only state that implies
     * every step ran. Anything else is picked up where it stopped. Sixteen network
     * calls make a partial failure the normal case, and a resume that quietly skips
     * the broken row is worse than no resume at all.
     */
    const existingRow = (await findListingsByOwner(owner.id)).find((row) => row.title === item.title);

    if (existingRow?.status === "PUBLISHED") {
      listings.push(existingRow);
      log(`  · ${String(index + 1).padStart(2)} ${item.title} — already published`);
      lock += photos.length;
      continue;
    }

    const created =
      existingRow ??
      (await createListing(owner, { ...fields, locality: person.locality, city: person.city }));

    // Only the photos it is still missing. A resumed row may already have some, and
    // re-uploading them would leave orphans in Cloudinary that nothing points at.
    const have = created.photos?.length ?? (existingRow ? await countPhotos(created.id) : 0);
    const files = [];
    for (const term of photos.slice(have)) {
      files.push({ buffer: await fetchPhoto(term, lock + photos.indexOf(term)), detectedMimeType: "image/jpeg" });
    }
    lock += photos.length;

    if (files.length > 0) await addPhotos(created.id, owner, files);
    const published = await publishListing(created.id, owner);

    listings.push(published);
    log(
      `  ${existingRow ? "↻" : "+"} ${String(index + 1).padStart(2)} ${item.title}` +
        ` (${files.length} photo${files.length === 1 ? "" : "s"}${existingRow ? ", resumed" : ""})`
    );
  }

  return listings;
}

/**
 * A little activity, so the bookings and availability screens are not empty.
 *
 * Every one of these goes through the real services, so a fixture that the product
 * would refuse simply fails here rather than becoming a misleading row — which is the
 * whole point of not reaching for INSERT.
 *
 * @param {object[]} actors
 * @param {object[]} listings
 */
async function seedActivity(actors, listings) {
  const [asha, rohan, priya, imran, sneha, vikram] = actors;

  /**
   * ONCE, OR NOT AT ALL.
   *
   * Unlike people and listings there is no natural key to match on here — two
   * identical booking requests are a legitimate thing for a renter to make, so
   * nothing about a row says "this is the seed's". Re-running would therefore stack
   * duplicate bookings, and the blackouts below would fail outright on their own
   * no-overlap constraint.
   *
   * Checking whether ANY of the seeded listings has a booking is enough: they only
   * ever get one from here.
   */
  const { rows } = await query(
    `SELECT count(*)::int AS n FROM bookings WHERE listing_id = ANY($1::uuid[])`,
    [listings.map((listing) => listing.id)]
  );

  if (rows[0].n > 0) {
    log("  · bookings already present — skipping, this step is not repeatable");
    return;
  }

  // A confirmed booking, so the double-booking guard and the availability calendar
  // both have something real to show.
  const confirmed = await requestBooking(rohan, {
    listingId: listings[0].id,
    startsAt: days(9),
    endsAt: days(12),
    message: "Shooting a friend's wedding — would collect Friday evening.",
  });
  await actOnBooking(confirmed.id, asha, "ACCEPT", "Sure, see you Friday.");
  log("  + Rohan → Asha's camera, ACCEPTED");

  // One still waiting, which is what the owner's queue is for.
  await requestBooking(priya, {
    listingId: listings[4].id,
    startsAt: days(20),
    endsAt: days(21),
    message: "Society Diwali event, about 120 people.",
  });
  log("  + Priya → Imran's PA system, REQUESTED");

  // And one declined, so a renter's list is not uniformly happy.
  const declined = await requestBooking(sneha, {
    listingId: listings[6].id,
    startsAt: days(4),
    endsAt: days(6),
    message: "Two days of client work while my own machine is repaired.",
  });
  await actOnBooking(declined.id, vikram, "DECLINE", "Sorry — already promised to a colleague that week.");
  log("  + Sneha → Vikram's MacBook, DECLINED");

  // Blackouts, so an owner's calendar shows both kinds and a renter's shows neither
  // reason. Placed clear of the booking above, which the FR-206 trigger would refuse.
  await addBlackout(listings[0].id, asha, {
    startsAt: days(25),
    endsAt: days(28),
    reason: "Lending it to my brother",
  });
  await addBlackout(listings[2].id, rohan, {
    startsAt: days(14),
    endsAt: days(16),
    reason: "Service due",
  });
  log("  + 2 blackouts");
}

async function main() {
  const { rows } = await query("SELECT current_database() AS db");
  const database = rows[0].db;

  assertTargetIsSafe(database);
  assertPhotoTermsAreUsable();

  log(`\n[seed] target database: ${database}`);
  log(`[seed] ${PEOPLE.length} people · ${CATALOGUE.length} listings · ${CATALOGUE.reduce((n, i) => n + i.photos.length, 0)} photos to Cloudinary\n`);

  if (!write) {
    log("[seed] PLAN ONLY — nothing written. Re-run with --yes to apply.\n");
    for (const person of PEOPLE) {
      const already = await findUserByEmail(person.email);
      log(`  ${already ? "·" : "+"} ${person.email.padEnd(26)} ${already ? "exists, would be left alone" : "would be created"}`);
    }
    log(`\n[seed] password for every demo account: ${PASSWORD}\n`);
    return;
  }

  log("[seed] people");
  const { actors, created, existing } = await seedPeople();

  log("\n[seed] listings — downloading photos and uploading to Cloudinary, this takes a minute");
  const listings = await seedListings(actors);

  log("\n[seed] activity");
  await seedActivity(actors, listings);

  log(`\n[seed] done — ${created} people created, ${existing} already present, ${listings.length} listings published`);
  log(`[seed] sign in as any of them with: ${PASSWORD}\n`);
}

main()
  .catch((error) => {
    console.error(`\n[seed] failed: ${error.message}\n`);
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());

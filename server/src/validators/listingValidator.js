/**
 * Request validation for the listing routes.
 *
 * Note what is ABSENT from every schema: `ownerId`, `status`, `publishedAt`, `id`. Zod
 * strips unknown keys, so a body carrying any of them is discarded rather than reaching
 * a service. Ownership is taken from the session and publishing has its own endpoint
 * with its own conditions — neither must be reachable by adding a field to an edit.
 */

import { z } from "zod";
import {
  BROWSE_DEFAULT_LIMIT,
  BROWSE_MAX_LIMIT,
} from "../repositories/listingRepository.js";

/** Matches the CHECK in migration 004. A closed list, tied to wording in the UI. */
const CONDITIONS = ["NEW", "LIKE_NEW", "GOOD", "FAIR"];
const FULFILMENTS = ["PICKUP", "DELIVERY", "BOTH"];

/**
 * A price in PAISE — a positive integer, never a float.
 *
 * `.int()` is doing real work: money as a float is a bug waiting for the first
 * `0.1 + 0.2`, and rupees-as-decimal is exactly how it gets in. The client converts
 * once, at the edge, and everything inside is whole paise.
 *
 * The cap is ~₹10,00,000 per unit. Not a business rule so much as a typo catcher: it
 * turns "I meant 500 rupees and typed paise" into a validation error instead of a
 * listing nobody can afford.
 */
const paise = z
  .number()
  .int("Enter a whole amount")
  .positive("Enter an amount greater than zero")
  .max(100_000_000, "That is higher than this platform supports");

/** `null` clears a rate; omitting it leaves it alone. */
const optionalPaise = paise.nullable().optional();

const durationHours = z
  .number()
  .int()
  .positive()
  .max(8760, "Longer than a year is not a rental")
  .nullable()
  .optional();

/**
 * The fields shared by create and edit.
 *
 * Note `locality` and `city` are OPTIONAL here even though FR-107 requires them to
 * publish. That is deliberate and is the same reasoning as the nullable rate columns:
 * a draft is half-finished by definition, and refusing to save one without a location
 * would stop somebody starting a listing at all. The publish gate is where "required"
 * is enforced.
 */
const listingFields = {
  title: z.string().trim().min(3, "Give it a title").max(140),
  description: z.string().trim().min(10, "Say a little about it").max(4000),

  // A SLUG, not a uuid. It is stable, readable in a URL, and produces an error message
  // a human can act on.
  category: z.string().trim().min(1, "Choose a category"),

  condition: z.enum(CONDITIONS, { message: "Choose a condition" }),

  hourlyRatePaise: optionalPaise,
  dailyRatePaise: optionalPaise,
  monthlyRatePaise: optionalPaise,

  // Zero is legitimate, unlike a rate: "no deposit" is a real offer, whereas a rate of
  // zero is a missing price rather than a free rental.
  depositPaise: z.number().int().min(0).max(100_000_000).optional(),

  // AN AREA, NEVER A STREET ADDRESS (FR-113). There is no address field anywhere in
  // this schema, and adding one would be a safety regression: a published listing is
  // world-readable, so a street address on it says where a valuable object is kept.
  locality: z.string().trim().min(1).max(120).nullable().optional(),
  city: z.string().trim().min(1).max(120).nullable().optional(),

  minDurationHours: durationHours,
  maxDurationHours: durationHours,

  fulfilment: z.enum(FULFILMENTS).optional(),

  // FR-203. Zero is meaningful here, unlike a rate: "bookable right now" is a real
  // answer, so this is `min(0)` rather than `positive()`.
  noticePeriodHours: z.number().int().min(0).max(8760).nullable().optional(),
};

/**
 * POST /api/listings
 *
 * The duration check is a whole-object refinement because it is a relationship between
 * two fields, which no per-field rule can express.
 */
export const createListingSchema = z
  .object(listingFields)
  .refine(
    (body) =>
      body.minDurationHours == null ||
      body.maxDurationHours == null ||
      body.maxDurationHours >= body.minDurationHours,
    { message: "The longest rental cannot be shorter than the shortest", path: ["maxDurationHours"] }
  );

/**
 * PATCH /api/listings/:id
 *
 * Every field optional, with at least one required — a body of `{}` means nothing, and
 * answering 200 to it would suggest something was saved.
 *
 * The cross-field duration rule is NOT re-checked here, and that is deliberate rather
 * than an omission: with both fields optional, either half can come from the stored row,
 * so a body carrying only `maxDurationHours` can invert the range against a minimum
 * this schema never sees. The service checks the MERGED row instead, which is the only
 * place both values exist.
 */
export const updateListingSchema = z
  .object(
    Object.fromEntries(
      Object.entries(listingFields).map(([key, schema]) => [
        key,
        schema.isOptional?.() ? schema : schema.optional(),
      ])
    )
  )
  .refine((body) => Object.keys(body).length > 0, { message: "Nothing to update" });

/** Route params carrying a listing id. */
export const listingParamsSchema = z.object({
  id: z.string().uuid(),
});

/** Route params carrying a listing id and a photo id. */
export const photoParamsSchema = z.object({
  id: z.string().uuid(),
  photoId: z.string().uuid(),
});

/**
 * PATCH /api/listings/:id/photos/order
 *
 * Must name every photo exactly once — the service checks the set against what is
 * actually stored, because only it knows.
 */
export const reorderPhotosSchema = z.object({
  photoIds: z.array(z.string().uuid()).min(1, "List the photos in the order you want"),
});

/**
 * GET /api/listings — the browse query string.
 *
 * `z.coerce` throughout, because a query string is ALWAYS strings: `?limit=24` arrives
 * as `"24"`, and `z.number()` would reject every page request ever made.
 *
 * DEFAULTED AND CAPPED, both deliberate and both FR-307. A caller that asks for no
 * page still gets a bounded one, and `?limit=100000` is refused rather than served —
 * without the cap, pagination is decoration over an unbounded query.
 */
export const browseQuerySchema = z.object({
  // Filters. All optional; absent means "no restriction".
  category: z.string().trim().min(1).max(60).optional(),
  city: z.string().trim().min(1).max(120).optional(),

  // The search term. Capped so an enormous string cannot be pushed through a LIKE.
  q: z.string().trim().min(1).max(120).optional(),

  /**
   * Which rate the price filter and price sort apply to — FR-302.
   *
   * Defaulted rather than optional, so "cheapest first" always has a defined meaning.
   * Without it, sorting by price with no unit chosen would have to guess between three
   * columns, and would guess differently as the code changed.
   */
  unit: z.enum(["hourly", "daily", "monthly"]).default("daily"),

  minPricePaise: z.coerce.number().int().min(0).max(100_000_000).optional(),
  maxPricePaise: z.coerce.number().int().min(0).max(100_000_000).optional(),

  // FR-303. Both or neither — one half of a range cannot express "free between".
  availableFrom: z.coerce.date().optional(),
  availableTo: z.coerce.date().optional(),

  sort: z.enum(["newest", "price_asc", "price_desc"]).default("newest"),

  limit: z.coerce.number().int().min(1).max(BROWSE_MAX_LIMIT).default(BROWSE_DEFAULT_LIMIT),
  offset: z.coerce.number().int().min(0).default(0),
})
  .refine(
    (query) =>
      query.minPricePaise == null ||
      query.maxPricePaise == null ||
      query.maxPricePaise >= query.minPricePaise,
    { message: "The maximum price cannot be below the minimum", path: ["maxPricePaise"] }
  )
  .refine(
    (query) => (query.availableFrom == null) === (query.availableTo == null),
    {
      message: "Give both dates, or neither",
      path: ["availableTo"],
    }
  )
  .refine(
    (query) =>
      query.availableFrom == null || query.availableTo == null || query.availableTo > query.availableFrom,
    { message: "The end must be after the start", path: ["availableTo"] }
  );

/**
 * GET /api/listings/:id/quote — the query string.
 *
 * ISO instants, not dates: this product rents by the hour as well as the month, so
 * "2026-09-10" alone cannot express a six-hour rental. `z.coerce.date()` accepts an
 * ISO string and hands the service a real Date.
 *
 * The ordering rule is NOT checked here — `billableHours` refuses an inverted range
 * with a message about rentals, and duplicating the rule would mean two places to keep
 * in step.
 */
export const quoteQuerySchema = z.object({
  start: z.coerce.date({ message: "Give a start date and time" }),
  end: z.coerce.date({ message: "Give an end date and time" }),
});

/** POST /api/listings/:id/blackouts — FR-200. */
export const blackoutSchema = z.object({
  startsAt: z.coerce.date({ message: "Give a start date and time" }),
  endsAt: z.coerce.date({ message: "Give an end date and time" }),

  // The owner's private note. Never returned to a renter — see listingService.
  reason: z.string().trim().min(1).max(200).optional(),
});

/** Route params carrying a listing id and a blackout id. */
export const blackoutParamsSchema = z.object({
  id: z.string().uuid(),
  blockId: z.string().uuid(),
});

/**
 * GET /api/listings/:id/availability
 *
 * The window is optional: without it the caller gets everything, which is right for a
 * listing that has three bookings and wrong for one with three hundred. A calendar
 * asks month by month.
 */
export const availabilityQuerySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

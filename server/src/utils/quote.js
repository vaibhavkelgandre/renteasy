/**
 * What a rental actually costs — FR-400 to FR-407.
 *
 * THE PRODUCT'S LEAST OBVIOUS BEHAVIOUR, and the one most worth getting right. A
 * listing carries up to three prices and the renter is charged the CHEAPEST APPLICABLE
 * COMBINATION, never a naive multiplication:
 *
 *   Camera:  ₹150/hour · ₹800/day · ₹15,000/month
 *
 *   6 hours  → 6 × 150 = ₹900       …but a whole day is ₹800, so charge ₹800
 *   30 days  → 30 × 800 = ₹24,000   …but a month is ₹15,000, so charge ₹15,000
 *   40 days  → 1 month + 10 days    = ₹23,000
 *
 * A renter charged ₹24,000 where ₹15,000 was available does not come back, and a
 * platform that silently overcharges is not one anybody trusts.
 *
 * PURE. No database, no clock, no config lookups — everything it needs is an argument.
 * That is what lets the whole rule be tested exhaustively in milliseconds, and it is
 * why this is a util rather than a service.
 */

/**
 * Every unit expressed in hours, which is the one currency the arithmetic can share.
 *
 * A MONTH IS 30 DAYS HERE, not a calendar month, and that is a deliberate
 * simplification worth knowing about. A calendar month would make the same 40-day
 * rental cost different amounts depending on whether it started in February or July,
 * which is impossible to explain on a listing page that advertises one monthly price.
 * The cost is that a 31-day month is charged as a month plus a day.
 */
export const UNIT_HOURS = {
  hour: 1,
  day: 24,
  month: 24 * 30,
};

/** Longest to shortest — the order lines are shown in, and the order they are tried. */
const UNITS = ["month", "day", "hour"];

/**
 * The platform's cut of the rent, in basis points (100 = 1%).
 *
 * FR-403 asks for commission to be COMPUTED AND RECORDED, NOT IMPLIED. It is taken
 * from the owner's payout rather than added to the renter's bill, so the price a renter
 * is quoted is the price they pay.
 *
 * Nothing collects it — there is no payment gateway (step 10). It exists now because a
 * commission introduced later has to be back-computed for every historical booking,
 * whereas a column that has always been there simply reads zero for the period before
 * it mattered.
 */
export const COMMISSION_BASIS_POINTS = 1000; // 10%

/**
 * GST rate in basis points. Zero, and the field exists anyway — FR-406.
 *
 * The requirement is explicit that tax is a field "from the first migration, even at
 * zero", for the same reason as commission: retrofitting a tax column means deciding
 * what every past booking should have charged, which is a question with no good answer.
 */
export const TAX_BASIS_POINTS = 0;

/**
 * Converts a start and end instant into whole billable hours.
 *
 * ROUNDS UP, and this is one of the two places FR-407 applies. A rental of 6 hours and
 * one minute occupies a seventh hour of the owner's availability — nobody else can have
 * the item during it — so it is billed. Rounding down would let a renter hold an item
 * for a period they did not pay for.
 *
 * The rounding is applied to the DURATION, once, rather than to each line, so it can
 * never compound.
 *
 * @param {Date|string} start
 * @param {Date|string} end
 * @returns {number} Whole hours, at least 1.
 * @throws {Error} If the range is inverted or not a valid pair of instants.
 */
export function billableHours(start, end) {
  const from = new Date(start);
  const to = new Date(end);

  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new Error("A rental needs a valid start and end");
  }
  if (to <= from) {
    throw new Error("A rental must end after it starts");
  }

  const hours = (to - from) / (1000 * 60 * 60);

  // Math.ceil with a tolerance, because floating-point subtraction of two dates can
  // land on 23.999999999999996 for an exact day. Without it, an exact 24-hour rental
  // would bill 24 hours in some timezones and 25 in others.
  return Math.max(1, Math.ceil(hours - 1e-9));
}

/**
 * Which of two equally-priced combinations to quote.
 *
 * TIES ARE COMMON, not exotic: a listing priced at ₹500/day and ₹15,000/month makes 30
 * days and 1 month cost exactly the same, and owners choose round numbers precisely
 * like that. So the rule cannot be "whichever the loop happened to reach first" —
 * which is what an earlier version of this did, while a comment claimed otherwise.
 *
 * Cost decides first. After that:
 *
 *   fewer LINES     "2 days" beats "1 day + 1 hour" at the same money. An invoice with
 *                   one line is easier to check than one with two.
 *   larger UNITS    "1 month" beats "30 days". Same money, and it is how the owner
 *                   described the price.
 *
 * @param {object} a
 * @param {object} b
 * @returns {boolean} True if `a` should be preferred.
 */
function isBetter(a, b) {
  if (a.cost !== b.cost) return a.cost < b.cost;

  const lines = (c) => (c.months > 0) + (c.days > 0) + (c.hours > 0);
  if (lines(a) !== lines(b)) return lines(a) < lines(b);

  if (a.months !== b.months) return a.months > b.months;
  return a.days > b.days;
}

/**
 * The cheapest combination of units covering a duration.
 *
 * EXHAUSTIVE, NOT GREEDY, and that is the whole correctness argument. Greedy — take as
 * many months as fit, then days, then hours — gets the 40-day example right and the
 * 6-hour one wrong: it would charge 6 hours at ₹900 because six hours do not fill a
 * day, never noticing that buying a whole day is cheaper than the hours it replaces.
 *
 * Rounding UP to a larger unit is frequently the cheapest answer, so any algorithm that
 * only ever fills downward is wrong. Searching the space avoids having to reason about
 * which of the many rate relationships hold — and the space is tiny: durations are
 * capped at a year, so the worst case is roughly 13 × 366 combinations, microseconds.
 *
 * @param {number} hours Whole billable hours.
 * @param {object} rates Paise per unit; `null` means the owner does not offer it.
 * @param {number|null} rates.hour
 * @param {number|null} rates.day
 * @param {number|null} rates.month
 * @returns {{ lines: Array<{unit: string, quantity: number, unitPricePaise: number, subtotalPaise: number}>, rentPaise: number, coveredHours: number } | null}
 *          Null when the listing offers no rate at all — the caller decides what that
 *          means, because "unpriced" is a listing problem rather than a maths one.
 */
export function cheapestCombination(hours, rates) {
  const available = UNITS.filter((unit) => rates[unit] != null && rates[unit] > 0);
  if (available.length === 0) return null;

  let best = null;

  // Bound each unit by what alone would cover the duration. Anything more is strictly
  // worse: it costs more and covers time nobody asked for.
  const maxMonths = rates.month != null ? Math.ceil(hours / UNIT_HOURS.month) : 0;

  for (let months = 0; months <= maxMonths; months += 1) {
    const afterMonths = hours - months * UNIT_HOURS.month;
    const maxDays = rates.day != null ? Math.max(0, Math.ceil(afterMonths / UNIT_HOURS.day)) : 0;

    for (let days = 0; days <= maxDays; days += 1) {
      const afterDays = afterMonths - days * UNIT_HOURS.day;

      // Whatever is left must be covered by hours. If the listing has no hourly rate,
      // this combination only works when the larger units already cover everything.
      let hoursNeeded = Math.max(0, Math.ceil(afterDays));
      if (hoursNeeded > 0 && rates.hour == null) continue;

      const cost =
        months * (rates.month ?? 0) + days * (rates.day ?? 0) + hoursNeeded * (rates.hour ?? 0);

      // Skip the empty combination, which covers nothing and costs nothing.
      if (months === 0 && days === 0 && hoursNeeded === 0) continue;

      const candidate = { cost, months, days, hours: hoursNeeded };
      if (best === null || isBetter(candidate, best)) best = candidate;
    }
  }

  if (best === null) return null;

  const quantities = { month: best.months, day: best.days, hour: best.hours };

  return {
    lines: UNITS.filter((unit) => quantities[unit] > 0).map((unit) => ({
      unit,
      quantity: quantities[unit],
      unitPricePaise: rates[unit],
      subtotalPaise: quantities[unit] * rates[unit],
    })),
    rentPaise: best.cost,

    // What the renter is actually buying, which can exceed what they asked for — six
    // hours billed as a day covers 24. Surfaced so the client can say so rather than
    // leaving someone to wonder why six hours cost a day's rate.
    coveredHours:
      best.months * UNIT_HOURS.month + best.days * UNIT_HOURS.day + best.hours * UNIT_HOURS.hour,
  };
}

/**
 * A complete, itemised quote — FR-401 to FR-404, FR-406.
 *
 * EVERY FIGURE IS DERIVED HERE AND NOWHERE ELSE. FR-404 is explicit that a
 * client-supplied total is never trusted, and the way to guarantee that is for the
 * client to have no arithmetic to do: it renders what this returns.
 *
 * @param {object} input
 * @param {Date|string} input.start
 * @param {Date|string} input.end
 * @param {object} input.listing A listing row — rates and deposit are read from it.
 * @returns {object} The quote.
 * @throws {Error} If the range is invalid, or the listing has no rate at all.
 */
export function buildQuote({ start, end, listing }) {
  const hours = billableHours(start, end);

  const rates = {
    hour: listing.hourly_rate_paise ?? null,
    day: listing.daily_rate_paise ?? null,
    month: listing.monthly_rate_paise ?? null,
  };

  const combination = cheapestCombination(hours, rates);
  if (!combination) throw new Error("This listing has no price set");

  const rentPaise = combination.rentPaise;
  const depositPaise = listing.deposit_paise ?? 0;

  // Tax applies to the rent, NOT to the deposit — a deposit is a refundable holding of
  // the renter's own money, not a sale, so taxing it would be charging tax on
  // something later given back.
  const taxPaise = Math.round((rentPaise * TAX_BASIS_POINTS) / 10_000);

  // Commission comes out of the owner's payout rather than being added to the renter's
  // bill, so the quoted price is the price paid.
  const commissionPaise = Math.round((rentPaise * COMMISSION_BASIS_POINTS) / 10_000);

  return {
    requestedHours: hours,
    coveredHours: combination.coveredHours,

    // FR-401: units, the rate applied, and the subtotal — never just a total.
    lines: combination.lines,

    rentPaise,
    taxPaise,
    taxBasisPoints: TAX_BASIS_POINTS,

    // FR-402: separate from rent and labelled, because a renter comparing two listings
    // needs to know which part of the number comes back to them.
    depositPaise,
    depositRefundable: true,

    // What the renter pays now.
    renterTotalPaise: rentPaise + taxPaise + depositPaise,

    // FR-403: recorded, not implied. Nothing collects it yet.
    commissionPaise,
    commissionBasisPoints: COMMISSION_BASIS_POINTS,
    ownerPayoutPaise: rentPaise - commissionPaise,
  };
}

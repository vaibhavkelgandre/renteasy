/**
 * The quote engine — FR-400 to FR-407.
 *
 * Pure functions, so these are exhaustive rather than representative: the whole rule
 * can be checked in milliseconds, and this is the arithmetic a renter is charged by.
 *
 * The three worked examples from docs/0.product-overview.md §4 are pinned verbatim.
 * They are the specification, and if they ever disagree with this file one of the two
 * is wrong in a way somebody will notice on their bank statement.
 */

import { describe, it, expect } from "vitest";
import {
  billableHours,
  cheapestCombination,
  buildQuote,
  UNIT_HOURS,
  COMMISSION_BASIS_POINTS,
} from "../src/utils/quote.js";

/** The listing from the product doc: ₹150/hour, ₹800/day, ₹15,000/month. */
const CAMERA = { hour: 15_000, day: 80_000, month: 1_500_000 };

const listing = (overrides = {}) => ({
  hourly_rate_paise: CAMERA.hour,
  daily_rate_paise: CAMERA.day,
  monthly_rate_paise: CAMERA.month,
  deposit_paise: 0,
  ...overrides,
});

describe("the three worked examples from the product doc", () => {
  it("6 hours costs a DAY, because a day is cheaper than six hours", () => {
    const quote = cheapestCombination(6, CAMERA);

    // 6 × ₹150 = ₹900, but a whole day is ₹800. THE CASE A GREEDY ALGORITHM GETS
    // WRONG: six hours do not fill a day, so filling downward never considers buying
    // one — and charges ₹100 too much.
    expect(quote.rentPaise).toBe(80_000);
    expect(quote.lines).toEqual([
      { unit: "day", quantity: 1, unitPricePaise: 80_000, subtotalPaise: 80_000 },
    ]);
  });

  it("30 days costs a MONTH", () => {
    const quote = cheapestCombination(30 * 24, CAMERA);

    // 30 × ₹800 = ₹24,000 against ₹15,000 for the month.
    expect(quote.rentPaise).toBe(1_500_000);
    expect(quote.lines).toEqual([
      { unit: "month", quantity: 1, unitPricePaise: 1_500_000, subtotalPaise: 1_500_000 },
    ]);
  });

  it("40 days is a month plus ten days", () => {
    const quote = cheapestCombination(40 * 24, CAMERA);

    // ₹15,000 + 10 × ₹800 = ₹23,000. The mixed case, which needs the combination
    // rather than any single unit.
    expect(quote.rentPaise).toBe(2_300_000);
    expect(quote.lines).toEqual([
      { unit: "month", quantity: 1, unitPricePaise: 1_500_000, subtotalPaise: 1_500_000 },
      { unit: "day", quantity: 10, unitPricePaise: 80_000, subtotalPaise: 80_000 * 10 },
    ]);
  });
});

describe("rounding up to a larger unit when it is cheaper", () => {
  it("prefers hours over a second day when hours are cheap", () => {
    // 25 hours: a day plus an hour (₹950) beats two days (₹1,600).
    const quote = cheapestCombination(25, CAMERA);
    expect(quote.rentPaise).toBe(80_000 + 15_000);
  });

  it("prefers a second day when the hourly rate makes filling it dearer", () => {
    // Same 25 hours, but hours now cost ₹900. A day plus an hour is ₹1,700 against
    // ₹1,600 for two days — so the extra 23 hours nobody asked for are worth buying.
    const expensive = { ...CAMERA, hour: 90_000 };
    const quote = cheapestCombination(25, expensive);

    expect(quote.rentPaise).toBe(160_000);
    expect(quote.lines).toEqual([
      { unit: "day", quantity: 2, unitPricePaise: 80_000, subtotalPaise: 160_000 },
    ]);
  });

  it("reports how many hours were actually bought", () => {
    const quote = cheapestCombination(6, CAMERA);

    // Six hours billed as a day covers 24. Surfaced so the client can say so, rather
    // than leaving somebody to wonder why six hours cost a day's rate.
    expect(quote.coveredHours).toBe(24);
  });

  it("never charges more than covering the duration with a single unit would", () => {
    // A property rather than an example: whatever the rates, the answer is never worse
    // than the naive "buy enough of one unit" a person would work out themselves.
    const rateSets = [
      CAMERA,
      { hour: 100, day: 100, month: 100 },
      { hour: 5_000, day: 1_000_000, month: 1_100_000 },
      { hour: 1, day: 10_000, month: 20_000 },
    ];

    for (const rates of rateSets) {
      for (const hours of [1, 5, 23, 24, 25, 100, 719, 720, 721, 1000]) {
        const best = cheapestCombination(hours, rates).rentPaise;

        for (const [unit, unitHours] of Object.entries(UNIT_HOURS)) {
          if (rates[unit] == null) continue;
          const naive = Math.ceil(hours / unitHours) * rates[unit];
          expect(best, `${hours}h with ${JSON.stringify(rates)} via ${unit}`).toBeLessThanOrEqual(naive);
        }
      }
    }
  });
});

describe("listings that do not offer every unit", () => {
  it("charges a whole month when that is the only rate", () => {
    const quote = cheapestCombination(1, { hour: null, day: null, month: 1_500_000 });

    // An hour from a monthly-only listing costs a month. Harsh but honest — the owner
    // has offered exactly one way to rent it.
    expect(quote.rentPaise).toBe(1_500_000);
    expect(quote.coveredHours).toBe(720);
  });

  it("uses many hours when hours are all there is", () => {
    const quote = cheapestCombination(50, { hour: 15_000, day: null, month: null });
    expect(quote.rentPaise).toBe(50 * 15_000);
  });

  it("mixes the units that exist and ignores the ones that do not", () => {
    const quote = cheapestCombination(26, { hour: 15_000, day: 80_000, month: null });
    expect(quote.rentPaise).toBe(80_000 + 2 * 15_000);
  });

  it("returns null when a listing has no rate at all", () => {
    // A listing problem rather than a maths one, so the caller decides what it means.
    // This state is unreachable for a PUBLISHED listing, since FR-107 requires a rate
    // to publish — but a draft can be quoted internally.
    expect(cheapestCombination(5, { hour: null, day: null, month: null })).toBeNull();
  });

  it("treats a zero rate as no rate, not as free", () => {
    // The schema forbids a rate of zero (`> 0`), so if one appears it is corrupt data
    // rather than a giveaway — and quoting ₹0 for a camera would be worse than
    // refusing.
    expect(cheapestCombination(5, { hour: 0, day: 0, month: 0 })).toBeNull();
  });
});

describe("ties", () => {
  it("quotes the larger unit when two combinations cost the same", () => {
    // 30 days at ₹500/day is ₹15,000, exactly the monthly rate. "1 month" reads better
    // on an invoice than "30 days", and is the same money.
    const quote = cheapestCombination(30 * 24, { hour: null, day: 50_000, month: 1_500_000 });
    expect(quote.lines).toEqual([
      { unit: "month", quantity: 1, unitPricePaise: 1_500_000, subtotalPaise: 1_500_000 },
    ]);
  });
});

describe("billableHours", () => {
  it("counts whole hours", () => {
    expect(billableHours("2026-09-10T09:00:00Z", "2026-09-10T15:00:00Z")).toBe(6);
  });

  it("ROUNDS UP a partial hour", () => {
    // FR-407. A rental of six hours and one minute occupies a seventh hour of the
    // owner's availability — nobody else can have the item during it.
    expect(billableHours("2026-09-10T09:00:00Z", "2026-09-10T15:01:00Z")).toBe(7);
  });

  it("gives an exact day exactly 24 hours, not 25", () => {
    // Floating-point subtraction of two dates can land on 23.999999999999996, and a
    // naive ceil would bill a whole extra hour for an exact day.
    expect(billableHours("2026-09-10T00:00:00Z", "2026-09-11T00:00:00Z")).toBe(24);
    expect(billableHours("2026-09-10T00:00:00Z", "2026-10-10T00:00:00Z")).toBe(720);
  });

  it("bills at least one hour", () => {
    expect(billableHours("2026-09-10T09:00:00Z", "2026-09-10T09:05:00Z")).toBe(1);
  });

  it("refuses an inverted or zero-length range", () => {
    expect(() => billableHours("2026-09-10T15:00:00Z", "2026-09-10T09:00:00Z")).toThrow(/end after/);
    expect(() => billableHours("2026-09-10T09:00:00Z", "2026-09-10T09:00:00Z")).toThrow(/end after/);
  });

  it("refuses an unparseable instant rather than quoting NaN", () => {
    expect(() => billableHours("not a date", "2026-09-10T09:00:00Z")).toThrow(/valid start and end/);
  });
});

describe("buildQuote — the whole bill", () => {
  it("itemises rather than returning a bare total — FR-401", () => {
    const quote = buildQuote({
      start: "2026-09-10T00:00:00Z",
      end: "2026-10-20T00:00:00Z",
      listing: listing(),
    });

    // Units, the rate applied, and the subtotal. A total on its own is unauditable by
    // the person paying it.
    expect(quote.lines).toHaveLength(2);
    expect(quote.lines[0]).toMatchObject({ unit: "month", quantity: 1 });
    expect(quote.lines[1]).toMatchObject({ unit: "day", quantity: 10 });
    expect(quote.rentPaise).toBe(2_300_000);
  });

  it("keeps the deposit separate and marks it refundable — FR-402", () => {
    const quote = buildQuote({
      start: "2026-09-10T00:00:00Z",
      end: "2026-09-11T00:00:00Z",
      listing: listing({ deposit_paise: 500_000 }),
    });

    // A renter comparing two listings needs to know which part of the number comes
    // back to them.
    expect(quote.depositPaise).toBe(500_000);
    expect(quote.depositRefundable).toBe(true);
    expect(quote.rentPaise).toBe(80_000);
    expect(quote.renterTotalPaise).toBe(80_000 + 500_000);
  });

  it("does NOT tax the deposit", () => {
    const quote = buildQuote({
      start: "2026-09-10T00:00:00Z",
      end: "2026-09-11T00:00:00Z",
      listing: listing({ deposit_paise: 500_000 }),
    });

    // A deposit is a refundable holding of the renter's own money, not a sale. Taxing
    // it would charge tax on something later given back. Pinned now, while the rate is
    // zero and the mistake would be invisible.
    expect(quote.taxPaise).toBe(0);
  });

  it("carries a tax field even at zero — FR-406", () => {
    const quote = buildQuote({
      start: "2026-09-10T00:00:00Z",
      end: "2026-09-11T00:00:00Z",
      listing: listing(),
    });

    // Retrofitting a tax column means deciding what every past booking should have
    // charged, which is a question with no good answer.
    expect(quote).toHaveProperty("taxPaise");
    expect(quote).toHaveProperty("taxBasisPoints");
  });

  it("takes commission from the OWNER's payout, not the renter's bill — FR-403", () => {
    const quote = buildQuote({
      start: "2026-09-10T00:00:00Z",
      end: "2026-09-11T00:00:00Z",
      listing: listing({ deposit_paise: 100_000 }),
    });

    const expectedCommission = Math.round((80_000 * COMMISSION_BASIS_POINTS) / 10_000);

    expect(quote.commissionPaise).toBe(expectedCommission);
    expect(quote.ownerPayoutPaise).toBe(80_000 - expectedCommission);

    // The quoted price is the price paid: commission is invisible to the renter's
    // total, so nobody is surprised at checkout.
    expect(quote.renterTotalPaise).toBe(80_000 + 100_000);
  });

  it("returns whole paise everywhere — never a fraction", () => {
    const quote = buildQuote({
      start: "2026-09-10T00:00:00Z",
      end: "2026-09-10T07:00:00Z",
      listing: listing({ hourly_rate_paise: 3_333, deposit_paise: 1 }),
    });

    // A float anywhere in a money path is a bug. Rounding happens once per derived
    // figure, never accumulated across lines.
    for (const [key, value] of Object.entries(quote)) {
      if (typeof value === "number") {
        expect(Number.isInteger(value), `${key} = ${value}`).toBe(true);
      }
    }
  });

  it("refuses a listing with no price rather than quoting zero", () => {
    expect(() =>
      buildQuote({
        start: "2026-09-10T00:00:00Z",
        end: "2026-09-11T00:00:00Z",
        listing: listing({
          hourly_rate_paise: null,
          daily_rate_paise: null,
          monthly_rate_paise: null,
        }),
      })
    ).toThrow(/no price/);
  });
});

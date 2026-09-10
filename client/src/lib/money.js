/**
 * Rupees on screen, paise on the wire.
 *
 * THE ONLY PLACE THAT CONVERTS. Every price in this application is an integer number of
 * paise from the database to the API to this file — a float in a money path is a bug,
 * and `0.1 + 0.2 !== 0.3` is why. Rupees exist for exactly two purposes: showing a
 * person a number, and reading one they typed.
 *
 * Anything that does its own `/ 100` is a second conversion point, and two conversion
 * points is how a rounding rule drifts.
 */

/**
 * Formats paise as a rupee amount for display.
 *
 * @param {number|null|undefined} paise
 * @param {object} [options]
 * @param {boolean} [options.withSymbol=true]
 * @returns {string} e.g. "₹1,500" or "₹1,500.50". Empty string for null.
 */
export function formatPaise(paise, { withSymbol = true } = {}) {
  if (paise == null) return "";

  const rupees = paise / 100;

  // Whole rupees lose the decimals: "₹1,500" reads as a price, "₹1,500.00" reads as an
  // invoice. Only show paise when there actually are any.
  const formatted = new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: paise % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(rupees);

  return withSymbol ? `₹${formatted}` : formatted;
}

/**
 * Reads a typed rupee amount into whole paise.
 *
 * `Math.round` rather than truncation, and it matters: `19.99 * 100` is `1998.9999…`
 * in binary floating point, so truncating would silently charge a paisa less on a
 * significant share of ordinary prices.
 *
 * @param {string} input What the user typed.
 * @returns {number|null} Whole paise, or null for empty/unparseable input — which the
 *          caller sends as `null` to mean "no rate for this unit", a real state.
 */
export function parseRupeesToPaise(input) {
  const trimmed = String(input ?? "").trim();
  if (trimmed === "") return null;

  // Commas are natural to type in Indian formatting ("1,500") and mean nothing to
  // Number().
  const value = Number(trimmed.replace(/,/g, ""));
  if (!Number.isFinite(value) || value < 0) return null;

  return Math.round(value * 100);
}

/**
 * Turns paise back into the string a rupee input should show.
 *
 * Separate from `formatPaise` on purpose: an `<input>` must not contain a currency
 * symbol or thousands separators, or re-submitting an untouched form would fail to
 * parse its own value.
 *
 * @param {number|null|undefined} paise
 * @returns {string}
 */
export function paiseToRupeeInput(paise) {
  if (paise == null) return "";
  return paise % 100 === 0 ? String(paise / 100) : (paise / 100).toFixed(2);
}

/** The three rental units, in the order they are shown everywhere. */
export const RATE_UNITS = [
  { key: "hourlyRatePaise", column: "hourly_rate_paise", label: "Per hour", short: "hour" },
  { key: "dailyRatePaise", column: "daily_rate_paise", label: "Per day", short: "day" },
  { key: "monthlyRatePaise", column: "monthly_rate_paise", label: "Per month", short: "month" },
];

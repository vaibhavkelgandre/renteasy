/**
 * Dates, in one place.
 *
 * The same three helpers had been rewritten in three pages — `formatWhen` in
 * BookingDetailPage, `formatRange` in MyBookingsPage, `toLocalInput` in
 * BookingRequestPage — which is how "3 Oct" on one screen becomes "03/10/2026" on the
 * next. Availability needed a fourth copy of two of them, so they moved here instead.
 *
 * EVERYTHING THE SERVER SENDS IS AN ISO INSTANT IN UTC, and everything here renders it
 * in the reader's own zone. That conversion is the whole job of this file: it happens
 * at the boundary, once, exactly like `money.js` does for paise. Nothing above this
 * layer should ever touch a timezone.
 */

/**
 * Formats an instant as a full local date and time.
 *
 * @param {string|Date} value An ISO string or a Date.
 * @returns {string} e.g. "3 Oct 2026, 9:00 am"
 */
export function formatWhen(value) {
  return new Date(value).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Formats a period the way a human would say it out loud.
 *
 * A rental inside one day is an hourly one, so the TIMES are the information and the
 * date is said once. A multi-day rental is the opposite: the dates matter and the
 * times are noise.
 *
 * @param {string|Date} startsAt
 * @param {string|Date} endsAt
 * @returns {string}
 */
export function formatRange(startsAt, endsAt) {
  const from = new Date(startsAt);
  const to = new Date(endsAt);

  const date = (d) => d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  const time = (d) => d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

  if (isSameDay(from, to)) return `${date(from)}, ${time(from)} – ${time(to)}`;
  return `${date(from)} – ${date(to)}`;
}

/**
 * Renders an instant for a `datetime-local` input.
 *
 * That input wants `YYYY-MM-DDTHH:mm` in LOCAL time with no zone and no seconds, which
 * `toISOString` cannot give — it is always UTC. Subtracting the offset first is the
 * standard trick, and the reason this is a function rather than an inline slice.
 *
 * @param {Date} date
 * @returns {string}
 */
export function toLocalInput(date) {
  const offset = date.getTimezoneOffset() * 60 * 1000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

/**
 * Renders a day for a `date` input — `YYYY-MM-DD`, in LOCAL time.
 *
 * Not `toISOString().slice(0, 10)`, which is the bug this exists to prevent: at
 * UTC+05:30 an evening date becomes the NEXT day in UTC, so a calendar cell for the
 * 3rd would fill the field with the 4th.
 *
 * @param {Date} date
 * @returns {string}
 */
export function toDateInput(date) {
  return toLocalInput(date).slice(0, 10);
}

/**
 * @param {Date} a
 * @param {Date} b
 * @returns {boolean} True when both fall on the same local calendar day.
 */
export function isSameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * Midnight at the start of a day, in local time.
 *
 * @param {Date} date
 * @returns {Date}
 */
export function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/**
 * Midnight at the start of the NEXT day — the exclusive end of `date`'s own day.
 *
 * Exclusive on purpose, matching the `[)` bounds every period in this product uses
 * (`bookings.period`, `availability_blocks.period`). A day and the period covering it
 * are then compared with the same notion of overlap the database uses, so a booking
 * ending at midnight does not paint the following morning as taken.
 *
 * @param {Date} date
 * @returns {Date}
 */
export function endOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
}

/**
 * The first of the month containing `date`.
 *
 * @param {Date} date
 * @returns {Date}
 */
export function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

/**
 * Moves `date` by whole months, keeping the first of the month.
 *
 * @param {Date} date
 * @param {number} months May be negative.
 * @returns {Date}
 */
export function addMonths(date, months) {
  return new Date(date.getFullYear(), date.getMonth() + months, 1);
}

/**
 * @param {Date} date
 * @returns {string} e.g. "October 2026"
 */
export function formatMonth(date) {
  return date.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

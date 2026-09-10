/**
 * A month of a listing's availability — FR-204 for the owner, FR-205 for everyone
 * else.
 *
 * ONE COMPONENT FOR BOTH AUDIENCES, mirroring `getAvailability` on the server, which
 * is one function for both. The difference is a single field: the API sends `kind`
 * ("BOOKING" or "BLACKOUT") only to the owner, so this renders the legend and the
 * per-day tone from what it was actually given rather than from a `isOwner` prop it
 * would have to be told. A renter cannot see a distinction that never reached the
 * browser.
 *
 * WHY NOT A CALENDAR LIBRARY. This shows one month and marks its days. Nothing more:
 * it is deliberately READ-ONLY, because this product rents by the hour and a day
 * grid cannot express a six-hour rental — the booking form keeps its two
 * `datetime-local` fields. `react-day-picker` is ~40KB for what is here, and every
 * date library disagrees with the server about `[)` bounds until told otherwise,
 * which is the one thing on this screen that must not be got wrong.
 */

import { useMemo, useState } from "react";
import {
  addMonths,
  endOfDay,
  formatMonth,
  startOfDay,
  startOfMonth,
} from "../lib/dates.js";

/** Sunday-first, matching the `Date.getDay()` numbering so no mapping is needed. */
const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];

/**
 * The state of a single day.
 *
 * Precedence matters and is deliberate: a day that is both blocked AND before the
 * notice period reads as blocked, because that is the fact the owner can act on.
 */
const DAY_TONES = {
  BOOKING: "bg-brand-100 text-brand-900",
  BLACKOUT: "bg-amber-100 text-amber-900",
  // A renter is told only that it is taken. Same grey for both kinds.
  TAKEN: "bg-stone-200 text-stone-500",
  NOTICE: "bg-stone-50 text-stone-300 line-through",
  FREE: "text-stone-700",
};

/**
 * Which of `unavailable` covers a given day, if any.
 *
 * `[)` bounds throughout, matching `tstzrange(starts_at, ends_at, '[)')` in migrations
 * 006 and 007 — a period ending at midnight does not touch the following day. Getting
 * this wrong paints one extra day as taken, which is invisible until someone loses a
 * booking to it.
 *
 * @param {{startsAt: string, endsAt: string, kind?: string}[]} unavailable
 * @param {Date} day Local midnight.
 * @returns {object|undefined}
 */
function periodCovering(unavailable, day) {
  const from = day.getTime();
  const to = endOfDay(day).getTime();

  return unavailable.find(
    (period) =>
      new Date(period.startsAt).getTime() < to && new Date(period.endsAt).getTime() > from
  );
}

/**
 * The days of `month`, padded to whole weeks so the grid never has a ragged first row.
 *
 * @param {Date} month The first of the month.
 * @returns {(Date|null)[]} `null` for a padding cell.
 */
function monthGrid(month) {
  const first = startOfMonth(month);
  const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();

  const cells = Array.from({ length: first.getDay() }, () => null);
  for (let day = 1; day <= daysInMonth; day += 1) {
    cells.push(new Date(month.getFullYear(), month.getMonth(), day));
  }
  while (cells.length % 7 !== 0) cells.push(null);

  return cells;
}

/**
 * @param {object} props
 * @param {{startsAt: string, endsAt: string, kind?: string}[]} props.unavailable
 * @param {string|null} [props.bookableFrom] ISO instant — days entirely before it are
 *        inside the notice period (FR-203) and cannot be booked.
 */
export function AvailabilityCalendar({ unavailable, bookableFrom }) {
  const [month, setMonth] = useState(() => startOfMonth(new Date()));

  const cells = useMemo(() => monthGrid(month), [month]);

  // The owner is the only audience the server sends `kind` to, so its presence IS the
  // answer to "may this reader see which is which".
  const showsKind = unavailable.some((period) => period.kind);

  const noticeUntil = bookableFrom ? new Date(bookableFrom) : null;
  const today = startOfDay(new Date());

  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setMonth(addMonths(month, -1))}
          // The past holds nothing anyone can act on, and paging back into it is the
          // most common way to end up staring at an empty calendar wondering why.
          disabled={month <= startOfMonth(today)}
          aria-label="Previous month"
          className="grid size-8 place-items-center rounded-lg text-stone-500 hover:bg-stone-100 disabled:opacity-30 disabled:hover:bg-transparent"
        >
          ‹
        </button>

        <p className="font-medium text-stone-900" aria-live="polite">
          {formatMonth(month)}
        </p>

        <button
          type="button"
          onClick={() => setMonth(addMonths(month, 1))}
          aria-label="Next month"
          className="grid size-8 place-items-center rounded-lg text-stone-500 hover:bg-stone-100"
        >
          ›
        </button>
      </div>

      <div className="mt-3 grid grid-cols-7 gap-1 text-center text-xs text-stone-400">
        {WEEKDAYS.map((letter, index) => (
          // The index is a legitimate key here: the array is a fixed seven-item
          // constant, and two of its labels are the literal same string.
          <div key={index} aria-hidden="true" className="py-1">
            {letter}
          </div>
        ))}
      </div>

      <div className="mt-1 grid grid-cols-7 gap-1">
        {cells.map((day, index) => {
          if (!day) return <div key={`pad-${index}`} />;

          const period = periodCovering(unavailable, day);
          const inNotice = noticeUntil != null && endOfDay(day) <= noticeUntil;
          const isPast = day < today;

          const tone = period
            ? DAY_TONES[showsKind ? period.kind : "TAKEN"]
            : inNotice || isPast
              ? DAY_TONES.NOTICE
              : DAY_TONES.FREE;

          const label = period
            ? showsKind && period.kind === "BLACKOUT"
              ? "blocked by you"
              : showsKind
                ? "booked"
                : "unavailable"
            : inNotice
              ? "too soon to book"
              : isPast
                ? "in the past"
                : "available";

          // A `div`, not a disabled button: there is no action to disable, and a
          // grid of thirty disabled buttons is thirty tab stops with nothing at any
          // of them.
          return (
            <div
              key={day.getDate()}
              // The tone alone carries this for a sighted reader; a screen reader
              // gets the same fact as words.
              aria-label={`${day.getDate()} ${formatMonth(month)} — ${label}`}
              className={`grid h-9 place-items-center rounded-lg text-sm ${tone}`}
            >
              <span className="tabular-nums">{day.getDate()}</span>
            </div>
          );
        })}
      </div>

      <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-stone-500">
        {showsKind ? (
          <>
            <Key className="bg-brand-100" label="Booked" />
            <Key className="bg-amber-100" label="Blocked by you" />
          </>
        ) : (
          <Key className="bg-stone-200" label="Unavailable" />
        )}
        {noticeUntil != null && <Key className="bg-stone-50 ring-1 ring-stone-200" label="Too soon" />}
      </ul>
    </div>
  );
}

function Key({ className, label }) {
  return (
    <li className="flex items-center gap-1.5">
      <span aria-hidden="true" className={`size-3 rounded ${className}`} />
      {label}
    </li>
  );
}

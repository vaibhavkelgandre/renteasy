/**
 * Bookings, from whichever side you are on — `/bookings`. FR-513.
 *
 * ONE PAGE WITH TWO TABS, not two pages. On a marketplace the same person rents and
 * lends, so "my bookings" is genuinely one idea seen from two angles — and two routes
 * would mean two places to find, two nav entries, and the nagging question of which
 * one you are currently looking at.
 *
 * The side lives in the URL, so a tab is linkable and survives a refresh — the same
 * reasoning as the browse filters.
 */

import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Page, StatusBadge } from "../components/ui/Page.jsx";
import { Card } from "../components/ui/Card.jsx";
import { Button } from "../components/ui/Button.jsx";
import { Alert } from "../components/ui/Alert.jsx";
import { api } from "../lib/api.js";
import { formatPaise } from "../lib/money.js";

const SIDES = [
  { value: "renter", label: "Renting", empty: "You have not requested anything yet." },
  { value: "owner", label: "Lending", empty: "Nobody has asked to rent your things yet." },
];

/** A date range, without repeating the month when both ends share one. */
function formatRange(startsAt, endsAt) {
  const from = new Date(startsAt);
  const to = new Date(endsAt);
  const sameDay = from.toDateString() === to.toDateString();

  const date = (d) => d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  const time = (d) => d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

  // A same-day rental is an hourly one, so the times are the information; a multi-day
  // rental is about the dates and the times are noise.
  return sameDay ? `${date(from)}, ${time(from)} – ${time(to)}` : `${date(from)} – ${date(to)}`;
}

function BookingRow({ booking, side }) {
  const counterpart = side === "renter" ? "from the owner" : "from a renter";

  return (
    <li>
      <Card className="overflow-hidden">
        <Link
          to={`/bookings/${booking.id}`}
          className="flex gap-4 p-4 transition-colors hover:bg-stone-50"
        >
          {/* A fixed box with a placeholder, so a booking whose listing has no photo
              does not sit at a different height from its neighbours. */}
          <div className="size-20 shrink-0 overflow-hidden rounded-xl bg-stone-100">
            {booking.coverUrl ? (
              <img src={booking.coverUrl} alt="" loading="lazy" className="size-full object-cover" />
            ) : (
              <div className="grid size-full place-items-center text-xs text-stone-400">
                No photo
              </div>
            )}
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate font-medium text-stone-900">{booking.listing_title}</h2>
              <StatusBadge status={booking.status} />
            </div>
            <p className="mt-1 text-sm text-stone-500">{formatRange(booking.starts_at, booking.ends_at)}</p>
            <p className="mt-1.5 text-sm text-stone-600">
              {formatPaise(booking.renter_total_paise)}
              {booking.deposit_paise > 0 && (
                <span className="text-stone-400"> incl. deposit</span>
              )}
            </p>
          </div>

          {/* Says WHY this row wants attention, rather than only that it does. */}
          {booking.availableActions.length > 0 && booking.status === "REQUESTED" && (
            <div className="hidden shrink-0 self-center text-sm text-amber-700 sm:block">
              {side === "owner" ? "Needs your reply" : `Waiting ${counterpart}`}
            </div>
          )}
        </Link>
      </Card>
    </li>
  );
}

export function MyBookingsPage() {
  const [params, setParams] = useSearchParams();
  const side = params.get("side") === "owner" ? "owner" : "renter";

  const [state, setState] = useState({ status: "loading", bookings: [], error: null });

  useEffect(() => {
    let active = true;
    setState((prev) => ({ ...prev, status: "loading" }));

    api
      .get(`/bookings?side=${side}`)
      .then((data) => active && setState({ status: "ready", bookings: data.bookings, error: null }))
      .catch((error) => active && setState({ status: "failed", bookings: [], error: error.message }));

    return () => {
      active = false;
    };
  }, [side]);

  const active = SIDES.find((s) => s.value === side);

  return (
    <Page
      title="Your bookings"
      actions={
        <Button as={Link} to="/" variant="outline">
          Browse listings
        </Button>
      }
    >
      {/* A real tablist rather than two styled links: a screen reader user gets told
          this is a set of tabs and which one is current, and arrow keys behave. */}
      <div role="tablist" aria-label="Which side" className="mb-6 flex gap-1 border-b border-stone-200">
        {SIDES.map((option) => {
          const selected = option.value === side;
          return (
            <button
              key={option.value}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => setParams(option.value === "renter" ? {} : { side: option.value })}
              className={[
                "-mb-px border-b-2 px-4 py-2.5 text-sm font-medium transition-colors",
                selected
                  ? "border-brand-600 text-brand-700"
                  : "border-transparent text-stone-500 hover:text-stone-800",
              ].join(" ")}
            >
              {option.label}
            </button>
          );
        })}
      </div>

      {state.status === "failed" && <Alert tone="error">{state.error}</Alert>}

      {state.status === "loading" && (
        <p className="text-stone-500" role="status">
          Loading…
        </p>
      )}

      {state.status === "ready" && state.bookings.length === 0 && (
        <Card className="p-10 text-center">
          <h2 className="text-lg font-semibold text-stone-900">{active.empty}</h2>
          <p className="mx-auto mt-2 max-w-md leading-relaxed text-stone-600">
            {side === "renter"
              ? "Find something nearby and ask its owner — nothing is charged until they say yes."
              : "Published listings show up in browse. A request will appear here when somebody wants one."}
          </p>
          <Button
            as={Link}
            to={side === "renter" ? "/" : "/listings/mine"}
            variant="outline"
            className="mt-6"
          >
            {side === "renter" ? "Browse listings" : "Your listings"}
          </Button>
        </Card>
      )}

      {state.bookings.length > 0 && (
        <ul className="space-y-3">
          {state.bookings.map((booking) => (
            <BookingRow key={booking.id} booking={booking} side={side} />
          ))}
        </ul>
      )}
    </Page>
  );
}

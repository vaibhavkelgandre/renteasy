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
 *
 * ONE PANEL OF DIVIDED ROWS, NOT A STACK OF CARDS — same change as Your listings, for
 * the same reason. See that file's header.
 */

import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Page, StatusBadge } from "../components/ui/Page.jsx";
import { Button } from "../components/ui/Button.jsx";
import { Alert } from "../components/ui/Alert.jsx";
import { api } from "../lib/api.js";
import { formatRange } from "../lib/dates.js";
import { formatPaise } from "../lib/money.js";

const SIDES = [
  { value: "renter", label: "Renting", empty: "You have not requested anything yet." },
  { value: "owner", label: "Lending", empty: "Nobody has asked to rent your things yet." },
];

function BookingRow({ booking, side }) {
  const counterpart = side === "renter" ? "from the owner" : "from a renter";
  const needsAttention = booking.availableActions.length > 0 && booking.status === "REQUESTED";

  return (
    <li className="border-b border-line last:border-b-0">
      <Link
        to={`/bookings/${booking.id}`}
        className={[
          "relative flex gap-4 p-4 transition-colors hover:bg-raised",
          // A RULE DOWN THE LEADING EDGE for a row that wants something from you. A
          // whole-row tint would be the louder option and would fight the hover state;
          // this stays legible under the pointer and reads down a long list as a
          // column of marks you can count without reading a word.
          needsAttention
            ? "before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-accent"
            : "",
        ].join(" ")}
      >
        {/* A fixed box with a placeholder, so a booking whose listing has no photo does
            not sit at a different height from its neighbours. */}
        <div className="size-20 shrink-0 overflow-hidden rounded-xl border border-line bg-raised">
          {booking.coverUrl ? (
            <img src={booking.coverUrl} alt="" loading="lazy" className="size-full object-cover" />
          ) : (
            <div className="grid size-full place-items-center text-xs text-faint">No photo</div>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate font-semibold text-ink">{booking.listing_title}</h2>
            <StatusBadge status={booking.status} />
          </div>

          {/* The dates are the second-most-important fact on the row after the item,
              because they are what a person is actually checking when they open this
              page — "when is that thing due back". */}
          <p className="mt-1 text-sm text-ink-soft">
            {formatRange(booking.starts_at, booking.ends_at)}
          </p>

          <p className="mt-1 text-sm text-muted">
            <span className="tabular">{formatPaise(booking.renter_total_paise)}</span>
            {booking.deposit_paise > 0 && <span className="text-faint"> incl. deposit</span>}
          </p>
        </div>

        {/* Says WHY this row wants attention, rather than only that it does. */}
        {needsAttention && (
          <div className="hidden shrink-0 self-center text-sm font-semibold text-accent sm:block">
            {side === "owner" ? "Needs your reply" : `Waiting ${counterpart}`}
          </div>
        )}
      </Link>
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
          this is a set of tabs and which one is current, and arrow keys behave.

          The indicator is the same 2px accent rule the header nav uses, so "which
          thing am I looking at" has one answer everywhere in the product. */}
      <div role="tablist" aria-label="Which side" className="mb-6 flex gap-1 border-b border-line">
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
                "-mb-px border-b-2 px-4 py-2.5 text-sm font-semibold transition-colors",
                selected
                  ? "border-accent text-ink"
                  : "border-transparent text-muted hover:border-line-strong hover:text-ink",
              ].join(" ")}
            >
              {option.label}
            </button>
          );
        })}
      </div>

      {state.status === "failed" && <Alert tone="error">{state.error}</Alert>}

      {state.status === "loading" && (
        <p className="text-muted" role="status">
          Loading…
        </p>
      )}

      {state.status === "ready" && state.bookings.length === 0 && (
        <div className="py-16 text-center">
          <h2 className="text-xl font-bold text-ink">{active.empty}</h2>
          <p className="mx-auto mt-2 max-w-md leading-relaxed text-muted">
            {side === "renter"
              ? "Find something nearby and ask its owner — nothing is charged until they say yes."
              : "Published listings show up in browse. A request will appear here when somebody wants one."}
          </p>
          <Button
            as={Link}
            to={side === "renter" ? "/" : "/listings/mine"}
            variant="outline"
            className="mt-7"
          >
            {side === "renter" ? "Browse listings" : "Your listings"}
          </Button>
        </div>
      )}

      {state.bookings.length > 0 && (
        <ul className="overflow-hidden rounded-2xl border border-line bg-surface">
          {state.bookings.map((booking) => (
            <BookingRow key={booking.id} booking={booking} side={side} />
          ))}
        </ul>
      )}
    </Page>
  );
}

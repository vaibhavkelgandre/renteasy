/**
 * The owner's own listings — FR-115. Drafts included, which is the point.
 *
 * A draft is invisible everywhere else in the product, so if this page hid them too
 * they would be unreachable: written once, then lost. That is why the status is shown
 * on every row rather than only on the unusual ones.
 */

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Card } from "../components/ui/Card.jsx";
import { Button } from "../components/ui/Button.jsx";
import { Alert } from "../components/ui/Alert.jsx";
import { api } from "../lib/api.js";
import { formatPaise, RATE_UNITS } from "../lib/money.js";

const STATUS_STYLES = {
  DRAFT: { label: "Draft", className: "bg-stone-100 text-stone-700" },
  PUBLISHED: { label: "Live", className: "bg-emerald-50 text-emerald-800" },
  UNPUBLISHED: { label: "Hidden", className: "bg-amber-50 text-amber-800" },
};

function StatusBadge({ status }) {
  const { label, className } = STATUS_STYLES[status] ?? STATUS_STYLES.DRAFT;
  return (
    <span
      className={`inline-flex whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ${className}`}
    >
      {label}
    </span>
  );
}

/** The cheapest-looking summary of a rate card, for a list row. */
function RateSummary({ listing }) {
  const rates = RATE_UNITS.filter((unit) => listing[unit.column] != null);

  if (rates.length === 0) {
    return <span className="text-sm text-amber-700">No price set</span>;
  }

  return (
    <span className="text-sm text-stone-600">
      {rates.map((unit) => `${formatPaise(listing[unit.column])}/${unit.short}`).join(" · ")}
    </span>
  );
}

export function MyListingsPage() {
  const [state, setState] = useState({ status: "loading", listings: [], error: null });

  useEffect(() => {
    let active = true;

    api
      .get("/listings/mine")
      .then((data) => active && setState({ status: "ready", listings: data.listings, error: null }))
      .catch((error) => active && setState({ status: "failed", listings: [], error: error.message }));

    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="mx-auto w-full max-w-6xl">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight text-stone-900">Your listings</h1>
        <Button as={Link} to="/listings/new">
          List something
        </Button>
      </div>

      {state.status === "failed" && (
        <Alert tone="error" className="mt-6">
          {state.error}
        </Alert>
      )}

      {state.status === "loading" && (
        <p className="mt-8 text-stone-500" role="status">
          Loading…
        </p>
      )}

      {state.status === "ready" && state.listings.length === 0 && (
        <Card className="mt-8 p-8 text-center">
          <h2 className="text-lg font-semibold text-stone-900">Nothing listed yet</h2>
          <p className="mx-auto mt-2 max-w-sm leading-relaxed text-stone-600">
            A camera gathering dust, a drill you use twice a year, a bike nobody rides.
            Someone nearby needs it this weekend.
          </p>
          <Button as={Link} to="/listings/new" size="lg" className="mt-7">
            List your first item
          </Button>
        </Card>
      )}

      {state.status === "ready" && state.listings.length > 0 && (
        <ul className="mt-8 space-y-3">
          {state.listings.map((listing) => (
            <li key={listing.id}>
              <Card className="overflow-hidden">
                <Link
                  to={`/listings/${listing.id}/edit`}
                  className="flex gap-4 p-4 transition-colors hover:bg-stone-50"
                >
                  {/* Fixed box with a placeholder, so a listing with no photo yet does
                      not collapse the row to a different height than its neighbours. */}
                  <div className="size-20 shrink-0 overflow-hidden rounded-xl bg-stone-100">
                    {listing.coverUrl ? (
                      <img
                        src={listing.coverUrl}
                        alt=""
                        className="size-full object-cover"
                        loading="lazy"
                      />
                    ) : (
                      <div className="grid size-full place-items-center text-xs text-stone-400">
                        No photo
                      </div>
                    )}
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="truncate font-medium text-stone-900">{listing.title}</h2>
                      <StatusBadge status={listing.status} />
                    </div>
                    <p className="mt-1 text-sm text-stone-500">{listing.category_name}</p>
                    <div className="mt-1.5">
                      <RateSummary listing={listing} />
                    </div>
                  </div>
                </Link>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

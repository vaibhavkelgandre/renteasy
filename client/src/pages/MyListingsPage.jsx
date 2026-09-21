/**
 * The owner's own listings — FR-115. Drafts included, which is the point.
 *
 * A draft is invisible everywhere else in the product, so if this page hid them too
 * they would be unreachable: written once, then lost. That is why the status is shown
 * on every row rather than only on the unusual ones.
 *
 * ONE PANEL OF DIVIDED ROWS, NOT A STACK OF CARDS. Each listing used to be its own
 * bordered card with its own shadow, which at six listings is six floating rectangles
 * — the pattern the redesign brief names as making an app look generated. A single
 * surface with hairline dividers says "this is one list", which is what it is, and it
 * gets the rows closer together so more of the inventory is on screen at once.
 */

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "../components/ui/Button.jsx";
import { Alert } from "../components/ui/Alert.jsx";
import { Page, StatusBadge } from "../components/ui/Page.jsx";
import { api } from "../lib/api.js";
import { formatPaise, RATE_UNITS } from "../lib/money.js";

/**
 * Every rate this listing offers, on one line.
 *
 * ONE TEXT NODE, deliberately — the rates are joined into a single string rather than
 * mapped to a span each. An owner scanning their own inventory reads this as one fact
 * ("what am I charging"), and splitting it into elements would also break the
 * assertion that pins the separator.
 */
function RateSummary({ listing }) {
  const rates = RATE_UNITS.filter((unit) => listing[unit.column] != null);

  if (rates.length === 0) {
    // The one thing on this page that is actually wrong, so it gets the accent. A
    // published listing with no price cannot be booked.
    return <span className="text-sm font-medium text-accent">No price set</span>;
  }

  return (
    <span className="tabular text-sm text-ink-soft">
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

  const count = state.listings.length;

  return (
    <Page
      title="Your listings"
      description={
        state.status === "ready" && count > 0
          ? `${count} item${count === 1 ? "" : "s"} you are lending out.`
          : undefined
      }
      actions={
        <Button as={Link} to="/listings/new">
          List an item
        </Button>
      }
    >
      {state.status === "failed" && <Alert tone="error">{state.error}</Alert>}

      {state.status === "loading" && (
        <p className="text-muted" role="status">
          Loading…
        </p>
      )}

      {state.status === "ready" && count === 0 && (
        // NOT A CARD. A bordered panel drawn around an empty state is a box containing
        // nothing, which is twice as empty as the empty state on its own.
        <div className="py-16 text-center">
          <h2 className="text-xl font-bold text-ink">Nothing listed yet</h2>
          <p className="mx-auto mt-2 max-w-sm leading-relaxed text-muted">
            A camera gathering dust, a drill you use twice a year, a bike nobody rides.
            Someone nearby needs it this weekend.
          </p>
          <Button as={Link} to="/listings/new" size="lg" className="mt-7">
            List your first item
          </Button>
        </div>
      )}

      {state.status === "ready" && count > 0 && (
        <ul className="overflow-hidden rounded-2xl border border-line bg-surface">
          {state.listings.map((listing) => (
            <li
              key={listing.id}
              className="flex flex-wrap items-center gap-4 border-b border-line p-4 transition-colors last:border-b-0 hover:bg-raised sm:flex-nowrap"
            >
              {/* THE ROW IS NOT ONE BIG LINK, and that is what fixed the layout rather
                  than any amount of spacing. A whole-row anchor cannot contain the
                  per-listing actions — nesting one anchor in another is invalid HTML
                  and the browser silently drops the inner one — so Availability had to
                  live in a strip underneath, stranded on its own line at the far right
                  of an otherwise empty band.

                  With the title as the link, the actions sit where they belong: in the
                  row, at the end, next to the thing they act on. */}

              {/* Fixed box with a placeholder, so a listing with no photo yet does not
                  collapse the row to a different height than its neighbours. */}
              <div className="size-20 shrink-0 overflow-hidden rounded-xl border border-line bg-raised">
                {listing.coverUrl ? (
                  <img
                    src={listing.coverUrl}
                    alt=""
                    className="size-full object-cover"
                    loading="lazy"
                  />
                ) : (
                  <div className="grid size-full place-items-center px-1 text-center text-xs text-faint">
                    No photo
                  </div>
                )}
              </div>

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="truncate font-semibold text-ink">
                    <Link
                      to={`/listings/${listing.id}/edit`}
                      // `after:absolute inset-0` would make the whole row clickable
                      // again and bring the nested-anchor problem back with it. The
                      // title is the link; the buttons are buttons.
                      className="transition-colors hover:text-accent"
                    >
                      {listing.title}
                    </Link>
                  </h2>
                  <StatusBadge status={listing.status} />
                </div>

                {/* Category and price on ONE line rather than two stacked ones. They
                    are both single short facts, and giving each its own line is what
                    made every row 96px tall for 40px of content. */}
                <div className="mt-1 flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                  <span className="text-sm text-muted">{listing.category_name}</span>
                  <span className="text-line-strong" aria-hidden="true">
                    ·
                  </span>
                  <RateSummary listing={listing} />
                </div>
              </div>

              {/* `w-full sm:w-auto` — stacked under the row on a phone, inline beside
                  it from `sm` up. Two small buttons squeezed against a thumbnail on a
                  360px screen is how a row becomes three lines of wrapped text. */}
              <div className="flex w-full shrink-0 gap-2 sm:w-auto">
                <Button
                  as={Link}
                  to={`/listings/${listing.id}/availability`}
                  variant="outline"
                  size="sm"
                >
                  Availability
                </Button>
                <Button as={Link} to={`/listings/${listing.id}/edit`} variant="outline" size="sm">
                  Edit
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}

/**
 * The marketing hero at the top of the home page (`/`).
 *
 * NO SEARCH BOX HERE, on purpose. `SearchBox` lives in the header and nowhere else —
 * its own file explains why: a second instance would share its accessible name
 * ("Search listings") with the header's copy, which breaks `getByLabelText` in tests
 * and is two implementations of one control drifting apart. This hero's job is to
 * sell the idea and hand off to the header search or the categories below it, not to
 * duplicate the search itself.
 *
 * TWO CTAs, ONE PRIMARY. "Browse listings" just scrolls to the results already on this
 * same page — there is no separate route to send someone to. "List your item" goes
 * through the ordinary `/listings/new` route, which is already behind `RequireAuth`;
 * a signed-out visitor clicking it is bounced to `/login` and back by the existing
 * guard, so this component needs no auth check of its own.
 */

import { Link } from "react-router-dom";
import { Button } from "../ui/Button.jsx";

/**
 * @param {object} props
 * @param {number|null} [props.totalListings] Live count, once the results below have
 *        loaded. `null` while loading or on failure — the line is omitted rather than
 *        shown as "0 listings" for a moment on every load.
 * @param {() => void} props.onBrowseClick Scrolls to the results section.
 */
export function HomeHero({ totalListings = null, onBrowseClick }) {
  return (
    <section className="relative overflow-hidden pb-14 pt-6 sm:pb-20 sm:pt-10">
      <div className="max-w-2xl">
        {totalListings != null && totalListings > 0 && (
          // A LIVE FIGURE, NOT A SLOGAN. "Trusted by thousands" on a fresh
          // marketplace is the kind of claim nobody believes; a real count of what
          // is actually listed right now is small and true instead.
          <p className="mb-4 inline-flex items-center gap-2 rounded-full border border-line bg-raised px-3 py-1 text-xs font-semibold text-muted">
            <span className="size-1.5 rounded-full bg-good" aria-hidden="true" />
            <span className="tabular text-ink">{totalListings}</span> listings available
            right now
          </p>
        )}

        {/* The site's original tagline — used here rather than invented, because it
            already describes the product rather than the screen underneath it, which
            is exactly the job a hero headline has and a results-page heading does
            not. */}
        <h1 className="text-4xl font-bold leading-[1.1] tracking-tight text-ink sm:text-5xl">
          Rent almost anything, <span className="text-accent">nearby</span>.
        </h1>

        <p className="mt-4 max-w-lg text-lg leading-relaxed text-muted">
          Cameras, tools, bikes and the rest — by the hour, the day or the month, from
          people a few streets away instead of a warehouse.
        </p>

        <div className="mt-8 flex flex-wrap items-center gap-3">
          <Button size="lg" onClick={onBrowseClick}>
            Browse listings
          </Button>
          <Button as={Link} to="/listings/new" size="lg" variant="outline">
            List your item
          </Button>
        </div>

        <p className="mt-5 text-sm text-faint">
          Free to browse — creating an account is only needed to list something or
          reserve one.
        </p>
      </div>
    </section>
  );
}

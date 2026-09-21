/**
 * Browse — the landing page, and the only way to find a listing you do not already
 * have a link to. FR-300 to FR-309.
 *
 * Public, and the same page whether you are signed in or not.
 *
 * FILTER STATE LIVES IN THE URL, not in component state, and that is the decision this
 * page turns on. A filtered view is then shareable, survives a refresh, and works with
 * the back button — press back after opening a listing and you return to the same page
 * of the same filtered result rather than to an unfiltered page one. It also means
 * there is exactly one source of truth for what is being shown; a `useState` mirror
 * alongside the URL is how those two drift apart.
 *
 * The search bar lives in the header, so this page READS `q` and `city` from the URL
 * and does not own the control that writes them. The URL is the interface between the
 * two, which is why moving the box needed no state lifted anywhere.
 */

import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Button } from "../components/ui/Button.jsx";
import { Alert } from "../components/ui/Alert.jsx";
import { Page } from "../components/ui/Page.jsx";
import { api } from "../lib/api.js";
import { useAuth } from "../context/AuthContext.jsx";
import { toDateInput } from "../lib/dates.js";
import { formatPaise, parseRupeesToPaise, RATE_UNITS } from "../lib/money.js";

/** Must match BROWSE_DEFAULT_LIMIT on the server, or the pager miscounts pages. */
const PAGE_SIZE = 24;

const SORTS = [
  { value: "newest", label: "Newest first" },
  { value: "price_asc", label: "Cheapest first" },
  { value: "price_desc", label: "Most expensive" },
];

const UNITS = [
  { value: "hourly", label: "Per hour" },
  { value: "daily", label: "Per day" },
  { value: "monthly", label: "Per month" },
];

/**
 * One class string for every control in the filter rail.
 *
 * They sit in a narrow column one under another, so any difference in height or radius
 * between two of them reads as a mistake rather than as variety — which is exactly what
 * happened when each carried its own copy of these classes in the old filter row.
 */
const CONTROL =
  "h-10 w-full rounded-lg border border-line bg-raised px-2.5 text-sm text-ink " +
  "transition-colors focus:border-accent";

/**
 * A visible label above a filter control.
 *
 * The old row had none — every control was labelled only by `aria-label` and by
 * whatever its default option happened to say, so "All categories" and "Anywhere" had
 * to double as their own headings. A column has the room to say what each one is.
 */
function FilterField({ label, children }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-faint">
        {label}
      </span>
      {children}
    </label>
  );
}

/**
 * A removable chip for one filter that is currently on.
 *
 * THE RAIL IS NOT ENOUGH ON ITS OWN. On a phone it is behind a button, and even on a
 * desktop a `<select>` showing "Cameras" is easy to scroll past — so a narrowed result
 * looks like an empty catalogue rather than like a narrow search. The chips sit
 * directly above the grid, where the confusion actually happens, and each one undoes
 * exactly itself.
 */
function FilterChip({ label, onClear }) {
  return (
    <button
      type="button"
      onClick={onClear}
      className="group inline-flex items-center gap-1.5 rounded-full border border-accent-line bg-accent-soft py-1 pl-3 pr-2 text-xs font-semibold text-accent transition-colors hover:border-accent"
    >
      {label}
      <svg
        className="size-3.5 text-accent/60 transition-colors group-hover:text-accent"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        aria-hidden="true"
      >
        <path d="M18 6 6 18M6 6l12 12" />
      </svg>
    </button>
  );
}

/** The rate to show on a tile, for the unit currently being browsed. */
function tileRate(listing, unit) {
  const chosen = RATE_UNITS.find((rate) => rate.key.startsWith(unit));
  if (chosen && listing[chosen.column] != null) {
    return { amount: listing[chosen.column], short: chosen.short };
  }

  // Falls back to whatever rate exists rather than showing nothing: a listing that
  // rents by the month is still worth seeing while browsing daily rates, and a tile
  // with no price at all reads as broken.
  const available = RATE_UNITS.find((rate) => listing[rate.column] != null);
  return available ? { amount: listing[available.column], short: available.short } : null;
}

/**
 * One item in the grid.
 *
 * THE PHOTOGRAPH IS THE TILE. Everything else is a caption on it, which is why there
 * is no card border, no card background and no padding around the image — the picture
 * runs to the edge of its own rounded box and the text sits underneath on the page
 * itself. A bordered white panel with an image inset inside it is the "product card"
 * of an admin table; a marketplace shows the object.
 *
 * NO FAVOURITE BUTTON, deliberately. The redesign brief sketches a heart in the corner
 * and there is no favourites feature behind it — a control that looks saveable and
 * saves nothing is worse than no control.
 */
function ListingTile({ listing, unit }) {
  const rate = tileRate(listing, unit);

  return (
    <li>
      <Link
        to={`/listings/${listing.id}`}
        // The whole tile is one link. A card where only the title is clickable is a
        // card people click and nothing happens on.
        className="group block"
      >
        {/* 4:3. The tiles went from three across to four at the widest size, so each
            one is narrower than it was — and at 16:10 a narrow tile is a letterbox
            with no object in it. A squarer crop is what makes a drill look like a
            drill at 280px wide. */}
        <div className="relative aspect-[4/3] overflow-hidden rounded-xl border border-line bg-raised">
          {listing.coverUrl ? (
            <img
              src={listing.coverUrl}
              alt=""
              // Lazy: a full grid is 24 image requests and only the first few are on
              // screen.
              loading="lazy"
              // 500ms and 5%. At the old 200ms/2% the effect was too small to register
              // as intentional and just looked like a rendering wobble — either commit
              // to it or leave the image still.
              className="size-full object-cover transition-transform duration-500 group-hover:scale-105"
            />
          ) : (
            <div className="grid size-full place-items-center text-sm text-faint">No photo</div>
          )}

          {/* A GRADIENT SCRIM, NOT A BLURRED WHITE PILL. Over an unknown photograph a
              translucent light chip goes muddy on a dark image and illegible on a busy
              one; a dark gradient rising from the bottom edge is readable over
              anything, and it also does the work of tying the picture into the
              near-black page under it. */}
          <div
            className="absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-canvas/90 to-transparent"
            aria-hidden="true"
          />

          <span className="absolute bottom-2.5 left-2.5 text-[11px] font-semibold uppercase tracking-wider text-ink/80">
            {listing.category_name}
          </span>

          {/* The border warms on hover rather than the whole tile lifting. Twenty-four
              tiles that each jump a pixel is a page that flickers as the pointer
              crosses it. */}
          <div
            className="pointer-events-none absolute inset-0 rounded-xl ring-1 ring-inset ring-transparent transition-colors group-hover:ring-accent/40"
            aria-hidden="true"
          />
        </div>

        <div className="mt-3">
          <h3 className="line-clamp-2 font-semibold leading-snug text-ink transition-colors group-hover:text-accent">
            {listing.title}
          </h3>

          <p className="mt-0.5 truncate text-sm text-muted">
            {listing.city ? `${listing.locality}, ${listing.city}` : listing.category_name}
          </p>

          {rate && (
            // THE PRICE IS THE SECOND THING READ AFTER THE PICTURE, so it is the
            // brightest text on the tile and the only tabular figure. The unit is
            // deliberately muted and small: "per day" is the same on almost every
            // tile, so setting it at the same weight as the number would make a column
            // of prices harder to compare, not easier.
            <p className="mt-2 flex items-baseline gap-1">
              <span className="tabular text-lg font-bold tracking-tight text-ink">
                {formatPaise(rate.amount)}
              </span>
              <span className="text-sm text-muted">/ {rate.short}</span>
            </p>
          )}
        </div>
      </Link>
    </li>
  );
}

export function HomePage() {
  const [params, setParams] = useSearchParams();

  // Only to decide whether to explain the exclusion — the server does the excluding,
  // from the session, so a stale value here can never change what is shown.
  const { user } = useAuth();

  // Local, not `toISOString().slice(0, 10)` — east of UTC that yields tomorrow after
  // the afternoon, which would make today unselectable.
  const todayValue = toDateInput(new Date());
  const [state, setState] = useState({ status: "loading", listings: [], total: 0, error: null });
  const [categories, setCategories] = useState([]);
  const [cities, setCities] = useState([]);
  // Mobile only. The rail is always present on `lg` and up, where this is ignored.
  const [filtersOpen, setFiltersOpen] = useState(false);

  // Read straight from the URL on every render. Nothing is mirrored, so nothing can
  // fall out of sync.
  const q = params.get("q") ?? "";
  const category = params.get("category") ?? "";
  const city = params.get("city") ?? "";
  const unit = params.get("unit") ?? "daily";
  const sort = params.get("sort") ?? "newest";
  const maxRupees = params.get("maxRupees") ?? "";

  // FR-303. `YYYY-MM-DD` in the URL rather than an instant: a shareable link should
  // say "free on the 3rd", not carry somebody else's timezone and minutes.
  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "";

  const offset = Number(params.get("offset") ?? 0);

  /**
   * Writes filters into the URL.
   *
   * RESETS `offset` UNLESS THE CHANGE IS THE PAGE ITSELF. A narrower filter can match
   * fewer rows than the current offset, which renders an empty page reading as "no
   * matches" when the real cause is being on page four of a two-page result.
   */
  function apply(changes, { keepOffset = false } = {}) {
    const next = new URLSearchParams(params);

    for (const [key, value] of Object.entries(changes)) {
      if (value === "" || value == null) next.delete(key);
      else next.set(key, String(value));
    }

    if (!keepOffset) next.delete("offset");
    setParams(next);
  }

  useEffect(() => {
    let active = true;

    Promise.all([api.get("/listings/categories"), api.get("/listings/cities")])
      .then(([categoryData, cityData]) => {
        if (!active) return;
        setCategories(categoryData.categories);
        setCities(cityData.cities);
      })
      // Filter options failing to load must not stop the results rendering.
      .catch(() => {});

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;

    const query = new URLSearchParams();
    if (q) query.set("q", q);
    if (category) query.set("category", category);
    if (city) query.set("city", city);
    if (sort !== "newest") query.set("sort", sort);
    query.set("unit", unit);
    if (offset) query.set("offset", String(offset));

    // Rupees on screen, paise on the wire — converted here, once, at the boundary.
    const maxPaise = parseRupeesToPaise(maxRupees);
    if (maxPaise != null) query.set("maxPricePaise", String(maxPaise));

    // BOTH OR NEITHER. The server refuses a half-open range (400), so sending one
    // alone would turn a half-filled form into an error message rather than the
    // unfiltered results the reader is looking at. A date alone simply does nothing
    // until its partner arrives.
    if (from && to) {
      // Local midnight to local midnight, matching the `[)` bounds the server compares
      // against — `new Date("2026-10-03")` would be parsed as UTC and shift the window
      // by the reader's offset.
      query.set("availableFrom", new Date(`${from}T00:00`).toISOString());
      query.set("availableTo", new Date(`${to}T00:00`).toISOString());
    }

    api
      .get(`/listings?${query}`)
      .then((data) => {
        if (!active) return;
        setState({ status: "ready", listings: data.listings, total: data.total, error: null });
      })
      .catch((error) => {
        if (!active) return;
        setState({ status: "failed", listings: [], total: 0, error: error.message });
      });

    return () => {
      active = false;
    };
  }, [q, category, city, unit, sort, maxRupees, from, to, offset]);

  const hasFilters = Boolean(q || category || city || maxRupees || from || to);
  const lastOffset = Math.max(0, Math.floor((state.total - 1) / PAGE_SIZE) * PAGE_SIZE);

  // Built from the URL rather than tracked alongside it, for the same reason
  // everything else on this page is: two lists of "what is filtered" would disagree.
  const activeChips = [
    q && { key: "q", label: `"${q}"`, clear: { q: "" } },
    category && {
      key: "category",
      label: categories.find((option) => option.slug === category)?.name ?? category,
      clear: { category: "" },
    },
    city && { key: "city", label: city, clear: { city: "" } },
    maxRupees && { key: "max", label: `Under ₹${maxRupees}`, clear: { maxRupees: "" } },
    from && to && { key: "dates", label: `${from} to ${to}`, clear: { from: "", to: "" } },
  ].filter(Boolean);

  return (
    <Page
      // COPY, not a feature: "Rent almost anything, nearby" described the site;
      // "Available near you" describes what is on the screen underneath it, which is
      // what a heading directly above a grid of results should do.
      title="Available near you"
      description="Cameras, tools, bikes and the rest — by the hour, the day or the month, from people nearby."
    >
      <div className="grid gap-x-8 gap-y-6 lg:grid-cols-[228px_minmax(0,1fr)] lg:items-start">
        {/* ============================================================
            THE FILTER RAIL.

            A COLUMN, NOT A ROW ACROSS THE TOP. As a row it pushed the first result off
            the screen — six controls plus a date range is two wrapped lines before
            anything you can actually rent. In a column they cost width, which this grid
            has, instead of height, which it does not.

            NO CARD AROUND IT ANY MORE. It used to be a bordered white panel, which on
            the dark palette would put a second large rectangle beside the grid and make
            the page read as two documents. A single hairline on the right edge
            separates it from the results, and each control is its own well — so the
            controls are the objects and the rail is just where they live.

            ON A PHONE IT IS A BOTTOM SHEET. Same element, moved: rendering a second
            copy inside a drawer would mean two `<select aria-label="Category">` in one
            document, which is both an accessibility defect and an ambiguous query for
            every test that looks one up.
            ============================================================ */}
        {filtersOpen && (
          <button
            type="button"
            aria-label="Close filters"
            onClick={() => setFiltersOpen(false)}
            className="fixed inset-0 z-40 bg-canvas/70 backdrop-blur-sm lg:hidden"
          />
        )}

        <aside
          aria-label="Filters"
          className={[
            "space-y-4",
            // Phone: a sheet off the bottom edge.
            "fixed inset-x-0 bottom-0 z-50 max-h-[85vh] overflow-y-auto rounded-t-2xl",
            "border-t border-line bg-surface p-5 shadow-2xl shadow-black/70",
            "transition-transform duration-200 ease-out",
            filtersOpen ? "translate-y-0" : "translate-y-full",
            // Desktop: back in the flow, sticky, transparent, ruled on the right.
            "lg:static lg:z-auto lg:max-h-none lg:translate-y-0 lg:overflow-visible",
            "lg:rounded-none lg:border-0 lg:border-r lg:border-line lg:bg-transparent",
            "lg:p-0 lg:pr-8 lg:shadow-none lg:sticky lg:top-20",
          ].join(" ")}
        >
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-semibold text-ink">Filter</h2>
            {hasFilters && (
              <button
                type="button"
                onClick={() => setParams(new URLSearchParams())}
                className="text-xs font-semibold text-accent transition-colors hover:text-accent-hover"
              >
                Clear filters
              </button>
            )}
          </div>

          <FilterField label="Category">
            <select
              value={category}
              onChange={(event) => apply({ category: event.target.value })}
              aria-label="Category"
              className={CONTROL}
            >
              <option value="">All categories</option>
              {categories.map((option) => (
                <option key={option.slug} value={option.slug}>
                  {option.name}
                </option>
              ))}
            </select>
          </FilterField>

          <FilterField label="Where">
            <select
              value={city}
              onChange={(event) => apply({ city: event.target.value })}
              aria-label="City"
              className={CONTROL}
            >
              <option value="">Anywhere</option>
              {cities.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </FilterField>

          <FilterField label="Rate shown">
            <select
              value={unit}
              onChange={(event) => apply({ unit: event.target.value })}
              aria-label="Rental period"
              className={CONTROL}
            >
              {UNITS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </FilterField>

          <FilterField label="Max price">
            {/* onBlur rather than onChange: committing on every keystroke would push a
                history entry and fire a request per character. */}
            <input
              type="text"
              inputMode="decimal"
              defaultValue={maxRupees}
              onBlur={(event) => apply({ maxRupees: event.target.value.trim() })}
              placeholder="Any"
              aria-label="Maximum price"
              className={`${CONTROL} placeholder:text-faint`}
            />
          </FilterField>

          {/* Grouped in a well, unlike the filters above it. A date range is two coupled
              inputs that mean nothing apart, and standing them next to four independent
              dropdowns invites filling in one and wondering why nothing happened —
              which the caption then answers. */}
          <div className="rounded-xl border border-line bg-surface p-3 lg:bg-raised/40">
            <div className="flex items-baseline justify-between">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-faint">
                Free between
              </h3>
              {(from || to) && (
                <button
                  type="button"
                  onClick={() => apply({ from: "", to: "" })}
                  className="text-xs font-semibold text-accent transition-colors hover:text-accent-hover"
                >
                  Any dates
                </button>
              )}
            </div>

            <label htmlFor="available-from" className="sr-only">
              Free from
            </label>
            <input
              id="available-from"
              type="date"
              value={from}
              min={todayValue}
              onChange={(event) => apply({ from: event.target.value })}
              className={`${CONTROL} mt-2`}
            />

            <label htmlFor="available-to" className="sr-only">
              Until
            </label>
            <input
              id="available-to"
              type="date"
              value={to}
              // Never before the start. The server refuses an inverted range anyway;
              // this stops the reader constructing one in the first place.
              min={from || todayValue}
              onChange={(event) => apply({ to: event.target.value })}
              className={`${CONTROL} mt-2`}
            />

            {!(from && to) && (
              <p className="mt-2 text-xs leading-snug text-muted">
                Pick both dates to see only what is free.
              </p>
            )}
          </div>

          <FilterField label="Sort by">
            <select
              value={sort}
              onChange={(event) => apply({ sort: event.target.value })}
              aria-label="Sort by"
              className={CONTROL}
            >
              {SORTS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </FilterField>

          {/* Only in the sheet. On a desktop the results update behind the rail, so
              there is nothing to dismiss. */}
          <Button fullWidth onClick={() => setFiltersOpen(false)} className="lg:hidden">
            Show {state.total} {state.total === 1 ? "result" : "results"}
          </Button>
        </aside>

        {/* ============================================================ RESULTS */}
        <div className="min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <div className="flex items-center gap-3">
              {/* The filter button carries the count, so a phone user can see that
                  something is narrowing the result without opening the sheet. */}
              <Button
                size="sm"
                variant="outline"
                onClick={() => setFiltersOpen(true)}
                className="lg:hidden"
              >
                <svg
                  className="size-4"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  aria-hidden="true"
                >
                  <path d="M3 6h18M7 12h10M11 18h2" />
                </svg>
                Filters
                {activeChips.length > 0 && (
                  <span className="rounded-full bg-accent px-1.5 text-xs font-bold text-accent-ink">
                    {activeChips.length}
                  </span>
                )}
              </Button>

              <p className="text-sm text-muted" role="status">
                {state.status === "loading" ? (
                  "Searching…"
                ) : (
                  <>
                    <span className="tabular font-semibold text-ink">{state.total}</span>{" "}
                    {state.total === 1 ? "listing" : "listings"}
                  </>
                )}
              </p>
            </div>

            {/* SAID OUT LOUD, because a silent exclusion is indistinguishable from a
                bug. Your own items are gone from these results — you cannot book your
                own listing (FR-502), so offering one here would be a dead end — and
                without this line the first thing an owner notices is that the thing
                they just published is missing. */}
            {user && (
              <p className="text-sm text-muted">
                Your own items are in{" "}
                <Link
                  to="/listings/mine"
                  className="font-medium text-accent underline underline-offset-2 hover:text-accent-hover"
                >
                  Your listings
                </Link>
              </p>
            )}
          </div>

          {activeChips.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {activeChips.map((chip) => (
                <FilterChip key={chip.key} label={chip.label} onClear={() => apply(chip.clear)} />
              ))}
            </div>
          )}

          {state.status === "failed" && (
            <Alert tone="error" className="mt-5">
              {state.error}
            </Alert>
          )}

          {state.status === "ready" && state.listings.length === 0 && (
            // NOT A CARD. An empty state fenced inside a bordered panel in the middle
            // of an otherwise empty column is two empty rectangles instead of one.
            <div className="mt-16 text-center">
              <h2 className="text-xl font-bold text-ink">
                {hasFilters ? "Nothing matches that" : "Nothing listed yet"}
              </h2>
              <p className="mx-auto mt-2 max-w-md leading-relaxed text-muted">
                {hasFilters
                  ? "Try a wider search — fewer filters, or a different city."
                  : "Be the first. A camera gathering dust, a drill you use twice a year — someone nearby needs it this weekend."}
              </p>
              <Button
                as={Link}
                to={hasFilters ? "/" : "/listings/new"}
                variant="outline"
                className="mt-7"
              >
                {hasFilters ? "Clear filters" : "List something"}
              </Button>
            </div>
          )}

          {/* A FOURTH COLUMN AT THE WIDEST SIZE, not four wider cards. The container
              going 1152px → 1440px hands this grid ~290px more, and spending it on the
              existing three would make each card wider — which at a fixed aspect ratio
              makes it TALLER too, so a wider page would show FEWER listings per screen
              than the narrow one did. Another column is the only way the extra width
              becomes more to look at.

              `gap-y` is larger than `gap-x` on purpose: the vertical gap has to
              separate one tile's price from the next tile's photograph, which is a
              bigger jump than the one between two pictures side by side. */}
          {state.listings.length > 0 && (
            <ul className="mt-5 grid grid-cols-2 gap-x-5 gap-y-8 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
              {state.listings.map((listing) => (
                <ListingTile key={listing.id} listing={listing} unit={unit} />
              ))}
            </ul>
          )}

          {/* The pager renders only when there is more than one page — a lone disabled
              prev/next pair is noise on a result that already fits on screen. */}
          {state.total > PAGE_SIZE && (
            <nav
              className="mt-12 flex items-center justify-between gap-4 border-t border-line pt-6"
              aria-label="Pagination"
            >
              <Button
                variant="outline"
                size="sm"
                disabled={offset === 0}
                onClick={() =>
                  apply({ offset: Math.max(0, offset - PAGE_SIZE) }, { keepOffset: true })
                }
              >
                Previous
              </Button>

              <p className="tabular text-sm text-muted">
                {offset + 1}–{Math.min(offset + PAGE_SIZE, state.total)} of {state.total}
              </p>

              <Button
                variant="outline"
                size="sm"
                disabled={offset >= lastOffset}
                onClick={() => apply({ offset: offset + PAGE_SIZE }, { keepOffset: true })}
              >
                Next
              </Button>
            </nav>
          )}
        </div>
      </div>
    </Page>
  );
}

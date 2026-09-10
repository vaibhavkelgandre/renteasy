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
 * This page used to be an honest placeholder saying no listings existed and promising
 * that "this copy becomes a search bar" when step 3 landed. It has.
 */

import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Card } from "../components/ui/Card.jsx";
import { Button } from "../components/ui/Button.jsx";
import { Alert } from "../components/ui/Alert.jsx";
import { Page } from "../components/ui/Page.jsx";
import { api } from "../lib/api.js";
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
 * One class string for every control in the sidebar.
 *
 * They sit in a 212px column one under another, so any difference in height or radius
 * between two of them reads as a mistake rather than as variety — which is exactly
 * what happened when each carried its own copy of these classes in the old filter row.
 */
const CONTROL =
  "h-10 w-full rounded-lg border border-stone-300 bg-white px-2.5 text-sm text-stone-900";

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
      <span className="mb-1 block text-xs font-medium text-stone-600">{label}</span>
      {children}
    </label>
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

function ListingTile({ listing, unit }) {
  const rate = tileRate(listing, unit);

  return (
    <li>
      <Link
        to={`/listings/${listing.id}`}
        className="group block h-full overflow-hidden rounded-2xl border border-stone-200 bg-white transition-shadow hover:shadow-md"
      >
        {/* 16:10, not 4:3. Three tiles to a row now that the filters take a column,
            so each is wider — and at 4:3 a wider tile is also a TALLER one, which put
            barely two rows on screen. A shallower crop keeps the price visible. */}
        <div className="aspect-[16/10] overflow-hidden bg-stone-100">
          {listing.coverUrl ? (
            <img
              src={listing.coverUrl}
              alt=""
              // Lazy: a full grid is 24 image requests and only the first few are on
              // screen.
              loading="lazy"
              className="size-full object-cover transition-transform group-hover:scale-[1.02]"
            />
          ) : (
            <div className="grid size-full place-items-center text-sm text-stone-400">
              No photo
            </div>
          )}
        </div>

        <div className="p-3.5">
          <h3 className="truncate font-medium text-stone-900">{listing.title}</h3>
          <p className="mt-1 truncate text-sm text-stone-500">
            {listing.city ? `${listing.locality}, ${listing.city}` : listing.category_name}
          </p>
          {rate && (
            <p className="mt-2 font-semibold text-stone-900">
              {formatPaise(rate.amount)}
              <span className="font-normal text-stone-500">/{rate.short}</span>
            </p>
          )}
        </div>
      </Link>
    </li>
  );
}

export function HomePage() {
  const [params, setParams] = useSearchParams();

  // Local, not `toISOString().slice(0, 10)` — east of UTC that yields tomorrow after
  // the afternoon, which would make today unselectable.
  const todayValue = toDateInput(new Date());
  const [state, setState] = useState({ status: "loading", listings: [], total: 0, error: null });
  const [categories, setCategories] = useState([]);
  const [cities, setCities] = useState([]);

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

  // The one piece of local state: the search box's draft. Typing must not fire a
  // request per keystroke, so it is committed to the URL on submit.
  const [searchDraft, setSearchDraft] = useState(q);
  useEffect(() => setSearchDraft(q), [q]);

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
      // Local midnight to local midnight, matching the `[)` bounds the server
      // compares against — `new Date("2026-10-03")` would be parsed as UTC and shift
      // the window by the reader's offset.
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

  return (
    <Page
      title="Rent almost anything, nearby"
      description="By the hour, the day or the month — from people near you."
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          apply({ q: searchDraft.trim() });
        }}
        className="flex gap-2"
        role="search"
      >
        <input
          type="search"
          value={searchDraft}
          onChange={(event) => setSearchDraft(event.target.value)}
          placeholder="Camera, drill, bike…"
          aria-label="Search listings"
          className="h-12 w-full rounded-xl border border-stone-300 bg-white px-4 text-[15px] text-stone-900 placeholder:text-stone-400 focus:border-brand-600"
        />
        <Button type="submit" size="lg">
          Search
        </Button>
      </form>

      <div className="mt-5 grid gap-6 lg:grid-cols-[212px_1fr] xl:grid-cols-[232px_1fr] lg:items-start">
        {/* THE FILTERS ARE A COLUMN, NOT A ROW ACROSS THE TOP.
            As a row they pushed the first result off the screen — six controls plus a
            date range is two wrapped lines before anything you can actually rent. In a
            column they cost width, which this grid has, instead of height, which it
            does not. Sticky, so narrowing a search does not mean scrolling back up. */}
        <aside className="lg:sticky lg:top-20 space-y-3" aria-label="Filters">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-semibold text-stone-900">Filter</h2>
            {hasFilters && (
              <button
                type="button"
                onClick={() => setParams(new URLSearchParams())}
                className="text-xs font-medium text-brand-700 underline underline-offset-2"
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
              className={`${CONTROL} placeholder:text-stone-400`}
            />
          </FilterField>

          {/* Grouped and boxed, unlike the filters above it. A date range is two
              coupled inputs that mean nothing apart, and standing them next to five
              independent dropdowns invites filling in one and wondering why nothing
              happened — which the caption then answers. */}
          <div className="rounded-xl border border-stone-200 bg-stone-50 p-3">
            <div className="flex items-baseline justify-between">
              <h3 className="text-xs font-medium text-stone-600">Free between</h3>
              {(from || to) && (
                <button
                  type="button"
                  onClick={() => apply({ from: "", to: "" })}
                  className="text-xs font-medium text-brand-700 underline underline-offset-2"
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
              <p className="mt-2 text-xs leading-snug text-stone-500">
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
        </aside>

        <div className="min-w-0">
          <p className="text-sm text-stone-500" role="status">
            {state.status === "loading"
              ? "Searching…"
              : `${state.total} ${state.total === 1 ? "listing" : "listings"}`}
          </p>

      {state.status === "failed" && (
        <Alert tone="error" className="mt-4">
          {state.error}
        </Alert>
      )}

      {state.status === "ready" && state.listings.length === 0 && (
        <Card className="mt-6 p-10 text-center">
          <h2 className="text-lg font-semibold text-stone-900">
            {hasFilters ? "Nothing matches that" : "Nothing listed yet"}
          </h2>
          <p className="mx-auto mt-2 max-w-md leading-relaxed text-stone-600">
            {hasFilters
              ? "Try a wider search — fewer filters, or a different city."
              : "Be the first. A camera gathering dust, a drill you use twice a year — someone nearby needs it this weekend."}
          </p>
          <Button
            as={Link}
            to={hasFilters ? "/" : "/listings/new"}
            variant="outline"
            className="mt-6"
          >
            {hasFilters ? "Clear filters" : "List something"}
          </Button>
        </Card>
      )}

      {/* A FOURTH COLUMN AT THE WIDEST SIZE, not four wider cards. The container
          going 1152px → 1440px hands this grid ~290px more, and spending it on the
          existing three would make each card wider — which at a fixed aspect ratio
          makes it TALLER too, so a wider page would show FEWER listings per screen
          than the narrow one did. Another column is the only way the extra width
          becomes more to look at. */}
      {state.listings.length > 0 && (
        <ul className="mt-4 grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {state.listings.map((listing) => (
            <ListingTile key={listing.id} listing={listing} unit={unit} />
          ))}
        </ul>
      )}

      {/* The pager renders only when there is more than one page — a lone disabled
          prev/next pair is noise on a result that already fits on screen. */}
      {state.total > PAGE_SIZE && (
        <nav className="mt-10 flex items-center justify-between gap-4" aria-label="Pagination">
          <Button
            variant="outline"
            disabled={offset === 0}
            onClick={() => apply({ offset: Math.max(0, offset - PAGE_SIZE) }, { keepOffset: true })}
          >
            Previous
          </Button>

          <p className="text-sm text-stone-500">
            {offset + 1}–{Math.min(offset + PAGE_SIZE, state.total)} of {state.total}
          </p>

          <Button
            variant="outline"
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

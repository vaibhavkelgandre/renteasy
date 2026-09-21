/**
 * The search bar, which lives in the header and nowhere else.
 *
 * IT MOVED OUT OF THE BROWSE HERO to give the grid its vertical space back — the
 * form, its wrapper and the band it sat in were roughly 180px above the first
 * listing, on the one page whose entire job is showing listings.
 *
 * ONE INSTANCE, and that constraint drove the header's responsive layout rather than
 * the other way round. The tempting arrangement is a header search from `sm` up plus
 * a separate one on the browse page for phones — but two boxes with the same
 * accessible name means `getByLabelText(/search listings/i)` matches both, and more
 * importantly it is two implementations of one control, which is how the two end up
 * submitting to slightly different places.
 *
 * ---------------------------------------------------------------------------
 * IT IS NOW SEGMENTED — "what" and "where" in one pill, not a lone text box.
 *
 * A bare input with a magnifier is the search affordance of an admin panel: it says
 * "filter this table". Every marketplace people actually use asks two questions side
 * by side, because those are the two things a renter knows before anything else — what
 * they want, and roughly where. Splitting them also heads off the most common failed
 * search on a site like this: typing "drill pune" into one box and matching nothing.
 *
 * DATES ARE DELIBERATELY NOT HERE, which is a departure from the obvious
 * three-segment layout. A date range is two coupled controls that mean nothing apart
 * (the API refuses a half-open range), so a 56px header cannot hold them honestly —
 * and unlike "what" and "where", very few people arrive at a rental site with dates
 * already decided. They live in the browse page's filter rail, where there is room to
 * explain that both are needed.
 * ---------------------------------------------------------------------------
 */

import { useEffect, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../../lib/api.js";

/**
 * The city list, fetched at most once per page load however many times this component
 * mounts.
 *
 * A MODULE-LEVEL PROMISE, not component state. The header remounts on nothing today,
 * but a future layout change could mount this twice, and two identical requests for a
 * list that changes about once a month is the kind of waste nobody goes back and
 * finds. Rejection is swallowed by the caller: a location picker that cannot load its
 * options degrades to "Anywhere", which still searches.
 */
let cityRequest = null;
function loadCities() {
  cityRequest ??= api.get("/listings/cities").then((data) => data.cities);
  return cityRequest;
}

export function SearchBox({ className = "" }) {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [cities, setCities] = useState([]);

  useEffect(() => {
    let active = true;
    // Silent. This is a convenience on a control that works without it.
    loadCities()
      .then((list) => active && setCities(list))
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  // `useSearchParams` reads whatever URL we are on, and on a booking page `?q=` would
  // mean nothing — so the bar only reflects a term when browse is the page showing it.
  const onBrowse = location.pathname === "/";
  const q = onBrowse ? (params.get("q") ?? "") : "";
  const city = onBrowse ? (params.get("city") ?? "") : "";

  // The draft is the one piece of local state. Typing must not fire a request per
  // keystroke, so it is committed to the URL on submit.
  const [draft, setDraft] = useState(q);
  useEffect(() => setDraft(q), [q]);

  /**
   * Writes a set of changes into the URL, from wherever the reader currently is.
   *
   * MERGE, never replace. Someone who has narrowed to cameras under a price and then
   * types a word means "within this", and rebuilding the query string from the term
   * alone would silently drop every other filter they set.
   */
  function commit(changes) {
    if (onBrowse) {
      const next = new URLSearchParams(params);
      for (const [key, value] of Object.entries(changes)) {
        if (value) next.set(key, value);
        else next.delete(key);
      }

      // A narrower search can match fewer rows than the current offset, which renders
      // an empty page reading as "no matches" — same rule as every other filter.
      next.delete("offset");
      setParams(next);
      return;
    }

    // From anywhere else, searching means going to browse. Nothing to merge: whatever
    // is in the current URL belongs to a different page.
    const next = new URLSearchParams();
    for (const [key, value] of Object.entries(changes)) {
      if (value) next.set(key, value);
    }
    const query = next.toString();
    navigate(query ? `/?${query}` : "/");
  }

  function submit(event) {
    event.preventDefault();
    commit({ q: draft.trim(), city });
  }

  return (
    <form
      onSubmit={submit}
      role="search"
      className={[
        // ONE PILL WITH DIVIDERS, not three controls with gaps between them. Gaps say
        // "three separate filters"; a single enclosure says "one question with parts",
        // which is what it is.
        //
        // `focus-within` lights the whole pill rather than the segment being typed
        // into. The alternative — a ring around one third of the bar — reads as the
        // control coming apart.
        "flex min-w-0 flex-1 items-center rounded-xl border border-line bg-raised",
        "transition-colors focus-within:border-accent",
        className,
      ].join(" ")}
    >
      <div className="relative flex min-w-0 flex-1 items-center">
        <svg
          className="pointer-events-none absolute left-3 size-4 text-muted"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>

        <input
          type="search"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="What do you need?"
          aria-label="Search listings"
          // `bg-transparent` and no border of its own: the pill owns both. A segment
          // that draws its own box inside a box is the look this component exists to
          // avoid.
          //
          // The `::-webkit-search-cancel-button` override is not cosmetic — Chrome
          // draws a pale grey X in a search input which, on a dark field, is both
          // invisible and misaligned with everything else in the bar.
          className="h-10 w-full min-w-0 border-0 bg-transparent pl-9 pr-3 text-[15px] text-ink outline-none placeholder:text-faint [&::-webkit-search-cancel-button]:hidden"
        />
      </div>

      {/* WHERE. Hidden below `md` — on a phone the pill has room for one question, and
          "what" is the one nobody can search without. The browse page's filter rail
          still offers city there, so nothing becomes unreachable.

          It commits ON CHANGE rather than waiting for Search: picking from a list is
          already a deliberate act, and a dropdown that silently does nothing until you
          press a button beside it is the classic half-working filter. */}
      <div className="hidden items-center md:flex">
        <span className="h-5 w-px bg-line" aria-hidden="true" />
        <label className="sr-only" htmlFor="search-location">
          Search location
        </label>
        <select
          id="search-location"
          value={city}
          onChange={(event) => commit({ q: draft.trim(), city: event.target.value })}
          className="h-10 max-w-[9rem] cursor-pointer truncate border-0 bg-transparent pl-3 text-sm text-ink-soft outline-none"
        >
          <option value="">Anywhere</option>
          {cities.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </div>

      {/* Inset by a pixel on every side (`m-1`) so the button sits INSIDE the pill
          rather than butting against its border. That detail is most of what makes a
          compound control look made rather than assembled.

          `sr-only sm:not-sr-only` — the accessible name is always "Search", while the
          visible label appears only when there is room. Swapping the label out
          entirely on small screens would leave the button unnamed for a screen reader,
          which is the usual way an icon-only control goes wrong. */}
      <button
        type="submit"
        className="m-1 inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-accent px-3 text-sm font-semibold text-accent-ink transition-colors hover:bg-accent-hover active:bg-accent-press"
      >
        <svg
          className="size-4 sm:hidden"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <span className="sr-only sm:not-sr-only">Search</span>
      </button>
    </form>
  );
}

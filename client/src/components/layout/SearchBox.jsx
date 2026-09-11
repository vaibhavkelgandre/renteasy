/**
 * The search box, which lives in the header and nowhere else.
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
 * submitting to slightly different places. Instead the logo's wordmark collapses on
 * a narrow screen and this keeps its place.
 *
 * Being in the header also makes it work from every page, which it did not before:
 * searching from a booking or a listing used to mean navigating to browse first.
 */

import { useEffect, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "../ui/Button.jsx";

export function SearchBox({ className = "" }) {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();

  // `useSearchParams` reads whatever URL we are on, and on a booking page `?q=` would
  // mean nothing — so the box only reflects a term when browse is the page showing it.
  const onBrowse = location.pathname === "/";
  const q = onBrowse ? (params.get("q") ?? "") : "";

  // The draft is the one piece of local state. Typing must not fire a request per
  // keystroke, so it is committed to the URL on submit.
  const [draft, setDraft] = useState(q);
  useEffect(() => setDraft(q), [q]);

  function submit(event) {
    event.preventDefault();
    const term = draft.trim();

    if (onBrowse) {
      // MERGE, never replace. Someone who has narrowed to cameras in Pune and then
      // types a word means "within this", and rebuilding the query string from the
      // term alone would silently drop every other filter they set.
      const next = new URLSearchParams(params);
      if (term) next.set("q", term);
      else next.delete("q");

      // A narrower search can match fewer rows than the current offset, which renders
      // an empty page that reads as "no matches" — same rule as every other filter.
      next.delete("offset");
      setParams(next);
      return;
    }

    // From anywhere else, searching means going to browse. Nothing to merge: whatever
    // is in the current URL belongs to a different page.
    navigate(term ? `/?q=${encodeURIComponent(term)}` : "/");
  }

  return (
    <form
      onSubmit={submit}
      role="search"
      className={`flex min-w-0 flex-1 items-center gap-2 ${className}`}
    >
      <div className="relative min-w-0 flex-1">
        <svg
          className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-stone-400"
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
          placeholder="Camera, drill, bike…"
          aria-label="Search listings"
          className="h-10 w-full rounded-xl border border-stone-300 bg-white pl-9 pr-3 text-[15px] text-stone-900 placeholder:text-stone-400 focus:border-brand-600"
        />
      </div>

      {/* `sr-only sm:not-sr-only` — the accessible name is always "Search", while the
          visible label appears only when there is room for it. Swapping the label out
          entirely on small screens would leave the button unnamed for a screen
          reader, which is the usual way an icon-only control goes wrong. */}
      <Button type="submit" size="sm" className="shrink-0">
        <span className="sr-only sm:not-sr-only">Search</span>
        <svg
          className="size-4 sm:hidden"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.25"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
      </Button>
    </form>
  );
}

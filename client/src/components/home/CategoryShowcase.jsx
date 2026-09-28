/**
 * "Browse by category" — clickable tiles on the home page, above the results.
 *
 * CLICKING A TILE FILTERS THE SAME PAGE, IT DOES NOT NAVIGATE. `onSelect` is the
 * browse page's own `apply({ category: slug })` — the exact function the category
 * `<select>` in the filter rail already calls — so a tile is a second entry point
 * into the one filter state the URL owns, not a second implementation of filtering.
 *
 * A FIXED ICON PER SLUG, WITH A FALLBACK. Categories are a small, HR-managed-ish list
 * that changes rarely (there is no icon column in the database), so a hand-maintained
 * map is proportionate here — unlike, say, per-user avatars. Any slug this map does
 * not recognise (a category added after this file was written) still renders the
 * generic tile rather than breaking.
 */

const ICON_PATHS = {
  cameras: (
    <>
      <path d="M4 8h3l1.5-2h7L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z" />
      <circle cx="12" cy="13" r="3.5" />
    </>
  ),
  bikes: (
    <>
      <circle cx="6" cy="17" r="3" />
      <circle cx="18" cy="17" r="3" />
      <path d="M6 17 10 8h4l4 9M10 8 8.5 5H6.5M10 8l3 5h5" />
    </>
  ),
  tools: <path d="m14.5 6.5 3 3L8 19l-4 1 1-4Zm0 0L17 4a3 3 0 0 1 3 3l-2.5 2.5" />,
  appliances: (
    <>
      <rect x="5" y="3" width="14" height="18" rx="2" />
      <circle cx="12" cy="14" r="4" />
      <path d="M8 6.5h.01M11 6.5h.01" />
    </>
  ),
  electronics: (
    <>
      <rect x="7" y="7" width="10" height="10" rx="1.5" />
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.5 5.5l2.8 2.8M18.5 5.5l-2.8 2.8M5.5 18.5l2.8-2.8M18.5 18.5l-2.8-2.8" />
    </>
  ),
  audio: (
    <>
      <path d="M9 18V5l10-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="16" cy="16" r="3" />
    </>
  ),
  camping: (
    <>
      <path d="m4 20 8-15 8 15" />
      <path d="m9.5 20 2.5-5 2.5 5" />
    </>
  ),
  party: (
    <>
      <path d="M4.5 20 3 15l12-9 3 3-9 12Z" />
      <path d="M13 5.5 15 3M18 8.5 21 7M15.5 12.5l2.5 1" />
    </>
  ),
  sports: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 4a11 11 0 0 1 0 16M12 4a11 11 0 0 0 0 16M4 12h16" />
    </>
  ),
  other: (
    <>
      <rect x="4" y="4" width="7" height="7" rx="1.5" />
      <rect x="13" y="4" width="7" height="7" rx="1.5" />
      <rect x="4" y="13" width="7" height="7" rx="1.5" />
      <rect x="13" y="13" width="7" height="7" rx="1.5" />
    </>
  ),
};

const FALLBACK_ICON = (
  <>
    <circle cx="12" cy="12" r="8" />
    <path d="M12 8v4l3 3" />
  </>
);

function CategoryIcon({ slug }) {
  return (
    <svg
      className="size-6"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ICON_PATHS[slug] ?? FALLBACK_ICON}
    </svg>
  );
}

/**
 * @param {object} props
 * @param {{ slug: string, name: string }[]} props.categories
 * @param {(slug: string) => void} props.onSelect
 */
export function CategoryShowcase({ categories, onSelect }) {
  if (categories.length === 0) return null;

  return (
    <section aria-labelledby="browse-by-category" className="pb-12">
      <h2
        id="browse-by-category"
        className="mb-4 text-sm font-semibold uppercase tracking-[0.08em] text-muted"
      >
        Browse by category
      </h2>

      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {categories.map((category) => (
          <li key={category.slug}>
            <button
              type="button"
              onClick={() => onSelect(category.slug)}
              className={[
                "group flex w-full flex-col items-start gap-3 rounded-2xl border border-line",
                "bg-surface p-4 text-left transition-[border-color,transform,box-shadow] duration-200",
                "hover:-translate-y-0.5 hover:border-accent-line hover:shadow-lg hover:shadow-black/40",
              ].join(" ")}
            >
              {/* Neutral at rest, accent only on hover — the same restraint the tile
                  grid's own hover ring uses. The accent is the one saturated colour
                  in the app; ten tiles all wearing it permanently would spend that
                  scarcity on decoration instead of on the one thing that should stand
                  out when it matters. */}
              <span
                className={[
                  "grid size-11 place-items-center rounded-xl border border-line bg-raised text-muted",
                  "transition-colors duration-200 group-hover:border-accent-line group-hover:text-accent",
                ].join(" ")}
              >
                <CategoryIcon slug={category.slug} />
              </span>

              <span className="text-sm font-semibold leading-snug text-ink">
                {category.name}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

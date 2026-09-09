/**
 * The RentEasy mark.
 *
 * A pair of arrows in a loop — a thing goes out and comes back, which is what a rental
 * is. Inline SVG rather than a file: a handful of paths, so an <img> would cost a
 * request and a flash of nothing on first paint.
 */

/**
 * @param {object} props
 * @param {"sm"|"md"} [props.size="md"]
 * @param {boolean} [props.showWordmark=true]
 */
export function Logo({ size = "md", showWordmark = true }) {
  const box = size === "sm" ? "size-8 rounded-lg" : "size-10 rounded-xl";
  const glyph = size === "sm" ? "size-4" : "size-5";

  return (
    <span className="inline-flex items-center gap-2.5">
      <span className={`grid place-items-center bg-brand-600 ${box}`}>
        {/* White on brand-600 passes contrast comfortably. The equivalent mark on a
            light accent would need dark text instead. */}
        <svg
          className={`${glyph} text-white`}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.25"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M3 12a9 9 0 0 1 9-9 9 9 0 0 1 7.5 4" />
          <path d="M20 3v4.5h-4.5" />
          <path d="M21 12a9 9 0 0 1-9 9 9 9 0 0 1-7.5-4" />
          <path d="M4 21v-4.5h4.5" />
        </svg>
      </span>

      {showWordmark && (
        <span className={`font-semibold tracking-tight text-stone-900 ${size === "sm" ? "text-base" : "text-lg"}`}>
          Rent<span className="text-brand-600">Easy</span>
        </span>
      )}
    </span>
  );
}

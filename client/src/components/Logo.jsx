/**
 * The RentEasy mark.
 *
 * A pair of arrows in a loop — a thing goes out and comes back, which is what a rental
 * is. Inline SVG rather than a file: a handful of paths, so an <img> would cost a
 * request and a flash of nothing on first paint.
 *
 * ON THE DARK PALETTE THE MARK IS THE ACCENT ON A DARK TILE, not white on a filled
 * amber square. A saturated amber block in the top-left corner competes with the one
 * button on the page that is supposed to be the only saturated amber thing — and the
 * logo is not an action.
 */

/**
 * @param {object} props
 * @param {"sm"|"md"} [props.size="md"]
 * @param {boolean} [props.showWordmark=true]
 * @param {string} [props.wordmarkClassName] Extra classes on the wordmark only.
 *        Exists so the header can collapse it to the mark alone on a narrow screen
 *        (`hidden sm:inline`) — a CSS hide rather than a second `<Logo showWordmark>`
 *        call, because rendering the logo twice and hiding one is how two copies of
 *        a brand mark drift apart.
 */
export function Logo({ size = "md", showWordmark = true, wordmarkClassName = "" }) {
  const box = size === "sm" ? "size-8 rounded-lg" : "size-10 rounded-xl";
  const glyph = size === "sm" ? "size-4" : "size-5";

  return (
    <span className="group/logo inline-flex items-center gap-2.5">
      <span
        className={`grid place-items-center border border-accent-line bg-accent-soft text-accent transition-colors group-hover/logo:border-accent/60 ${box}`}
      >
        <svg
          className={glyph}
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
        <span
          className={`font-extrabold tracking-tight text-ink ${size === "sm" ? "text-base" : "text-lg"} ${wordmarkClassName}`}
        >
          Rent<span className="text-accent">Easy</span>
        </span>
      )}
    </span>
  );
}

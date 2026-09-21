/**
 * A star rating with its count — FR-806.
 *
 * ONE COMPONENT FOR EVERY PLACE A RATING APPEARS, because the alternative is a
 * listing page that says "4.5 (2)" beside a profile that says "4 stars, 2 reviews",
 * and a reader who cannot tell whether they are the same number.
 *
 * NULL IS NOT ZERO, and this is the decision the component exists to enforce. A
 * person nobody has rated has no average — rendering 0 would say they were rated
 * badly, which is the opposite of the truth and the worst thing you can do to
 * somebody's first listing.
 *
 * THE STAR IS THE ACCENT, not a second yellow. A rating is one of the two numbers
 * people actually compare listings on (the other is the price), so it belongs to the
 * colour that means "this matters" rather than to a decorative gold.
 */

function Star({ className = "" }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2.5l2.76 5.6 6.18.9-4.47 4.36 1.05 6.15L12 16.6l-5.52 2.9 1.05-6.15L3.06 9l6.18-.9L12 2.5z" />
    </svg>
  );
}

/**
 * @param {object} props
 * @param {{average: number|null, count: number}} props.rating
 * @param {"sm"|"md"} [props.size="md"]
 * @param {string} [props.empty] What to say when nobody has rated yet.
 */
export function Rating({ rating, size = "md", empty = "No reviews yet" }) {
  const text = size === "sm" ? "text-sm" : "text-[15px]";
  const star = size === "sm" ? "size-3.5" : "size-4";

  if (!rating || rating.count === 0) {
    return <span className={`${text} text-faint`}>{empty}</span>;
  }

  return (
    <span className={`inline-flex items-center gap-1.5 ${text}`}>
      <Star className={`${star} text-accent`} />
      <span className="tabular font-semibold text-ink">{rating.average.toFixed(1)}</span>
      <span className="text-muted">
        ({rating.count} review{rating.count === 1 ? "" : "s"})
      </span>
    </span>
  );
}

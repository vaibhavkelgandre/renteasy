/**
 * The two content widths this app has, and the only place either is written.
 *
 * WHY THIS EXISTS. `5.design-system.md` §3 says "AppLayout owns the page width — no
 * page sets its own, or the layout appears to shift as you navigate." Every page had
 * then gone on to set its own anyway, across **seven** different values (`max-w-md`
 * through `max-w-6xl`), each one also re-applying the padding AppLayout had already
 * applied. Navigating between two screens visibly moved the content and changed the
 * gutter.
 *
 * Two widths, because one is genuinely not enough:
 *
 *   full     grids, lists, anything tabular. Fills AppLayout's 1152px.
 *   reading  forms and prose. A text input stretched to 1152px is unusable and a
 *            paragraph at that width is hard to track back to the next line — the
 *            typographic rule is roughly 60–75 characters.
 *
 * Two is a decision; seven was an accident. Anything wanting a third should change
 * this file, so the question gets asked once rather than per page.
 */

const WIDTHS = {
  full: "max-w-6xl",
  reading: "max-w-2xl",
};

/**
 * A page's content column, with an optional title block.
 *
 * NO HORIZONTAL PADDING AND NO VERTICAL PADDING HERE. `AppLayout` already supplies
 * both; adding them again is what produced the doubled gutters. This component only
 * constrains width.
 *
 * @param {object} props
 * @param {"full"|"reading"} [props.width="full"]
 * @param {string} [props.title] Rendered as the page's single h1.
 * @param {React.ReactNode} [props.description] Sits under the title.
 * @param {React.ReactNode} [props.actions] Top-right, beside the title.
 * @param {React.ReactNode} [props.back] A back link above the title.
 */
export function Page({ width = "full", title, description, actions, back, children }) {
  return (
    // `mx-auto` centres the reading column inside AppLayout's wider one; at `full` it
    // is a no-op because the two widths match.
    <div className={`mx-auto w-full ${WIDTHS[width]}`}>
      {back && <div className="mb-4">{back}</div>}

      {title && (
        // Wraps rather than truncating: a long title with an action button beside it
        // should drop the button to the next line, not clip the title.
        <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight text-stone-900">{title}</h1>
            {description && (
              <p className="mt-2 max-w-2xl leading-relaxed text-stone-600">{description}</p>
            )}
          </div>
          {actions && <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>}
        </div>
      )}

      {children}
    </div>
  );
}

/**
 * A status pill.
 *
 * ONE PLACE FOR EVERY STATUS IN THE PRODUCT — listing and booking alike. They were
 * previously two hand-rolled maps in two files, which is how "Live" ends up emerald on
 * one screen and green on another.
 *
 * The tone is chosen by MEANING rather than by name, so a reader learns the palette
 * once: stone is inert, emerald is good and current, amber wants your attention, rose
 * is over unhappily, brand is in progress.
 */
const STATUS_TONES = {
  // Listings
  DRAFT: { label: "Draft", tone: "stone" },
  PUBLISHED: { label: "Live", tone: "emerald" },
  UNPUBLISHED: { label: "Hidden", tone: "amber" },

  // Bookings
  REQUESTED: { label: "Awaiting reply", tone: "amber" },
  ACCEPTED: { label: "Confirmed", tone: "emerald" },
  ACTIVE: { label: "Out on rental", tone: "brand" },
  RETURNED: { label: "Returned", tone: "brand" },
  COMPLETED: { label: "Completed", tone: "stone" },
  DECLINED: { label: "Declined", tone: "rose" },
  CANCELLED: { label: "Cancelled", tone: "rose" },
  EXPIRED: { label: "Expired", tone: "stone" },
};

const TONE_CLASSES = {
  stone: "bg-stone-100 text-stone-700",
  emerald: "bg-emerald-50 text-emerald-800",
  amber: "bg-amber-50 text-amber-800",
  brand: "bg-brand-50 text-brand-800",
  rose: "bg-rose-50 text-rose-800",
};

/**
 * @param {object} props
 * @param {string} props.status
 */
export function StatusBadge({ status }) {
  const { label, tone } = STATUS_TONES[status] ?? { label: status, tone: "stone" };

  return (
    // `whitespace-nowrap` is load-bearing, not cosmetic: a badge is an inline span, so
    // a two-word label in a narrow column wraps mid-pill and splits the rounded
    // background into two stacked halves, which reads as a rendering glitch.
    <span
      className={`inline-flex whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ${TONE_CLASSES[tone]}`}
    >
      {label}
    </span>
  );
}

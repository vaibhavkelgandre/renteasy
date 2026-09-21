/**
 * The two content widths this app has, the page title block, the section heading, and
 * the one status pill — the four things every screen is assembled from.
 *
 * WHY THE WIDTHS LIVE HERE. The design system doc says "AppLayout owns the page width
 * — no page sets its own, or the layout appears to shift as you navigate." Every page
 * had then gone on to set its own anyway, across seven different values (`max-w-md`
 * through `max-w-6xl`), each also re-applying the padding AppLayout had already
 * applied. Navigating between two screens visibly moved the content and changed the
 * gutter.
 *
 *   full     grids, lists, anything tabular. Fills AppLayout's own column.
 *   reading  forms and prose. A text input stretched to 1440px is unusable and a
 *            paragraph at that width is hard to track back to the next line — the
 *            typographic rule is roughly 60-75 characters.
 *
 * Two is a decision; seven was an accident. Anything wanting a third should change
 * this file, so the question gets asked once rather than per page.
 */

const WIDTHS = {
  full: "max-w-content",
  reading: "max-w-2xl",
};

/**
 * A page's content column, with an optional title block.
 *
 * NO HORIZONTAL AND NO VERTICAL PADDING HERE. `AppLayout` already supplies both;
 * adding them again is what produced the doubled gutters. This component only
 * constrains width.
 *
 * @param {object} props
 * @param {"full"|"reading"} [props.width="full"]
 * @param {string} [props.title] Rendered as the page's single h1.
 * @param {React.ReactNode} [props.description] Sits under the title.
 * @param {React.ReactNode} [props.actions] Top-right, beside the title.
 * @param {React.ReactNode} [props.back] A back link above the title.
 * @param {React.ReactNode} [props.aside] Sits under the description — a rating, a
 *        count, a row of chips. Kept separate from `description` so a page can put
 *        something that is not a sentence there without it inheriting prose styling.
 * @param {string} [props.className] For the column's own content, e.g. `text-center`.
 *        NOT for width or padding — those are the two things this component owns, and
 *        overriding them from a page is exactly what it exists to stop.
 */
export function Page({
  width = "full",
  title,
  description,
  actions,
  back,
  aside,
  className = "",
  children,
}) {
  return (
    // `mx-auto` centres the reading column inside AppLayout's wider one; at `full` it
    // is a no-op because the two widths match.
    <div className={`mx-auto w-full ${WIDTHS[width]} ${className}`}>
      {back && <div className="mb-3">{back}</div>}

      {title && (
        // Wraps rather than truncating: a long title with an action button beside it
        // should drop the button to the next line, not clip the title.
        <div className="mb-6 flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
          <div className="min-w-0">
            {/* 30px, tight tracking, weight 700. A page title on a consumer site is
                allowed to be a HEADLINE — the previous 24px/600 read as a section
                label and left every screen looking like a settings pane. The tight
                tracking is what stops a large Manrope heading looking loose. */}
            <h1 className="text-[1.875rem] font-bold leading-tight tracking-tight text-ink">
              {title}
            </h1>
            {description && (
              <p className="mt-1.5 max-w-2xl leading-relaxed text-muted">{description}</p>
            )}
            {aside && <div className="mt-3">{aside}</div>}
          </div>
          {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}

      {children}
    </div>
  );
}

/**
 * A heading with a rule under it, and nothing else.
 *
 * THIS EXISTS TO STOP PAGES REACHING FOR `Card`. The redesign brief put it plainly:
 * when every group of facts is fenced inside its own rounded panel, the page reads as
 * a stack of unrelated widgets rather than as one composition. Most of the time what a
 * group actually needs is a name and a line — the separation is then typographic,
 * which is free, instead of structural, which costs a border, a radius, a background
 * and 24px of padding on all four sides.
 *
 * Reach for `Card` when a group must be visually liftable: something clickable, or
 * something that has to stay legible while the page scrolls past it. Reach for this
 * the rest of the time.
 *
 * @param {object} props
 * @param {string} props.title
 * @param {React.ReactNode} [props.actions] Right-aligned on the same line.
 * @param {"h2"|"h3"} [props.as="h2"]
 */
export function Section({ title, actions, as: Heading = "h2", className = "", children }) {
  return (
    <section className={className}>
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-line pb-2.5">
        <Heading className="text-sm font-semibold uppercase tracking-[0.08em] text-muted">
          {title}
        </Heading>
        {actions}
      </div>
      {children}
    </section>
  );
}

/**
 * A status pill.
 *
 * ONE PLACE FOR EVERY STATUS IN THE PRODUCT — listing and booking alike. They were
 * previously two hand-rolled maps in two files, which is how "Live" ends up emerald on
 * one screen and green on another.
 *
 * THE TONE IS CHOSEN BY MEANING, so a reader learns the palette once:
 *
 *   neutral  inert — nothing is happening and nothing needs to
 *   good     settled happily
 *   accent   SOMEBODY HAS TO DO SOMETHING. The same amber as every button, because it
 *            means the same thing: this is where you act.
 *   bad      over, unhappily
 *
 * That the accent doubles as the "waiting" tone is deliberate, and is why this palette
 * needs three hues rather than six. A page of bookings then carries exactly as much
 * amber as it has things demanding attention.
 */
const STATUS_TONES = {
  // Listings
  DRAFT: { label: "Draft", tone: "neutral" },
  PUBLISHED: { label: "Live", tone: "good" },
  UNPUBLISHED: { label: "Hidden", tone: "accent" },

  // Bookings
  REQUESTED: { label: "Awaiting reply", tone: "accent" },
  ACCEPTED: { label: "Confirmed", tone: "good" },
  // Accent, like REQUESTED: both mean "waiting on the other person". The item has
  // gone out but the renter has not said so, which is a state somebody must act on
  // rather than a settled one.
  HANDED_OVER: { label: "Awaiting confirmation", tone: "accent" },
  ACTIVE: { label: "Out on rental", tone: "good" },
  RETURNED: { label: "Returned", tone: "good" },
  COMPLETED: { label: "Completed", tone: "neutral" },
  DECLINED: { label: "Declined", tone: "bad" },
  CANCELLED: { label: "Cancelled", tone: "bad" },
  EXPIRED: { label: "Expired", tone: "neutral" },
};

/**
 * A dot plus a label, rather than a filled pill.
 *
 * On a dark ground a row of solid coloured pills is the loudest thing on the page, and
 * a list of bookings is mostly statuses — so the list reads as a warning panel. A dot
 * carries the colour at 1% of the area, which is all the colour has to do: the word
 * beside it is what actually gets read.
 */
const TONE_CLASSES = {
  neutral: { dot: "bg-faint", text: "text-muted", ring: "border-line" },
  good: { dot: "bg-good", text: "text-good", ring: "border-good/25" },
  accent: { dot: "bg-accent", text: "text-accent", ring: "border-accent-line" },
  bad: { dot: "bg-bad", text: "text-bad", ring: "border-bad/30" },
};

/**
 * @param {object} props
 * @param {string} props.status
 */
export function StatusBadge({ status }) {
  const { label, tone } = STATUS_TONES[status] ?? { label: status, tone: "neutral" };
  const { dot, text, ring } = TONE_CLASSES[tone];

  return (
    // `whitespace-nowrap` is load-bearing, not cosmetic: a badge is an inline span, so
    // a two-word label in a narrow column wraps mid-pill and splits the rounded
    // background into two stacked halves, which reads as a rendering glitch.
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border bg-surface px-2.5 py-1 text-xs font-semibold ${ring} ${text}`}
    >
      <span className={`size-1.5 rounded-full ${dot}`} aria-hidden="true" />
      {label}
    </span>
  );
}

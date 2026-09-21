/**
 * Every clickable action in the app.
 *
 * The moment a second button style exists in raw markup, the two drift and "why does
 * this one look different?" becomes unanswerable.
 */

/**
 * A BUTTON THAT ONLY CHANGES COLOUR ON HOVER READS AS A 2012 BUTTON. The fix is not
 * more colour — it is depth and motion: a shadow that grows, and a pixel of lift, so
 * the control behaves like an object rather than a rectangle that repaints.
 *
 * THE PRIMARY IS THE ONLY SATURATED FILL IN THE INTERFACE, and that is what makes it
 * findable. On a near-black page one amber rectangle is unmissable from the corner of
 * the eye; two would already be a choice to make. If a screen seems to need two
 * primaries, one of them is a `secondary`.
 *
 * The glow under it (`shadow-accent/25`) rather than a black shadow: a coloured
 * shadow under a coloured button reads as light falling off it, while black under
 * amber just looks like soot. Every disabled state drops the shadow, or a dead button
 * still looks raised.
 */
const VARIANTS = {
  primary:
    "bg-accent text-accent-ink shadow-sm shadow-accent/25 " +
    "hover:bg-accent-hover hover:shadow-md hover:shadow-accent/35 active:bg-accent-press " +
    "disabled:bg-accent/25 disabled:text-accent-ink/60 disabled:shadow-none",
  // The quiet filled button: a step up from the surface it sits on rather than a
  // second colour. Used where an action matters but is not THE action.
  secondary:
    "bg-raised text-ink border border-line-strong " +
    "hover:bg-sunken hover:border-faint active:bg-raised " +
    "disabled:bg-raised disabled:text-faint disabled:border-line",
  outline:
    "border border-line-strong text-ink-soft " +
    "hover:border-faint hover:bg-raised hover:text-ink active:bg-sunken " +
    "disabled:text-faint disabled:border-line",
  // The only red in the interface, so red always means "cannot be undone".
  danger:
    "bg-bad-soft text-bad border border-bad/40 " +
    "hover:bg-bad hover:text-canvas hover:border-bad active:bg-bad/90 " +
    "disabled:bg-bad-soft disabled:text-bad/40 disabled:border-line",
  ghost: "text-muted hover:bg-raised hover:text-ink active:bg-sunken disabled:text-faint",
};

const SIZES = {
  sm: "h-9 px-3.5 text-sm",
  // 48px, taller than an internal tool's control. This is a consumer product used
  // one-handed on a phone, and a comfortable target beats a compact one.
  md: "h-12 px-5 text-[15px]",
  lg: "h-14 px-7 text-base",
};

/**
 * @param {object} props
 * @param {"primary"|"secondary"|"outline"|"danger"|"ghost"} [props.variant="primary"]
 * @param {"sm"|"md"|"lg"} [props.size="md"]
 * @param {boolean} [props.loading=false] Shows a spinner AND disables the button.
 * @param {boolean} [props.fullWidth=false]
 * @param {React.ElementType} [props.as="button"] Pass react-router's `Link` for an
 *        action that navigates.
 */
export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  fullWidth = false,
  as: Component = "button",
  className = "",
  children,
  ...rest
}) {
  // A navigation styled as a button must still BE a link. The tempting shortcut — a
  // <Link> inside a <button> — is invalid HTML (interactive elements cannot nest) and
  // breaks middle-click, ctrl+click and "copy link address".
  const isButton = Component === "button";

  return (
    <Component
      // `loading` implies disabled. Separating them is how a form gets submitted
      // twice: the spinner spins while the button still accepts clicks.
      disabled={isButton ? loading || rest.disabled : undefined}
      aria-disabled={!isButton && (loading || rest.disabled) ? true : undefined}
      // The spinner is visual only; this is what tells assistive tech it is busy.
      aria-busy={loading || undefined}
      className={[
        "inline-flex items-center justify-center gap-2 rounded-xl font-semibold",
        // `transition-all`, not `transition-colors` — the shadow and the lift are half
        // the effect and `transition-colors` would snap both.
        //
        // 150ms. Fast enough that the control feels connected to the pointer rather
        // than animated at it; the brief's "subtle and fast" is a duration, and this
        // is it.
        "transition-all duration-150",
        // The lift, and its removal when the control cannot be pressed. `active:`
        // puts it back down, which is what makes a click feel like a press.
        "hover:-translate-y-px active:translate-y-0",
        "disabled:cursor-not-allowed disabled:hover:translate-y-0",
        VARIANTS[variant],
        SIZES[size],
        fullWidth ? "w-full" : "",
        className,
      ].join(" ")}
      {...rest}
    >
      {loading && <Spinner />}
      {children}
    </Component>
  );
}

function Spinner() {
  return (
    <svg className="size-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.25" />
      <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

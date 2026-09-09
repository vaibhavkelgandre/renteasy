/**
 * Every clickable action in the app.
 *
 * The moment a second button style exists in raw markup, the two drift and "why does
 * this one look different?" becomes unanswerable.
 */

const VARIANTS = {
  primary:
    "bg-brand-600 text-white hover:bg-brand-700 active:bg-brand-800 shadow-sm " +
    "disabled:bg-brand-200 disabled:text-brand-700",
  secondary:
    "bg-stone-900 text-white hover:bg-stone-800 active:bg-stone-950 " +
    "disabled:bg-stone-300 disabled:text-stone-500",
  outline:
    "border border-stone-300 bg-white text-stone-800 hover:bg-stone-50 " +
    "active:bg-stone-100 disabled:text-stone-400",
  // The only red in the interface, so red always means "cannot be undone".
  danger: "bg-rose-600 text-white hover:bg-rose-500 active:bg-rose-700 disabled:bg-rose-200",
  ghost: "text-stone-700 hover:bg-stone-100 active:bg-stone-200 disabled:text-stone-400",
};

const SIZES = {
  sm: "h-9 px-3 text-sm",
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
  // A navigation styled as a button must still BE a link. The tempting shortcut - a
  // <Link> inside a <button> - is invalid HTML (interactive elements cannot nest) and
  // breaks middle-click, ctrl+click and "copy link address".
  const isButton = Component === "button";

  return (
    <Component
      // `loading` implies disabled. Separating them is how a form gets submitted twice:
      // the spinner spins while the button still accepts clicks.
      disabled={isButton ? loading || rest.disabled : undefined}
      aria-disabled={!isButton && (loading || rest.disabled) ? true : undefined}
      // The spinner is visual only; this is what tells assistive tech the control is busy.
      aria-busy={loading || undefined}
      className={[
        "inline-flex items-center justify-center gap-2 rounded-xl font-medium",
        "transition-colors disabled:cursor-not-allowed",
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

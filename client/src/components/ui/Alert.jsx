/**
 * An inline message.
 *
 * Never a toast. A toast disappears on a timer, which is exactly wrong for "we've
 * emailed you, go and check" or "that link has expired" — the reader looks away, looks
 * back, and the only instruction on the page is gone.
 */

const TONES = {
  error: { box: "border-rose-200 bg-rose-50 text-rose-900", icon: "text-rose-500", live: "assertive" },
  warning: { box: "border-amber-200 bg-amber-50 text-amber-900", icon: "text-amber-600", live: "polite" },
  info: { box: "border-brand-200 bg-brand-50 text-brand-800", icon: "text-brand-600", live: "polite" },
  success: { box: "border-emerald-200 bg-emerald-50 text-emerald-800", icon: "text-emerald-600", live: "polite" },
};

/**
 * @param {object} props
 * @param {"error"|"warning"|"info"|"success"} [props.tone="info"]
 * @param {React.ReactNode} props.children
 */
export function Alert({ tone = "info", className = "", children }) {
  const { box, icon, live } = TONES[tone];

  return (
    <div
      // `role="alert"` makes assistive tech announce an error the moment it appears.
      // Without it a screen reader user submits a form, gets no feedback, and has no
      // idea why nothing happened.
      role={tone === "error" ? "alert" : "status"}
      aria-live={live}
      className={["flex items-start gap-3 rounded-xl border px-4 py-3 text-sm", box, className].join(" ")}
    >
      <svg
        className={["mt-0.5 size-4 shrink-0", icon].join(" ")}
        viewBox="0 0 20 20"
        fill="currentColor"
        aria-hidden="true"
      >
        <path
          fillRule="evenodd"
          d="M10 18a8 8 0 100-16 8 8 0 000 16zM9 9a1 1 0 012 0v4a1 1 0 11-2 0V9zm1-4a1 1 0 100 2 1 1 0 000-2z"
          clipRule="evenodd"
        />
      </svg>
      <div className="min-w-0 leading-relaxed">{children}</div>
    </div>
  );
}

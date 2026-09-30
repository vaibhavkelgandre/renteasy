/**
 * Light/dark switch, in the header's account cluster.
 *
 * ONE BUTTON, TWO ICONS, NOT TWO BUTTONS. The icon shown is the theme you would
 * SWITCH TO, not the one you are in — the same convention a play/pause button uses
 * — so a sun icon while dark means "tap for daylight", matching the affordance
 * every e-commerce site with a mode switch already uses.
 */

import { useTheme } from "../../hooks/useTheme.js";

function SunIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

function MoonIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <path d="M20.5 14.5A8.5 8.5 0 1 1 9.5 3.5a7 7 0 0 0 11 11z" />
    </svg>
  );
}

export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === "dark";

  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      className="grid size-9 place-items-center rounded-lg text-muted transition-colors hover:bg-raised hover:text-ink"
    >
      {isDark ? <SunIcon className="size-5" /> : <MoonIcon className="size-5" />}
    </button>
  );
}

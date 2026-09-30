/**
 * Light/dark mode, as a plain hook rather than a context.
 *
 * NO PROVIDER, ON PURPOSE. Exactly one component (`ThemeToggle`) reads and writes
 * this. A context earns its keep once a second, unrelated component needs the same
 * value without prop-drilling — nothing here does yet, so this is a hook, not
 * `ThemeContext.jsx` plus a provider wrapping `main.jsx`.
 *
 * THE INITIAL VALUE COMES FROM THE DOM, NOT FROM LOCALSTORAGE AGAIN. `index.html`
 * runs an inline script, synchronously, before React ever mounts, that reads
 * `localStorage` (falling back to LIGHT — the app's default, by direct request,
 * not the OS preference) and sets `document.documentElement.dataset.theme` — that
 * is what stops a flash of the wrong theme on load. Re-deriving the same answer
 * here from scratch would risk disagreeing with what the page already painted;
 * reading the attribute the script already settled on cannot.
 */

import { useCallback, useState } from "react";

const STORAGE_KEY = "renteasy-theme";

/** Matches `--color-canvas` in index.css for each theme — keeps mobile browser
 *  chrome (the status bar strip) the same colour as the page underneath it. */
const THEME_COLOR = { dark: "#0a0b0d", light: "#f8f9fb" };

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  // Takes effect immediately and beats any stylesheet rule, which is what makes the
  // browser's OWN widgets (the select dropdown, the date picker) redraw in the right
  // scheme without waiting on anything else.
  document.documentElement.style.colorScheme = theme;

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", THEME_COLOR[theme]);
}

export function useTheme() {
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme || "light");

  const toggleTheme = useCallback(() => {
    setTheme((current) => {
      const next = current === "dark" ? "light" : "dark";
      applyTheme(next);
      localStorage.setItem(STORAGE_KEY, next);
      return next;
    });
  }, []);

  return { theme, toggleTheme };
}

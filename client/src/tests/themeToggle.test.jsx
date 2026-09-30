/**
 * The light/dark switch — hooks/useTheme.js and components/layout/ThemeToggle.jsx.
 *
 * Deliberately rendered standalone rather than through the whole App: this needs no
 * router, no auth, no server — it is a DOM attribute and a localStorage key, and a
 * full-app harness would only add noise to what's actually under test.
 */

import { afterEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeToggle } from "../components/layout/ThemeToggle.jsx";

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.style.colorScheme = "";
  localStorage.clear();
});

describe("ThemeToggle", () => {
  it("defaults to light when the DOM carries no theme yet, and flips to dark on click", async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);

    // Light is the app's default for a first-ever visit (by direct request, not
    // the OS preference) — a page with no data-theme attribute at all still
    // falls back to light here (see useTheme.js), so the button should offer the
    // SWITCH-TO state, "dark".
    const button = screen.getByRole("button", { name: /switch to dark mode/i });

    await user.click(button);

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
    expect(localStorage.getItem("renteasy-theme")).toBe("dark");
    expect(screen.getByRole("button", { name: /switch to light mode/i })).toBeInTheDocument();
  });

  it("reads an already-applied theme from the DOM instead of re-deciding it", () => {
    // Simulates index.html's inline script having already run and set this before
    // React mounted — the hook must trust it, not overwrite it with its own guess.
    document.documentElement.dataset.theme = "dark";

    render(<ThemeToggle />);

    expect(screen.getByRole("button", { name: /switch to light mode/i })).toBeInTheDocument();
  });

  it("toggles back and forth, persisting each choice", async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);

    // Starts light (the default), so the first click switches to dark.
    await user.click(screen.getByRole("button", { name: /switch to dark mode/i }));
    expect(localStorage.getItem("renteasy-theme")).toBe("dark");

    await user.click(screen.getByRole("button", { name: /switch to light mode/i }));
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(localStorage.getItem("renteasy-theme")).toBe("light");
  });
});

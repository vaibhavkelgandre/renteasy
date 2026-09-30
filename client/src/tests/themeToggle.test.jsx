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
  it("defaults to dark when the DOM carries no theme yet, and flips to light on click", async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);

    // Dark is the app's baseline — a page with no data-theme attribute at all
    // renders dark (see index.css), so the button should offer the SWITCH-TO
    // state, "light".
    const button = screen.getByRole("button", { name: /switch to light mode/i });

    await user.click(button);

    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.style.colorScheme).toBe("light");
    expect(localStorage.getItem("renteasy-theme")).toBe("light");
    expect(screen.getByRole("button", { name: /switch to dark mode/i })).toBeInTheDocument();
  });

  it("reads an already-applied theme from the DOM instead of re-deciding it", () => {
    // Simulates index.html's inline script having already run and set this before
    // React mounted — the hook must trust it, not overwrite it with its own guess.
    document.documentElement.dataset.theme = "light";

    render(<ThemeToggle />);

    expect(screen.getByRole("button", { name: /switch to dark mode/i })).toBeInTheDocument();
  });

  it("toggles back and forth, persisting each choice", async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);

    await user.click(screen.getByRole("button", { name: /switch to light mode/i }));
    expect(localStorage.getItem("renteasy-theme")).toBe("light");

    await user.click(screen.getByRole("button", { name: /switch to dark mode/i }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("renteasy-theme")).toBe("dark");
  });
});

/**
 * The signed-in user's single control in the header: initials, opening a menu.
 *
 * REPLACES A SEPARATE "Account" LINK AND "Sign out" BUTTON. Two controls for one
 * subject is two pieces of a phone's header width spent on something used rarely — and
 * Sign out sitting permanently in the chrome is a destructive action one stray tap
 * away, on every page.
 *
 * The initials are the trigger rather than the word "Account" because they answer a
 * question the label cannot: WHICH account you are in, which matters on a shared
 * device. The full email is deliberately inside the open menu rather than in the bar —
 * it should not be sitting on screen on every page for anyone nearby to read.
 */

import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../../context/AuthContext.jsx";

/** First letters of the first two words, e.g. "Asha Patil" → "AP". */
function initialsOf(name) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join("");
}

export function AccountMenu() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const containerRef = useRef(null);
  const triggerRef = useRef(null);

  useEffect(() => {
    if (!open) return;

    // Pointerdown, not click: a click listener fires after the browser has already
    // followed a link inside the menu, so the menu would still be open on the next
    // page. Pointerdown closes it before navigation starts.
    function handlePointerDown(event) {
      if (!containerRef.current?.contains(event.target)) setOpen(false);
    }

    function handleKeyDown(event) {
      if (event.key !== "Escape") return;
      setOpen(false);
      // Focus goes back to the trigger, or a keyboard user is dropped at the top of
      // the document with no idea where they were.
      triggerRef.current?.focus();
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <div className="relative" ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        aria-haspopup="menu"
        aria-expanded={open}
        // The accessible name, because the visible content is two letters that mean
        // nothing read aloud. Screen reader users get the name; the screen stays clean.
        aria-label={`Account menu for ${user.name}`}
        className={[
          "grid size-9 place-items-center rounded-full text-sm font-semibold transition-colors",
          "bg-brand-100 text-brand-800 hover:bg-brand-200",
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2",
          open ? "ring-2 ring-brand-600 ring-offset-2" : "",
        ].join(" ")}
      >
        <span aria-hidden="true">{initialsOf(user.name)}</span>
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Account"
          className="absolute right-0 z-50 mt-2 w-60 overflow-hidden rounded-xl border border-stone-200 bg-white shadow-lg"
        >
          {/* Identity first, and the email is here rather than in the bar: this is the
              one place someone deliberately looks to check which account they are in. */}
          <div className="border-b border-stone-100 px-4 py-3">
            <p className="truncate text-sm font-medium text-stone-900">{user.name}</p>
            <p className="truncate text-sm text-stone-500">{user.email}</p>
          </div>

          <Link
            to="/bookings"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="block px-4 py-2.5 text-sm text-stone-700 hover:bg-stone-50"
          >
            Your bookings
          </Link>

          <Link
            to="/listings/mine"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="block px-4 py-2.5 text-sm text-stone-700 hover:bg-stone-50"
          >
            Your listings
          </Link>

          <Link
            to="/profile"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="block px-4 py-2.5 text-sm text-stone-700 hover:bg-stone-50"
          >
            Your account
          </Link>

          {/* Ruled off and tinted as the one destructive item, so it cannot be mistaken
              for the navigation above it at a glance. */}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              logout();
            }}
            className="block w-full border-t border-stone-100 px-4 py-2.5 text-left text-sm text-rose-700 hover:bg-rose-50"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

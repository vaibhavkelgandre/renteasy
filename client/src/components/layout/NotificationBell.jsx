/**
 * The header bell and its dropdown — FR-986.
 *
 * POLLED, NOT PUSHED. There is no websocket anywhere in this product and adding one
 * for a badge would be a second transport to operate, secure and reconnect for a
 * number that changes a handful of times a day. A 60-second poll of a single integer,
 * served by a partial index, is the cheaper answer by a wide margin.
 *
 * The count comes from its OWN endpoint rather than from the list. The list is paged
 * and unbounded by time; deriving "how many unread" from it would mean fetching rows
 * to call `.length` on them, on every page, for every signed-in user.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../lib/api.js";
import { formatWhen } from "../../lib/dates.js";

/**
 * Long enough that an idle tab is not a load generator, short enough that somebody
 * waiting on an owner's reply sees it without reloading.
 */
const POLL_MS = 60_000;

/** Where a notification takes you when it is clicked. */
function destination(notification) {
  return notification.entity_type === "BOOKING"
    ? `/bookings/${notification.entity_id}`
    : `/listings/${notification.entity_id}`;
}

export function NotificationBell() {
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const panel = useRef(null);

  const refreshCount = useCallback(() => {
    // Silent on failure. A bell that cannot reach the server should show the last
    // number it knew, not an error — nothing here is worth interrupting a page for.
    api
      .get("/notifications/unread-count")
      .then((data) => setUnread(data.unread))
      .catch(() => {});
  }, []);

  useEffect(() => {
    refreshCount();
    const timer = setInterval(refreshCount, POLL_MS);
    return () => clearInterval(timer);
  }, [refreshCount]);

  // Close on a click outside or on Escape. Both, because a dropdown that only closes
  // by clicking the button again is one people end up clicking around.
  useEffect(() => {
    if (!open) return;

    const onPointer = (event) => {
      if (!panel.current?.contains(event.target)) setOpen(false);
    };
    const onKey = (event) => {
      if (event.key === "Escape") setOpen(false);
    };

    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function toggle() {
    const next = !open;
    setOpen(next);

    // Fetched on OPEN rather than kept in sync. Nobody reads a list they have not
    // asked to see, and polling it alongside the count would multiply the cost of the
    // poll by the page size for no benefit.
    if (next) {
      api
        .get("/notifications?limit=8")
        .then((data) => setItems(data.notifications))
        .catch(() => setItems([]));
    }
  }

  async function markRead(notification) {
    setOpen(false);
    if (notification.read_at) return;

    // Optimistic: the navigation happens immediately and the badge should not lag a
    // round trip behind it. If the request fails the next poll corrects the number.
    setUnread((current) => Math.max(0, current - 1));
    await api.post(`/notifications/${notification.id}/read`).catch(() => {});
  }

  async function markAllRead() {
    setUnread(0);
    setItems((current) => current.map((item) => ({ ...item, read_at: new Date().toISOString() })));
    await api.post("/notifications/read-all").catch(() => {});
  }

  return (
    <div className="relative" ref={panel}>
      <button
        type="button"
        onClick={toggle}
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        aria-expanded={open}
        className={[
          "relative grid size-9 place-items-center rounded-lg transition-colors",
          open ? "bg-raised text-ink" : "text-muted hover:bg-raised hover:text-ink",
        ].join(" ")}
      >
        <svg
          className="size-5"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>

        {unread > 0 && (
          // Capped at 9+. A two-digit badge on a 36px control either overflows or
          // shrinks the type to unreadable, and past nine the exact number stops
          // changing what anybody does about it.
          //
          // `ring-canvas` punches a hole in the bell behind it, so the badge reads as
          // sitting on top rather than merging with the glyph's outline.
          <span className="absolute -right-0.5 -top-0.5 grid min-w-[1.15rem] place-items-center rounded-full bg-accent px-1 text-[11px] font-bold leading-[1.15rem] text-accent-ink ring-2 ring-canvas">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-2 w-80 overflow-hidden rounded-2xl border border-line-strong bg-surface shadow-2xl shadow-black/60">
          <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
            <h2 className="text-sm font-semibold text-ink">Notifications</h2>
            {unread > 0 && (
              <button
                type="button"
                onClick={markAllRead}
                className="text-xs font-semibold text-accent transition-colors hover:text-accent-hover"
              >
                Mark all read
              </button>
            )}
          </div>

          {items.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted">Nothing yet.</p>
          ) : (
            <ul className="max-h-96 divide-y divide-line overflow-y-auto">
              {items.map((item) => (
                <li key={item.id}>
                  <Link
                    to={destination(item)}
                    onClick={() => markRead(item)}
                    className={[
                      // UNREAD IS MARKED BY A BAR, NOT A TINTED ROW. A wash across the
                      // whole row is the light-mode idiom and on a dark panel it reads
                      // as "disabled" rather than "new". A 2px accent rule down the
                      // leading edge is unambiguous and survives hover, which a
                      // background tint does not.
                      "relative block py-3 pl-4 pr-4 transition-colors hover:bg-raised",
                      item.read_at
                        ? ""
                        : "before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-r-full before:bg-accent",
                    ].join(" ")}
                  >
                    <p
                      className={[
                        "text-sm leading-snug",
                        item.read_at ? "text-muted" : "text-ink",
                      ].join(" ")}
                    >
                      {item.message}
                    </p>
                    <p className="mt-1 text-xs text-faint">{formatWhen(item.created_at)}</p>
                  </Link>
                </li>
              ))}
            </ul>
          )}

          <Link
            to="/notifications"
            onClick={() => setOpen(false)}
            className="block border-t border-line px-4 py-2.5 text-center text-sm font-semibold text-accent transition-colors hover:bg-raised"
          >
            See all
          </Link>
        </div>
      )}
    </div>
  );
}

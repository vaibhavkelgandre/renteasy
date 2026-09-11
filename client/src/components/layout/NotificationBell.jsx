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
    // asked to see, and polling it alongside the count would multiply the cost of
    // the poll by the page size for no benefit.
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
        className="relative grid size-9 place-items-center rounded-lg text-stone-600 transition-colors hover:bg-stone-200/70 hover:text-stone-900"
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
          <span className="absolute -right-0.5 -top-0.5 grid min-w-[1.15rem] place-items-center rounded-full bg-brand-600 px-1 text-[11px] font-semibold leading-[1.15rem] text-white">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-2 w-80 overflow-hidden rounded-2xl border border-stone-200 bg-white shadow-xl">
          <div className="flex items-center justify-between border-b border-stone-200 px-4 py-2.5">
            <h2 className="text-sm font-semibold text-stone-900">Notifications</h2>
            {unread > 0 && (
              <button
                type="button"
                onClick={markAllRead}
                className="text-xs font-medium text-brand-700 underline underline-offset-2"
              >
                Mark all read
              </button>
            )}
          </div>

          {items.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-stone-500">Nothing yet.</p>
          ) : (
            <ul className="max-h-96 divide-y divide-stone-100 overflow-y-auto">
              {items.map((item) => (
                <li key={item.id}>
                  <Link
                    to={destination(item)}
                    onClick={() => markRead(item)}
                    className={[
                      "block px-4 py-3 transition-colors hover:bg-stone-50",
                      item.read_at ? "" : "bg-brand-50/50",
                    ].join(" ")}
                  >
                    <p className="text-sm leading-snug text-stone-800">{item.message}</p>
                    <p className="mt-1 text-xs text-stone-500">{formatWhen(item.created_at)}</p>
                  </Link>
                </li>
              ))}
            </ul>
          )}

          <Link
            to="/notifications"
            onClick={() => setOpen(false)}
            className="block border-t border-stone-200 px-4 py-2.5 text-center text-sm font-medium text-brand-700 hover:bg-stone-50"
          >
            See all
          </Link>
        </div>
      )}
    </div>
  );
}

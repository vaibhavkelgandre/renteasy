/**
 * The full notification list — FR-986.
 *
 * The bell's dropdown shows the most recent eight; this is everything, paged. Both
 * read the same endpoints, so there is no second notion of what a notification is or
 * where clicking one goes.
 */

import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Alert } from "../components/ui/Alert.jsx";
import { Button } from "../components/ui/Button.jsx";
import { Card } from "../components/ui/Card.jsx";
import { Page } from "../components/ui/Page.jsx";
import { api } from "../lib/api.js";
import { formatWhen } from "../lib/dates.js";

/** Matches the server's own cap, so the pager never asks for something it will not get. */
const PAGE_SIZE = 20;

function destination(notification) {
  return notification.entity_type === "BOOKING"
    ? `/bookings/${notification.entity_id}`
    : `/listings/${notification.entity_id}`;
}

export function NotificationsPage() {
  const [offset, setOffset] = useState(0);
  const [state, setState] = useState({ status: "loading", items: [], total: 0, error: null });

  const load = useCallback(
    () =>
      api
        .get(`/notifications?limit=${PAGE_SIZE}&offset=${offset}`)
        .then((data) =>
          setState({ status: "ready", items: data.notifications, total: data.total, error: null })
        )
        .catch((error) =>
          setState({ status: "failed", items: [], total: 0, error: error.message })
        ),
    [offset]
  );

  useEffect(() => {
    load();
  }, [load]);

  async function markAllRead() {
    await api.post("/notifications/read-all").catch(() => {});
    await load();
  }

  async function open(notification) {
    // Fire and forget. The navigation is the point; if marking read fails, the next
    // poll of the bell still shows the true count.
    if (!notification.read_at) {
      await api.post(`/notifications/${notification.id}/read`).catch(() => {});
    }
  }

  const unread = state.items.filter((item) => !item.read_at).length;
  const lastOffset = Math.max(0, Math.floor((state.total - 1) / PAGE_SIZE) * PAGE_SIZE);

  return (
    <Page
      width="reading"
      title="Notifications"
      actions={
        unread > 0 && (
          <Button variant="outline" size="sm" onClick={markAllRead}>
            Mark all read
          </Button>
        )
      }
    >
      {state.status === "failed" && <Alert tone="error">{state.error}</Alert>}

      {state.status === "loading" && (
        <p className="text-stone-500" role="status">
          Loading…
        </p>
      )}

      {state.status === "ready" && state.items.length === 0 && (
        <Card className="p-10 text-center">
          <h2 className="text-lg font-semibold text-stone-900">Nothing yet</h2>
          <p className="mx-auto mt-2 max-w-sm leading-relaxed text-stone-600">
            When somebody asks to rent your things, or an owner replies to you, it will show up
            here.
          </p>
          <Button as={Link} to="/" variant="outline" className="mt-6">
            Browse listings
          </Button>
        </Card>
      )}

      {state.items.length > 0 && (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-stone-100">
            {state.items.map((item) => (
              <li key={item.id}>
                <Link
                  to={destination(item)}
                  onClick={() => open(item)}
                  className={[
                    "flex items-start gap-3 px-4 py-3.5 transition-colors hover:bg-stone-50",
                    item.read_at ? "" : "bg-brand-50/50",
                  ].join(" ")}
                >
                  {/* A dot rather than bold text for "unread": bold on a two-line
                      message competes with the message itself, and a dot is
                      scannable down a column of thirty. */}
                  <span
                    aria-hidden="true"
                    className={[
                      "mt-1.5 size-2 shrink-0 rounded-full",
                      item.read_at ? "bg-transparent" : "bg-brand-600",
                    ].join(" ")}
                  />

                  <span className="min-w-0">
                    <span className="block leading-snug text-stone-800">{item.message}</span>
                    <span className="mt-1 block text-xs text-stone-500">
                      {formatWhen(item.created_at)}
                      {!item.read_at && <span className="sr-only"> — unread</span>}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {state.total > PAGE_SIZE && (
        <nav className="mt-6 flex items-center justify-between gap-4" aria-label="Pagination">
          <Button
            variant="outline"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
          >
            Newer
          </Button>

          <p className="text-sm text-stone-500">
            {offset + 1}–{Math.min(offset + PAGE_SIZE, state.total)} of {state.total}
          </p>

          <Button
            variant="outline"
            disabled={offset >= lastOffset}
            onClick={() => setOffset(offset + PAGE_SIZE)}
          >
            Older
          </Button>
        </nav>
      )}
    </Page>
  );
}

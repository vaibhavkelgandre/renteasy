/**
 * The inbox — every conversation, at `/messages`.
 *
 * MESSAGING MOVED OFF THE BOOKING PAGE, which had accumulated the booking's details,
 * its actions, its condition photos, a live conversation and an audit trail on one
 * screen. Five things competing for attention, two of which you act on and three of
 * which you read.
 *
 * An inbox is also the shape the feature actually wanted: a conversation is easier
 * to find by "who was I talking to" than by remembering which booking it hung off.
 */

import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Alert } from "../components/ui/Alert.jsx";
import { Button } from "../components/ui/Button.jsx";
import { Card } from "../components/ui/Card.jsx";
import { Page, StatusBadge } from "../components/ui/Page.jsx";
import { api } from "../lib/api.js";
import { formatWhen } from "../lib/dates.js";

/** The inbox is a list of what changed, so it refreshes at the bell's pace, not a chat's. */
const POLL_MS = 30_000;

/** What a row shows when the last message was not text. */
function preview(thread) {
  if (thread.last_kind === "IMAGE") return "Photo";
  if (thread.last_kind === "CONTACT_SHARED") return "Shared a phone number";
  return thread.last_body ?? "";
}

function ThreadRow({ thread, currentUserId }) {
  const unread = thread.unread > 0;
  const mine = thread.last_sender_id === currentUserId;

  return (
    <li>
      <Link
        to={`/messages/${thread.booking_id}`}
        className={[
          "flex items-start gap-3 px-4 py-3.5 transition-colors hover:bg-stone-50",
          unread ? "bg-brand-50/50" : "",
        ].join(" ")}
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className={`truncate ${unread ? "font-semibold" : "font-medium"} text-stone-900`}>
              {thread.other_party_name}
            </span>
            {/* Which side of this rental the reader is on. Without it, a person who
                both lends and rents cannot tell their two conversations apart. */}
            <span className="text-xs text-stone-500">
              {thread.my_role === "renter" ? "renting" : "lending"}
            </span>
            <StatusBadge status={thread.booking_status} />
          </div>

          <p className="mt-0.5 truncate text-sm text-stone-600">{thread.listing_title}</p>

          <p className={`mt-1 truncate text-sm ${unread ? "text-stone-900" : "text-stone-500"}`}>
            {/* "You:" so a thread waiting on the OTHER person is distinguishable at
                a glance from one waiting on you — the only thing most people scan
                an inbox for. */}
            {mine && <span className="text-stone-400">You: </span>}
            {preview(thread)}
          </p>
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <span className="text-xs text-stone-400">{formatWhen(thread.last_at)}</span>
          {unread && (
            <span className="grid min-w-[1.25rem] place-items-center rounded-full bg-brand-600 px-1.5 text-xs font-semibold text-white">
              {thread.unread > 9 ? "9+" : thread.unread}
            </span>
          )}
        </div>
      </Link>
    </li>
  );
}

export function MessagesPage() {
  const [state, setState] = useState({ status: "loading", threads: [], error: null });
  const [me, setMe] = useState(null);

  const load = useCallback(
    () =>
      api
        .get("/bookings/messages/threads")
        .then((data) => setState({ status: "ready", threads: data.threads, error: null }))
        .catch((error) => setState({ status: "failed", threads: [], error: error.message })),
    []
  );

  useEffect(() => {
    api.get("/auth/me").then((data) => setMe(data.user.id)).catch(() => {});
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  return (
    <Page width="reading" title="Messages">
      {state.status === "failed" && <Alert tone="error">{state.error}</Alert>}

      {state.status === "loading" && (
        <p className="text-stone-500" role="status">
          Loading…
        </p>
      )}

      {state.status === "ready" && state.threads.length === 0 && (
        <Card className="p-10 text-center">
          <h2 className="text-lg font-semibold text-stone-900">No conversations yet</h2>
          <p className="mx-auto mt-2 max-w-sm leading-relaxed text-stone-600">
            A conversation starts when you request an item, or when somebody requests
            one of yours. You can ask anything before agreeing to meet.
          </p>
          <Button as={Link} to="/bookings" variant="outline" className="mt-6">
            Your bookings
          </Button>
        </Card>
      )}

      {state.threads.length > 0 && (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-stone-100">
            {state.threads.map((thread) => (
              <ThreadRow key={thread.booking_id} thread={thread} currentUserId={me} />
            ))}
          </ul>
        </Card>
      )}
    </Page>
  );
}

/**
 * One conversation, at `/messages/:bookingId`.
 *
 * A PAGE OF ITS OWN rather than a panel on the booking, so the thread gets the whole
 * screen and the booking page gets back the attention its actions need.
 *
 * `MessageThread` itself is unchanged — it was already self-contained, fetching and
 * polling its own data. This page supplies the frame: who the other person is, what
 * the booking is, and a way back to both.
 */

import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { MessageThread } from "../components/booking/MessageThread.jsx";
import { Alert } from "../components/ui/Alert.jsx";
import { Button } from "../components/ui/Button.jsx";
import { Page, StatusBadge } from "../components/ui/Page.jsx";
import { api } from "../lib/api.js";
import { useAuth } from "../context/AuthContext.jsx";
import { formatRange } from "../lib/dates.js";

export function MessageThreadPage() {
  const { bookingId } = useParams();
  const { user } = useAuth();

  // Keyed by the id it was loaded for, so navigating between two threads shows the
  // spinner rather than the previous conversation's header — and without a
  // synchronous setState at the top of the effect.
  const [state, setState] = useState({ id: null, booking: null, error: null });

  useEffect(() => {
    let active = true;

    api
      .get(`/bookings/${bookingId}`)
      .then((data) => active && setState({ id: bookingId, booking: data.booking, error: null }))
      .catch((error) => active && setState({ id: bookingId, booking: null, error: error.message }));

    return () => {
      active = false;
    };
  }, [bookingId]);

  if (state.id !== bookingId) {
    return (
      <p className="text-muted" role="status">
        Loading…
      </p>
    );
  }

  if (state.error) {
    return (
      <Page width="reading">
        <Alert tone="error">{state.error}</Alert>
        <Button as={Link} to="/messages" variant="outline" className="mt-6">
          Back to messages
        </Button>
      </Page>
    );
  }

  const { booking } = state;
  const otherParty = booking.owner_id === user?.id ? "the renter" : "the owner";

  return (
    <Page
      width="reading"
      title={booking.listing_title}
      description={`With ${otherParty} · ${formatRange(booking.starts_at, booking.ends_at)}`}
      back={
        <Link
          to="/messages"
          className="text-sm font-medium text-accent underline underline-offset-2"
        >
          ← All messages
        </Link>
      }
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={booking.status} />
          {/* The way back to the thing the conversation is about. Every action —
              accept, hand over, return — lives there, not here. */}
          <Button as={Link} to={`/bookings/${booking.id}`} variant="outline" size="sm">
            View booking
          </Button>
        </div>
      }
    >
      <MessageThread bookingId={booking.id} currentUserId={user?.id} />
    </Page>
  );
}

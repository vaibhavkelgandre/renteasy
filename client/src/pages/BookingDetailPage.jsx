/**
 * One booking — `/bookings/:id`. FR-507, FR-509 to FR-512.
 *
 * The page both parties look at, so it renders identically for each and differs only
 * in which actions it offers.
 *
 * THE BUTTONS COME FROM THE SERVER. `availableActions` is derived from the state
 * machine, so this page never decides what is possible — it renders what it is told.
 * A UI offering a control the server refuses reads as broken; one hiding a control the
 * server allows reads as a missing feature. Both are avoided by not having the
 * knowledge here at all.
 *
 * A TWO-COLUMN LAYOUT on wide screens: the money and the actions stay visible while
 * the trail scrolls. The single-column stack a narrow page would force leaves the
 * primary action below the fold on exactly the screens with room to spare.
 */

import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Page, StatusBadge } from "../components/ui/Page.jsx";
import { Card } from "../components/ui/Card.jsx";
import { Button } from "../components/ui/Button.jsx";
import { Alert } from "../components/ui/Alert.jsx";
import { api } from "../lib/api.js";
import { formatPaise } from "../lib/money.js";

/**
 * What each action is called, what it looks like, and whether it needs confirming.
 *
 * Labels live here rather than coming from the API: the same action reads differently
 * depending on who is doing it, and the server has no business writing button text.
 */
const ACTIONS = {
  ACCEPT: { label: "Accept", variant: "primary", prompt: "Add a note (optional)" },
  DECLINE: { label: "Decline", variant: "outline", prompt: "Why? (optional)", confirm: true },
  CANCEL: { label: "Cancel booking", variant: "outline", prompt: "Why? (optional)", confirm: true },
  CANCEL_AS_OWNER: {
    label: "Cancel this booking",
    variant: "danger",
    prompt: "Tell them why (optional)",
    confirm: true,
    // FR-510. Said before they press it, not after — an owner who did not know this
    // has been penalised without being told.
    warning: "Cancelling a booking you accepted counts against your reliability.",
  },
  START: { label: "Mark as handed over", variant: "primary" },
  RETURN: { label: "Mark as returned", variant: "primary" },
  COMPLETE: { label: "Complete", variant: "primary" },
};

const UNIT_LABEL = { hour: "hour", day: "day", month: "month" };

function formatWhen(iso) {
  return new Date(iso).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** FR-511's trail, oldest first. */
function Timeline({ events }) {
  return (
    <Card className="p-5 sm:p-6">
      <h2 className="text-base font-semibold text-stone-900">History</h2>

      <ol className="mt-4 space-y-4">
        {events.map((event) => (
          <li key={event.id} className="flex gap-3">
            <div className="mt-1.5 size-2 shrink-0 rounded-full bg-stone-300" aria-hidden="true" />
            <div className="min-w-0">
              <p className="text-sm text-stone-900">
                <StatusBadge status={event.to_status} />{" "}
                <span className="text-stone-500">
                  {/* An expiry has no actor, and the trail says so rather than
                      inventing one. */}
                  {event.actor_name ? `by ${event.actor_name}` : "automatically"}
                </span>
              </p>
              <p className="mt-1 text-sm text-stone-500">{formatWhen(event.created_at)}</p>
              {event.comment && (
                <p className="mt-1.5 rounded-lg bg-stone-50 px-3 py-2 text-sm leading-relaxed text-stone-700">
                  {event.comment}
                </p>
              )}
            </div>
          </li>
        ))}
      </ol>

      <p className="mt-5 border-t border-stone-200 pt-4 text-sm text-stone-500">
        This history is append-only. Nothing in it can be edited or removed.
      </p>
    </Card>
  );
}

export function BookingDetailPage() {
  const { id } = useParams();
  const [state, setState] = useState({ status: "loading", booking: null, error: null });
  const [pending, setPending] = useState(null);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");

  function load() {
    return api
      .get(`/bookings/${id}`)
      .then((data) => setState({ status: "ready", booking: data.booking, error: null }))
      .catch((error) => setState({ status: "failed", booking: null, error: error.message }));
  }

  useEffect(() => {
    let active = true;
    api
      .get(`/bookings/${id}`)
      .then((data) => active && setState({ status: "ready", booking: data.booking, error: null }))
      .catch((error) => active && setState({ status: "failed", booking: null, error: error.message }));
    return () => {
      active = false;
    };
  }, [id]);

  async function run(action) {
    setActionError("");
    setBusy(true);
    try {
      await api.post(`/bookings/${id}/actions`, {
        action,
        ...(comment.trim() ? { comment: comment.trim() } : {}),
      });
      setPending(null);
      setComment("");
      await load();
    } catch (error) {
      setActionError(error.message);
    } finally {
      setBusy(false);
    }
  }

  if (state.status === "loading") {
    return (
      <Page title="Booking">
        <p className="text-stone-500" role="status">
          Loading…
        </p>
      </Page>
    );
  }

  if (state.status === "failed") {
    return (
      <Page width="reading" title="Booking not found">
        {/* One message for every cause: an unknown id, a malformed one, and a booking
            belonging to two other people all answer an identical 404. */}
        <p className="leading-relaxed text-stone-600">
          It may have been removed, the link may be wrong, or it may belong to somebody
          else.
        </p>
        <Button as={Link} to="/bookings" variant="outline" className="mt-6">
          Your bookings
        </Button>
      </Page>
    );
  }

  const { booking } = state;
  const isOwner = booking.yourRole === "owner";

  return (
    <Page
      title={booking.listing_title}
      back={
        <Link to="/bookings" className="text-sm text-stone-500 underline underline-offset-2">
          ← Your bookings
        </Link>
      }
      actions={<StatusBadge status={booking.status} />}
    >
      {/* Money and actions on the right, history on the left. The wider column takes
          the content that grows; the narrower one holds what must stay in view. */}
      <div className="grid gap-5 lg:grid-cols-[1.3fr_1fr]">
        <div className="space-y-5">
          <Card className="p-5 sm:p-6">
            <h2 className="text-base font-semibold text-stone-900">Details</h2>

            <dl className="mt-4 grid gap-4 sm:grid-cols-2">
              <div>
                <dt className="text-sm text-stone-500">From</dt>
                <dd className="mt-0.5 text-stone-900">{formatWhen(booking.starts_at)}</dd>
              </div>
              <div>
                <dt className="text-sm text-stone-500">Until</dt>
                <dd className="mt-0.5 text-stone-900">{formatWhen(booking.ends_at)}</dd>
              </div>
              <div>
                <dt className="text-sm text-stone-500">Your role</dt>
                <dd className="mt-0.5 text-stone-900">{isOwner ? "Owner" : "Renter"}</dd>
              </div>
              <div>
                <dt className="text-sm text-stone-500">Listing</dt>
                <dd className="mt-0.5">
                  <Link
                    to={`/listings/${booking.listing_id}`}
                    className="text-brand-700 underline underline-offset-2"
                  >
                    View it
                  </Link>
                </dd>
              </div>
            </dl>

            {booking.renter_message && (
              <div className="mt-5 border-t border-stone-200 pt-4">
                <p className="text-sm text-stone-500">Message from the renter</p>
                <p className="mt-1.5 leading-relaxed text-stone-700">{booking.renter_message}</p>
              </div>
            )}
          </Card>

          <Timeline events={booking.events} />
        </div>

        <div className="space-y-5 lg:sticky lg:top-24 lg:self-start">
          <Card className="p-5 sm:p-6">
            <h2 className="text-base font-semibold text-stone-900">
              {isOwner ? "What you receive" : "What you pay"}
            </h2>

            <dl className="mt-4 space-y-2.5 text-sm">
              {booking.quote_lines.map((line) => (
                <div key={line.unit} className="flex items-baseline justify-between gap-4">
                  <dt className="text-stone-600">
                    {line.quantity} × {UNIT_LABEL[line.unit]}
                    {line.quantity === 1 ? "" : "s"}
                  </dt>
                  <dd className="shrink-0 tabular-nums text-stone-900">
                    {formatPaise(line.subtotalPaise)}
                  </dd>
                </div>
              ))}

              <div className="flex items-baseline justify-between gap-4 border-t border-stone-200 pt-2.5">
                <dt className="text-stone-600">Rent</dt>
                <dd className="shrink-0 tabular-nums text-stone-900">
                  {formatPaise(booking.rent_paise)}
                </dd>
              </div>

              {booking.deposit_paise > 0 && !isOwner && (
                <div className="flex items-baseline justify-between gap-4">
                  <dt className="text-stone-600">
                    Deposit <span className="text-stone-400">refundable</span>
                  </dt>
                  <dd className="shrink-0 tabular-nums text-stone-900">
                    {formatPaise(booking.deposit_paise)}
                  </dd>
                </div>
              )}

              {isOwner && (
                <div className="flex items-baseline justify-between gap-4">
                  {/* FR-403 — shown to the owner, whose money it comes out of, and to
                      nobody else. The renter's total never included it. */}
                  <dt className="text-stone-600">Platform fee</dt>
                  <dd className="shrink-0 tabular-nums text-stone-500">
                    −{formatPaise(booking.commission_paise)}
                  </dd>
                </div>
              )}
            </dl>

            <div className="mt-4 flex items-baseline justify-between gap-4 border-t border-stone-200 pt-4">
              <span className="font-medium text-stone-900">Total</span>
              <span className="text-lg font-semibold tabular-nums text-stone-900">
                {formatPaise(isOwner ? booking.owner_payout_paise : booking.renter_total_paise)}
              </span>
            </div>

            <p className="mt-3 text-sm leading-relaxed text-stone-500">
              This price is fixed. Changing the listing later will not alter it.
            </p>
          </Card>

          {booking.availableActions.length > 0 && (
            <Card className="p-5 sm:p-6">
              <h2 className="text-base font-semibold text-stone-900">What you can do</h2>

              {actionError && (
                <Alert tone="error" className="mt-4">
                  {actionError}
                </Alert>
              )}

              {!pending && (
                <div className="mt-4 flex flex-wrap gap-2">
                  {booking.availableActions.map((action) => {
                    const config = ACTIONS[action];
                    if (!config) return null;
                    return (
                      <Button
                        key={action}
                        variant={config.variant}
                        loading={busy}
                        onClick={() => (config.prompt ? setPending(action) : run(action))}
                      >
                        {config.label}
                      </Button>
                    );
                  })}
                </div>
              )}

              {pending && (
                <div className="mt-4 space-y-3">
                  {ACTIONS[pending].warning && (
                    <Alert tone="warning">{ACTIONS[pending].warning}</Alert>
                  )}

                  <label htmlFor="action-comment" className="block text-sm font-medium text-stone-700">
                    {ACTIONS[pending].prompt}
                  </label>
                  <textarea
                    id="action-comment"
                    value={comment}
                    onChange={(event) => setComment(event.target.value)}
                    rows={3}
                    className="w-full rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 focus:border-brand-600"
                  />

                  <div className="flex flex-wrap gap-2">
                    <Button variant={ACTIONS[pending].variant} loading={busy} onClick={() => run(pending)}>
                      {ACTIONS[pending].label}
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setPending(null);
                        setComment("");
                      }}
                    >
                      Back
                    </Button>
                  </div>
                </div>
              )}
            </Card>
          )}

          {booking.availableActions.length === 0 && (
            <Card className="p-5 text-sm leading-relaxed text-stone-500 sm:p-6">
              {/* Says why there is nothing to do, rather than showing an empty box. */}
              There is nothing to do here — this booking is {booking.status.toLowerCase()}.
            </Card>
          )}
        </div>
      </div>
    </Page>
  );
}

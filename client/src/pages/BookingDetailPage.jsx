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
import { Page, Section, StatusBadge } from "../components/ui/Page.jsx";
import { ConditionPhotos } from "../components/booking/ConditionPhotos.jsx";
import { BookingReviews } from "../components/booking/BookingReviews.jsx";
import { useAuth } from "../context/AuthContext.jsx";
import { Button } from "../components/ui/Button.jsx";
import { Alert } from "../components/ui/Alert.jsx";
import { api } from "../lib/api.js";
import { formatWhen } from "../lib/dates.js";
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
  /**
   * Step 8. The wording carries the two-sided design, because the buttons are the
   * only place a user meets it.
   *
   * "I have handed it over" and "I have it" are deliberately first-person claims
   * rather than neutral verbs: each party is asserting something about themselves,
   * and the other party's matching claim is what moves the booking on. A neutral
   * "Start rental" would read as a single button that does the whole thing.
   */
  START: {
    label: "I have handed it over",
    variant: "primary",
    prompt: "Anything to note? (optional)",
  },
  CONFIRM_RECEIPT: { label: "I have received it", variant: "primary" },
  RETURN: { label: "I have returned it", variant: "primary" },
  COMPLETE: {
    label: "Confirm it came back fine",
    variant: "primary",
    prompt: "Anything to note? (optional)",
  },
};

const UNIT_LABEL = { hour: "hour", day: "day", month: "month" };


/**
 * FR-511's trail, oldest first.
 *
 * A CONNECTED LINE, NOT A LIST OF BULLETS. The events are a sequence and the old
 * rendering said so only by being stacked — a rule running through the dots is what
 * makes it read as one thing that happened over time rather than four separate notes.
 *
 * No longer inside a card: a record you read and cannot act on does not need lifting
 * off the page, and it was the tallest of six stacked panels.
 */
function Timeline({ events }) {
  return (
    <Section title="History" className="mt-8">
      <ol className="space-y-5">
        {events.map((event, index) => (
          <li key={event.id} className="relative flex gap-4">
            {/* The connector, drawn by each row except the last so the line stops at
                the final dot instead of trailing off under it. */}
            {index < events.length - 1 && (
              <span
                className="absolute bottom-0 left-[3px] top-5 w-px bg-line"
                aria-hidden="true"
              />
            )}

            {/* `ring-canvas` punches the page colour out around the dot, so the
                connector appears to pass behind it rather than through it. */}
            <span
              className="relative mt-1.5 size-[7px] shrink-0 rounded-full bg-line-strong ring-4 ring-canvas"
              aria-hidden="true"
            />

            <div className="min-w-0 flex-1 pb-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <StatusBadge status={event.to_status} />
                <span className="text-sm text-muted">
                  {/* An expiry has no actor, and the trail says so rather than
                      inventing one. */}
                  {event.actor_name ? `by ${event.actor_name}` : "automatically"}
                </span>
                <span className="text-line-strong" aria-hidden="true">
                  ·
                </span>
                <span className="text-sm text-faint">{formatWhen(event.created_at)}</span>
              </div>

              {event.comment && (
                <p className="mt-2 rounded-lg border-l-2 border-line-strong bg-raised px-3 py-2 text-sm leading-relaxed text-ink-soft">
                  {event.comment}
                </p>
              )}
            </div>
          </li>
        ))}
      </ol>

      <p className="mt-5 text-sm text-faint">
        This history is append-only. Nothing in it can be edited or removed.
      </p>
    </Section>
  );
}

/**
 * One labelled fact in the summary strip under the title.
 *
 * The strip replaces a "Details" card holding a four-cell `<dl>`. Those four facts —
 * when it starts, when it ends, which side you are on, which listing — are the
 * caption to the page title, not a section of the page, so they now sit between two
 * rules directly under it rather than inside a panel of their own.
 */
function Fact({ label, children }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-semibold uppercase tracking-wider text-faint">{label}</dt>
      <dd className="mt-1 truncate text-[15px] font-medium text-ink">{children}</dd>
    </div>
  );
}

export function BookingDetailPage() {
  const { id } = useParams();

  // Only to decide who may reply to a review — the server decides everything else.
  const { user } = useAuth();


  const [state, setState] = useState({ status: "loading", booking: null, error: null });
  const [photos, setPhotos] = useState([]);
  const [pending, setPending] = useState(null);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");

  /**
   * Both requests together, so one `load()` refreshes the whole screen.
   *
   * The photo list has to come back with the booking rather than fetching itself: a
   * transition can CLOSE a phase for uploads (completing a booking shuts both), so a
   * photos panel that refreshed independently would keep offering an upload the
   * server would then refuse.
   *
   * `Promise.all`, and photos failing must not take the page down — the booking is
   * the page, the photos are a panel on it.
   */
  function load() {
    return Promise.all([
      api.get(`/bookings/${id}`),
      api.get(`/bookings/${id}/photos`).catch(() => ({ photos: [] })),
    ])
      .then(([booking, photoData]) => {
        setState({ status: "ready", booking: booking.booking, error: null });
        setPhotos(photoData.photos ?? []);
      })
      .catch((error) => setState({ status: "failed", booking: null, error: error.message }));
  }

  useEffect(() => {
    let active = true;

    Promise.all([
      api.get(`/bookings/${id}`),
      api.get(`/bookings/${id}/photos`).catch(() => ({ photos: [] })),
    ])
      .then(([booking, photoData]) => {
        if (!active) return;
        setState({ status: "ready", booking: booking.booking, error: null });
        setPhotos(photoData.photos ?? []);
      })
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
        <p className="text-muted" role="status">
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
        <p className="leading-relaxed text-muted">
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
        <Link to="/bookings" className="text-sm text-muted transition-colors hover:text-ink">
          ← Your bookings
        </Link>
      }
      actions={<StatusBadge status={booking.status} />}
    >
      {/* THE SUMMARY STRIP. Four facts between two rules, directly under the title —
          the caption to the page rather than a "Details" card competing with the five
          panels that used to follow it. */}
      <dl className="grid grid-cols-2 gap-x-6 gap-y-5 border-y border-line py-5 sm:grid-cols-4">
        <Fact label="From">{formatWhen(booking.starts_at)}</Fact>
        <Fact label="Until">{formatWhen(booking.ends_at)}</Fact>
        <Fact label="Your role">{isOwner ? "Owner" : "Renter"}</Fact>
        <Fact label="Listing">
          <Link
            to={`/listings/${booking.listing_id}`}
            className="text-accent underline underline-offset-2 transition-colors hover:text-accent-hover"
          >
            View it
          </Link>
        </Fact>
      </dl>

      {/* Money and actions on the right, the record on the left. The wider column
          takes the content that grows; the narrower one holds what must stay in
          view. */}
      <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] lg:gap-10">
        <div className="min-w-0">
          {booking.renter_message && (
            <Section title="Message from the renter">
              {/* Quoted rather than boxed: these are somebody's words, and a rule down
                  the side is how a quotation is set everywhere else in print. */}
              <blockquote className="border-l-2 border-accent-line pl-4 leading-relaxed text-ink-soft">
                {booking.renter_message}
              </blockquote>
            </Section>
          )}

          {/* Above the trail, not below it. The photos are something you may still
              need to ACT on while a booking is live; the trail is a record of what
              already happened, and records belong last. */}
          <ConditionPhotos
            bookingId={booking.id}
            bookingStatus={booking.status}
            photos={photos}
            onChanged={load}
          />

          {/* Renders nothing until the rental is COMPLETED (FR-801), so this costs a
              live booking no screen space. */}
          <BookingReviews
            bookingId={booking.id}
            bookingStatus={booking.status}
            currentUserId={user?.id}
          />

          <Timeline events={booking.events} />
        </div>

        <div className="lg:sticky lg:top-24 lg:self-start">
          {/* ============================================================
              ONE PANEL: THE MONEY AND THE BUTTONS.

              These were two stacked cards, "What you pay" and "What you can do", and
              separating them was the clearest instance of the problem this redesign
              was asked to fix: they are not two subjects. Accepting a booking IS
              agreeing to that figure, and a renter cancelling is cancelling that
              amount. Split across two panels, the reader has to hold the number in
              their head while moving to the next box to act on it.

              Now the figures build to a total and the buttons sit directly beneath it
              in the same enclosure. This is one of the three places in the app still
              allowed to be a card — it has to stay legible while a long audit trail
              scrolls past it, which is exactly the case `Card`'s own doc reserves a
              border and a background for.
              ============================================================ */}
          <div className="overflow-hidden rounded-2xl border border-line bg-surface">
            <div className="p-5 sm:p-6">
              <h2 className="text-sm font-semibold uppercase tracking-[0.08em] text-muted">
                {isOwner ? "What you receive" : "What you pay"}
              </h2>

              <dl className="mt-4 space-y-2.5 text-sm">
                {booking.quote_lines.map((line) => (
                  <div key={line.unit} className="flex items-baseline justify-between gap-4">
                    <dt className="text-muted">
                      {line.quantity} × {UNIT_LABEL[line.unit]}
                      {line.quantity === 1 ? "" : "s"}
                    </dt>
                    <dd className="shrink-0 tabular text-ink-soft">
                      {formatPaise(line.subtotalPaise)}
                    </dd>
                  </div>
                ))}

                <div className="flex items-baseline justify-between gap-4 border-t border-line pt-2.5">
                  <dt className="text-muted">Rent</dt>
                  <dd className="shrink-0 tabular text-ink-soft">
                    {formatPaise(booking.rent_paise)}
                  </dd>
                </div>

                {booking.deposit_paise > 0 && !isOwner && (
                  <div className="flex items-baseline justify-between gap-4">
                    <dt className="text-muted">
                      Deposit <span className="text-faint">refundable</span>
                    </dt>
                    <dd className="shrink-0 tabular text-ink-soft">
                      {formatPaise(booking.deposit_paise)}
                    </dd>
                  </div>
                )}

                {isOwner && (
                  <div className="flex items-baseline justify-between gap-4">
                    {/* FR-403 — shown to the owner, whose money it comes out of, and
                        to nobody else. The renter's total never included it. */}
                    <dt className="text-muted">Platform fee</dt>
                    <dd className="shrink-0 tabular text-muted">
                      −{formatPaise(booking.commission_paise)}
                    </dd>
                  </div>
                )}
              </dl>

              {/* The total is the largest figure on the page and the only one at full
                  ink weight. Everything above it is an input to it. */}
              <div className="mt-4 flex items-baseline justify-between gap-4 border-t border-line pt-4">
                <span className="text-sm font-semibold text-ink">Total</span>
                <span className="tabular text-2xl font-bold tracking-tight text-ink">
                  {formatPaise(isOwner ? booking.owner_payout_paise : booking.renter_total_paise)}
                </span>
              </div>

              <p className="mt-2 text-xs leading-relaxed text-muted">
                This price is fixed. Changing the listing later will not alter it.
              </p>
            </div>

            {/* The actions, in the same enclosure on a tinted foot. The tint separates
                "what it costs" from "what you can do about it" without putting a
                second border between them. */}
            {booking.availableActions.length > 0 ? (
              <div className="border-t border-line bg-raised p-5 sm:p-6">
                {actionError && (
                  <Alert tone="error" className="mb-4">
                    {actionError}
                  </Alert>
                )}

                {!pending && (
                  <div className="flex flex-wrap gap-2">
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
                  <div className="space-y-3">
                    {ACTIONS[pending].warning && (
                      <Alert tone="warning">{ACTIONS[pending].warning}</Alert>
                    )}

                    <label
                      htmlFor="action-comment"
                      className="block text-sm font-medium text-ink-soft"
                    >
                      {ACTIONS[pending].prompt}
                    </label>
                    <textarea
                      id="action-comment"
                      value={comment}
                      onChange={(event) => setComment(event.target.value)}
                      rows={3}
                      // `bg-surface`, and it is the ONE field in the app that is not
                      // `bg-raised`. Every other input sits on a card and is a step
                      // lighter than it; this one sits on the action foot, which is
                      // already `raised` — so here the step that makes it read as a
                      // well goes the other way.
                      className="w-full resize-y rounded-xl border border-line bg-surface px-3 py-2 text-sm text-ink transition-colors focus:border-accent"
                    />

                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant={ACTIONS[pending].variant}
                        loading={busy}
                        onClick={() => run(pending)}
                      >
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
              </div>
            ) : (
              // Says why there is nothing to do, rather than showing an empty box.
              <p className="border-t border-line bg-raised px-5 py-4 text-sm leading-relaxed text-muted sm:px-6">
                There is nothing to do here — this booking is {booking.status.toLowerCase()}.
              </p>
            )}
          </div>

          {/* A LINK, NOT THE THREAD ITSELF. The conversation used to render inline
              here, which put a booking's details, its actions, its photos, a live chat
              and an audit trail on one screen — five things competing, two of which
              you act on. The thread has its own page now.

              A ROW, not a card: it is one destination, and a bordered panel around a
              single link is the "everything is a card" habit at its most obvious. */}
          <Link
            to={`/messages/${booking.id}`}
            className="group mt-4 flex items-center gap-3 rounded-xl border border-line px-4 py-3 transition-colors hover:border-line-strong hover:bg-raised"
          >
            <svg
              className="size-5 shrink-0 text-muted transition-colors group-hover:text-accent"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M21 11.5a8.38 8.38 0 0 1-9 8.35 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.05a8.5 8.5 0 0 1-.9-3.8 8.38 8.38 0 0 1 8.35-9 8.5 8.5 0 0 1 8.65 8.35Z" />
            </svg>

            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold text-ink">Messages</span>
              <span className="block truncate text-sm text-muted">
                Ask about pickup, condition, anything.
              </span>
            </span>

            <span
              className="shrink-0 text-muted transition-transform group-hover:translate-x-0.5"
              aria-hidden="true"
            >
              ›
            </span>
          </Link>
        </div>
      </div>
    </Page>
  );
}

/**
 * Ask to rent something — `/listings/:id/book`. FR-500 to FR-504.
 *
 * ITS OWN ROUTE, not a modal on the listing page, and for the same reason the apply
 * form is a page in the other project this borrows from: a modal cannot be linked to,
 * cannot be reloaded, and loses everything typed into it if the tab is switched. This
 * is somebody committing to collect a stranger's property — it deserves a URL.
 *
 * THE QUOTE IS FETCHED, NEVER COMPUTED HERE. FR-404 says a client-supplied total is
 * never trusted; the way to make that structural rather than a rule is for the client
 * to have no arithmetic at all. Change the dates and this asks the server again.
 */

import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Page, Section } from "../components/ui/Page.jsx";
import { Button } from "../components/ui/Button.jsx";
import { Field } from "../components/ui/Field.jsx";
import { Alert } from "../components/ui/Alert.jsx";
import { api } from "../lib/api.js";
import { toLocalInput } from "../lib/dates.js";
import { formatPaise } from "../lib/money.js";

const inHours = (hours) => new Date(Date.now() + hours * 60 * 60 * 1000);

/** How the API describes a unit, as a person would say it. */
const UNIT_LABEL = { hour: "hour", day: "day", month: "month" };

/** The itemised bill — FR-401. Rendered from the server's numbers, never recomputed. */
function QuoteBreakdown({ quote }) {
  return (
    // THE ONE ENCLOSURE ON THIS PAGE. Everything else here is a field you fill in;
    // this is the answer, and it is what somebody scrolls back up to check before
    // pressing the button.
    <div className="rounded-2xl border border-line bg-surface p-5 sm:p-6">
      <h2 className="text-sm font-semibold uppercase tracking-[0.08em] text-muted">
        What it costs
      </h2>

      <dl className="mt-4 space-y-2.5">
        {quote.lines.map((line) => (
          <div key={line.unit} className="flex items-baseline justify-between gap-4 text-sm">
            <dt className="text-muted">
              {line.quantity} × {UNIT_LABEL[line.unit]}
              {line.quantity === 1 ? "" : "s"}
              <span className="text-faint"> at {formatPaise(line.unitPricePaise)}</span>
            </dt>
            <dd className="shrink-0 tabular-nums text-ink">
              {formatPaise(line.subtotalPaise)}
            </dd>
          </div>
        ))}

        <div className="flex items-baseline justify-between gap-4 border-t border-line pt-2.5 text-sm">
          <dt className="font-medium text-ink-soft">Rent</dt>
          <dd className="shrink-0 font-medium tabular-nums text-ink">
            {formatPaise(quote.rentPaise)}
          </dd>
        </div>

        {quote.depositPaise > 0 && (
          <div className="flex items-baseline justify-between gap-4 text-sm">
            {/* FR-402 — separate from rent and labelled, because a renter comparing two
                listings needs to know which part comes back to them. */}
            <dt className="text-muted">
              Deposit <span className="text-faint">refundable</span>
            </dt>
            <dd className="shrink-0 tabular-nums text-ink">
              {formatPaise(quote.depositPaise)}
            </dd>
          </div>
        )}
      </dl>

      {/* The total is set at twice the size of the lines above it. On a page whose
          whole purpose is "do I want to pay this", the figure being decided should not
          be the same weight as its own arithmetic. */}
      <div className="mt-4 flex items-baseline justify-between gap-4 border-t border-line pt-4">
        <span className="text-sm font-semibold text-ink">You pay</span>
        <span className="tabular text-2xl font-bold tracking-tight text-ink">
          {formatPaise(quote.renterTotalPaise)}
        </span>
      </div>

      {/* Six hours billed as a day covers 24. Said out loud, or it reads as an
          overcharge rather than as the cheapest option. */}
      {quote.coveredHours > quote.requestedHours && (
        <p className="mt-3 text-sm leading-relaxed text-muted">
          You asked for {quote.requestedHours} hours; the cheapest combination covers{" "}
          {quote.coveredHours}. You are charged the lower price, not the longer one.
        </p>
      )}
    </div>
  );
}

export function BookingRequestPage() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [listing, setListing] = useState(null);
  const [form, setForm] = useState({
    startsAt: toLocalInput(inHours(24)),
    endsAt: toLocalInput(inHours(24 * 4)),
    message: "",
  });

  const [quote, setQuote] = useState({ status: "idle", data: null, blockers: [], error: null });
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const update = (field) => (event) => setForm((prev) => ({ ...prev, [field]: event.target.value }));

  useEffect(() => {
    let active = true;
    api
      .get(`/listings/${id}`)
      .then((data) => active && setListing(data.listing))
      .catch((error) => active && setFormError(error.message));
    return () => {
      active = false;
    };
  }, [id]);

  // Re-quotes whenever the dates change. The server is the only thing that knows what
  // a rental costs, so every change is a round trip rather than a local calculation.
  useEffect(() => {
    if (!form.startsAt || !form.endsAt) return undefined;

    let active = true;
    const query = new URLSearchParams({
      start: new Date(form.startsAt).toISOString(),
      end: new Date(form.endsAt).toISOString(),
    });

    api
      .get(`/listings/${id}/quote?${query}`)
      .then((data) => {
        if (!active) return;
        setQuote({ status: "ready", data: data.quote, blockers: data.blockers, error: null });
      })
      .catch((error) => {
        if (!active) return;
        setQuote({ status: "failed", data: null, blockers: [], error: error.message });
      });

    return () => {
      active = false;
    };
  }, [id, form.startsAt, form.endsAt]);

  async function handleSubmit(event) {
    event.preventDefault();
    setErrors({});
    setFormError("");
    setSubmitting(true);

    try {
      const data = await api.post("/bookings", {
        listingId: id,
        startsAt: new Date(form.startsAt).toISOString(),
        endsAt: new Date(form.endsAt).toISOString(),
        ...(form.message.trim() ? { message: form.message.trim() } : {}),
      });
      navigate(`/bookings/${data.booking.id}`, { replace: true });
    } catch (error) {
      setErrors(error.errors ?? {});
      if (!error.errors || Object.keys(error.errors).length === 0) setFormError(error.message);
      setSubmitting(false);
    }
  }

  const blocked = quote.blockers.length > 0 || quote.status !== "ready";

  return (
    <Page
      width="reading"
      title={listing ? `Request ${listing.title}` : "Request a booking"}
      back={
        <Link
          to={`/listings/${id}`}
          className="text-sm text-muted underline underline-offset-2"
        >
          ← Back to the listing
        </Link>
      }
    >
      {formError && (
        <Alert tone="error" className="mb-5">
          {formError}
        </Alert>
      )}

      <form onSubmit={handleSubmit} className="space-y-8" noValidate>
        <Section title="When">
          {/* Two columns from `sm` up: the two halves of one range belong side by side,
              and stacking them on a wide screen wastes the width this page has. */}
          <div className="grid gap-5 sm:grid-cols-2">
            <Field
              label="From"
              type="datetime-local"
              value={form.startsAt}
              onChange={update("startsAt")}
              error={errors.startsAt}
            />
            <Field
              label="Until"
              type="datetime-local"
              value={form.endsAt}
              onChange={update("endsAt")}
              error={errors.endsAt}
            />
          </div>

          {quote.status === "failed" && (
            <Alert tone="error" className="mt-4">
              {quote.error}
            </Alert>
          )}

          {/* Reported rather than enforced client-side. The server owns the rule; this
              only saves a round trip and explains what to change. */}
          {quote.blockers.map((blocker) => (
            <Alert key={blocker} tone="warning" className="mt-4">
              {blocker}
            </Alert>
          ))}
        </Section>

        {quote.status === "ready" && <QuoteBreakdown quote={quote.data} />}

        <Section
          title="Message to the owner"
          actions={<span className="text-xs text-faint">optional</span>}
        >
          <div>
            {/* The label is `sr-only`: the section heading above already says what this
                field is, and a visible label repeating it two lines later is the kind
                of duplication that makes a form look longer than it is. The element
                still exists, because an input a screen reader cannot name is a bug. */}
            <label htmlFor="booking-message" className="sr-only">
              Message to the owner
            </label>
            <textarea
              id="booking-message"
              value={form.message}
              onChange={update("message")}
              rows={4}
              placeholder="What you need it for, and when you could collect."
              className="w-full resize-y rounded-xl border border-line bg-raised px-4 py-3 text-[15px] text-ink transition-colors placeholder:text-faint focus:border-accent"
            />
            <p className="mt-1.5 text-sm text-muted">
              The single most useful thing an owner reads when deciding.
            </p>
          </div>
        </Section>

        <div className="flex flex-wrap items-center gap-4 border-t border-line pt-6">
          <Button type="submit" size="lg" loading={submitting} disabled={blocked}>
            Send request
          </Button>
          <p className="text-sm text-muted">
            Nothing is charged. The owner has 48 hours to reply.
          </p>
        </div>
      </form>
    </Page>
  );
}

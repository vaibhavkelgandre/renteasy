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
import { Page } from "../components/ui/Page.jsx";
import { Card } from "../components/ui/Card.jsx";
import { Button } from "../components/ui/Button.jsx";
import { Field } from "../components/ui/Field.jsx";
import { Alert } from "../components/ui/Alert.jsx";
import { api } from "../lib/api.js";
import { formatPaise } from "../lib/money.js";

/** `datetime-local` wants `YYYY-MM-DDTHH:mm` in LOCAL time, with no zone or seconds. */
function toLocalInput(date) {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

const inHours = (hours) => new Date(Date.now() + hours * 60 * 60 * 1000);

/** How the API describes a unit, as a person would say it. */
const UNIT_LABEL = { hour: "hour", day: "day", month: "month" };

/** The itemised bill — FR-401. Rendered from the server's numbers, never recomputed. */
function QuoteBreakdown({ quote }) {
  return (
    <Card className="p-5 sm:p-6">
      <h2 className="text-base font-semibold text-stone-900">What it costs</h2>

      <dl className="mt-4 space-y-2.5">
        {quote.lines.map((line) => (
          <div key={line.unit} className="flex items-baseline justify-between gap-4 text-sm">
            <dt className="text-stone-600">
              {line.quantity} × {UNIT_LABEL[line.unit]}
              {line.quantity === 1 ? "" : "s"}
              <span className="text-stone-400"> at {formatPaise(line.unitPricePaise)}</span>
            </dt>
            <dd className="shrink-0 tabular-nums text-stone-900">
              {formatPaise(line.subtotalPaise)}
            </dd>
          </div>
        ))}

        <div className="flex items-baseline justify-between gap-4 border-t border-stone-200 pt-2.5 text-sm">
          <dt className="font-medium text-stone-700">Rent</dt>
          <dd className="shrink-0 font-medium tabular-nums text-stone-900">
            {formatPaise(quote.rentPaise)}
          </dd>
        </div>

        {quote.depositPaise > 0 && (
          <div className="flex items-baseline justify-between gap-4 text-sm">
            {/* FR-402 — separate from rent and labelled, because a renter comparing two
                listings needs to know which part comes back to them. */}
            <dt className="text-stone-600">
              Deposit <span className="text-stone-400">refundable</span>
            </dt>
            <dd className="shrink-0 tabular-nums text-stone-900">
              {formatPaise(quote.depositPaise)}
            </dd>
          </div>
        )}
      </dl>

      <div className="mt-4 flex items-baseline justify-between gap-4 border-t border-stone-200 pt-4">
        <span className="font-medium text-stone-900">You pay</span>
        <span className="text-lg font-semibold tabular-nums text-stone-900">
          {formatPaise(quote.renterTotalPaise)}
        </span>
      </div>

      {/* Six hours billed as a day covers 24. Said out loud, or it reads as an
          overcharge rather than as the cheapest option. */}
      {quote.coveredHours > quote.requestedHours && (
        <p className="mt-3 text-sm leading-relaxed text-stone-500">
          You asked for {quote.requestedHours} hours; the cheapest combination covers{" "}
          {quote.coveredHours}. You are charged the lower price, not the longer one.
        </p>
      )}
    </Card>
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
          className="text-sm text-stone-500 underline underline-offset-2"
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

      <form onSubmit={handleSubmit} className="space-y-5" noValidate>
        <Card className="space-y-5 p-5 sm:p-6">
          <h2 className="text-base font-semibold text-stone-900">When</h2>

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

          {quote.status === "failed" && <Alert tone="error">{quote.error}</Alert>}

          {/* Reported rather than enforced client-side. The server owns the rule; this
              only saves a round trip and explains what to change. */}
          {quote.blockers.map((blocker) => (
            <Alert key={blocker} tone="warning">
              {blocker}
            </Alert>
          ))}
        </Card>

        {quote.status === "ready" && <QuoteBreakdown quote={quote.data} />}

        <Card className="space-y-4 p-5 sm:p-6">
          <div>
            <label
              htmlFor="booking-message"
              className="mb-1.5 flex items-baseline gap-2 text-sm font-medium text-stone-700"
            >
              Message to the owner
              <span className="text-xs font-normal text-stone-400">optional</span>
            </label>
            <textarea
              id="booking-message"
              value={form.message}
              onChange={update("message")}
              rows={4}
              placeholder="What you need it for, and when you could collect."
              className="w-full rounded-xl border border-stone-300 bg-white px-4 py-3 text-[15px] text-stone-900 placeholder:text-stone-400 focus:border-brand-600"
            />
            <p className="mt-1.5 text-sm text-stone-500">
              The single most useful thing an owner reads when deciding.
            </p>
          </div>
        </Card>

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" size="lg" loading={submitting} disabled={blocked}>
            Send request
          </Button>
          <p className="text-sm text-stone-500">
            Nothing is charged. The owner has 48 hours to reply.
          </p>
        </div>
      </form>
    </Page>
  );
}

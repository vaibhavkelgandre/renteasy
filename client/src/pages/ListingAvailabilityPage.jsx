/**
 * The owner's availability screen — `/listings/:id/availability`. FR-200, FR-203,
 * FR-204.
 *
 * Three things live here because they are three answers to one question, "when can
 * somebody have this": the calendar showing what is already taken, the blackouts the
 * owner controls, and the notice period. Splitting them across screens would make the
 * owner navigate to find out whether a change had the effect they wanted.
 *
 * TWO FETCHES, DELIBERATELY. The calendar comes from the public availability endpoint
 * and the editable list from the owner-only one, because ids and reasons must never
 * travel on a path a visitor can call. See `listBlackouts` on the server.
 *
 * OWNER-ONLY, but this page does not decide that — the API answers 403 or 404 and the
 * page renders the refusal. A client-side check would be a second copy of a rule that
 * has to hold server-side anyway.
 */

import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { AvailabilityCalendar } from "../components/AvailabilityCalendar.jsx";
import { Alert } from "../components/ui/Alert.jsx";
import { Button } from "../components/ui/Button.jsx";
import { Card } from "../components/ui/Card.jsx";
import { Field } from "../components/ui/Field.jsx";
import { Page } from "../components/ui/Page.jsx";
import { api, ApiError } from "../lib/api.js";
import { formatRange, formatWhen, toLocalInput } from "../lib/dates.js";

/** Nine in the morning on the day `daysAhead` from now — a sane default to nudge. */
function morningIn(daysAhead) {
  const date = new Date();
  date.setDate(date.getDate() + daysAhead);
  date.setHours(9, 0, 0, 0);
  return toLocalInput(date);
}

const EMPTY_FORM = () => ({ startsAt: morningIn(1), endsAt: morningIn(2), reason: "" });

/**
 * FR-203 — how much warning the owner needs before a rental starts.
 *
 * Offered as a short list rather than a free number field. "How many hours of notice
 * do you need" is a question almost nobody has a precise answer to, and every answer
 * anyone gives is one of these five.
 */
const NOTICE_CHOICES = [
  { value: "", label: "None — bookable right away" },
  { value: "2", label: "2 hours" },
  { value: "12", label: "12 hours" },
  { value: "24", label: "1 day" },
  { value: "72", label: "3 days" },
];

function NoticePeriod({ listingId, value, onSaved }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  async function save(next) {
    setSaving(true);
    setError(null);
    try {
      // An empty choice means "no notice", which is `null` — NOT zero and not the
      // field being omitted. `undefined` would mean "leave alone" to the PATCH, so
      // clearing it would silently do nothing.
      await api.patch(`/listings/${listingId}`, {
        noticePeriodHours: next === "" ? null : Number(next),
      });
      onSaved();
    } catch (caught) {
      setError(caught.message);
    } finally {
      setSaving(false);
    }
  }

  // Inside the calendar's card rather than a card of its own: it is the second half
  // of "when can this be booked", and as a separate panel it added its own heading,
  // padding and border to say one sentence.
  return (
    <div className="mt-4 border-t border-stone-200 pt-4">
      <label
        htmlFor="notice-period"
        className="text-sm font-medium text-stone-900"
      >
        Notice you need
      </label>
      <p className="mt-0.5 text-sm leading-snug text-stone-600">
        Nobody can book a start sooner than this.
      </p>

      <select
        id="notice-period"
        value={value == null ? "" : String(value)}
        onChange={(event) => save(event.target.value)}
        disabled={saving}
        className="mt-2 h-10 w-full rounded-lg border border-stone-300 bg-white px-3 text-sm text-stone-900 disabled:opacity-60"
      >
        {NOTICE_CHOICES.map((choice) => (
          <option key={choice.value} value={choice.value}>
            {choice.label}
          </option>
        ))}
      </select>

      {error && (
        <Alert tone="error" className="mt-3">
          {error}
        </Alert>
      )}
    </div>
  );
}

function BlackoutForm({ listingId, onAdded }) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState({ message: null, fields: {} });

  async function submit(event) {
    event.preventDefault();
    setSaving(true);
    setError({ message: null, fields: {} });

    try {
      await api.post(`/listings/${listingId}/blackouts`, {
        // Local time in, UTC on the wire — the one conversion point, same as money.
        startsAt: new Date(form.startsAt).toISOString(),
        endsAt: new Date(form.endsAt).toISOString(),
        reason: form.reason.trim() || undefined,
      });
      setForm(EMPTY_FORM());
      onAdded();
    } catch (caught) {
      setError({
        message: caught.message,
        fields: caught instanceof ApiError ? caught.errors : {},
      });
    } finally {
      setSaving(false);
    }
  }

  const set = (key) => (event) => setForm((prev) => ({ ...prev, [key]: event.target.value }));

  return (
    <Card className="p-5">
      <h2 className="font-semibold text-stone-900">Block out dates</h2>
      <p className="mt-0.5 text-sm leading-snug text-stone-600">
        Times you need it yourself. Nobody can request these.
      </p>

      <form onSubmit={submit} className="mt-3 space-y-3">
        {/* Three across at the widest size. With the page at 1440px this column is
            ~1000px, and two date fields sharing it were 500px each — a date input
            with 460px of empty space in it. The reason field joins the row rather
            than the dates growing into the gap. */}
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <Field
            label="From"
            type="datetime-local"
            value={form.startsAt}
            onChange={set("startsAt")}
            error={error.fields.startsAt}
            required
          />
          <Field
            label="Until"
            type="datetime-local"
            value={form.endsAt}
            onChange={set("endsAt")}
            error={error.fields.endsAt}
            required
          />

          {/* In the same grid row, not under it. Below the dates it was a single
              full-width input for a twenty-character note. */}
          <Field
            label="Reason"
            optional
            value={form.reason}
            onChange={set("reason")}
            error={error.fields.reason}
            placeholder="Lending it to my brother"
            hint="Only you see this."
            maxLength={200}
            className="sm:col-span-2 xl:col-span-1"
          />
        </div>

        {error.message && <Alert tone="error">{error.message}</Alert>}

        <Button type="submit" loading={saving}>
          Block these dates
        </Button>
      </form>
    </Card>
  );
}

function BlackoutRow({ listingId, blackout, onRemoved }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await api.delete(`/listings/${listingId}/blackouts/${blackout.id}`);
      onRemoved();
    } catch (caught) {
      setError(caught.message);
    } finally {
      // In `finally`, not only in `catch`. The success path re-fetches the parent's
      // list, which re-renders this row with new props rather than unmounting it — so
      // a flag left true stays true, and the row spins forever on an action that
      // already worked.
      setBusy(false);
    }
  }

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-3">
      <div className="min-w-0">
        <p className="font-medium text-stone-900">
          {formatRange(blackout.starts_at, blackout.ends_at)}
        </p>
        <p className="mt-0.5 truncate text-sm text-stone-500">
          {blackout.reason || "No reason given"}
        </p>
        {error && <p className="mt-1 text-sm text-rose-700">{error}</p>}
      </div>

      <Button variant="ghost" size="sm" onClick={remove} loading={busy}>
        Remove
      </Button>
    </li>
  );
}

export function ListingAvailabilityPage() {
  const { id } = useParams();

  // Keyed by the id it was loaded for, so a navigation between two listings shows the
  // spinner rather than the previous listing's dates — and without a synchronous
  // setState at the top of the effect, which is an extra render and a lint error.
  const [data, setData] = useState({
    id: null,
    listing: null,
    availability: null,
    blackouts: [],
    error: null,
  });

  const load = useCallback(async () => {
    try {
      const [listing, availability, blackouts] = await Promise.all([
        api.get(`/listings/${id}`),
        api.get(`/listings/${id}/availability`),
        api.get(`/listings/${id}/blackouts`),
      ]);
      setData({
        id,
        listing: listing.listing,
        availability,
        blackouts: blackouts.blackouts,
        error: null,
      });
    } catch (caught) {
      setData({ id, listing: null, availability: null, blackouts: [], error: caught.message });
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  if (data.id !== id) {
    return (
      <p className="text-stone-500" role="status">
        Loading…
      </p>
    );
  }

  if (data.error) {
    return (
      <Page width="reading">
        <Alert tone="error">{data.error}</Alert>
        <Button as={Link} to="/listings/mine" variant="outline" className="mt-6">
          Your listings
        </Button>
      </Page>
    );
  }

  const { listing, availability, blackouts } = data;

  return (
    <Page
      title="Availability"
      description={listing.title}
      back={
        <Link
          to={`/listings/${id}/edit`}
          className="text-sm font-medium text-brand-700 underline underline-offset-2"
        >
          ← Back to the listing
        </Link>
      }
    >
      {/* The calendar column is content-sized, not half the page. At `1fr 1fr` a
          336px calendar sat in a 560px cell with 200px of white space beside it,
          while the forms opposite wrapped — and the whole thing was tall enough to
          scroll for no reason. */}
      <div className="grid gap-6 lg:grid-cols-[minmax(300px,340px)_1fr] lg:items-start">
        <Card className="p-5">
          <AvailabilityCalendar
            unavailable={availability.unavailable}
            bookableFrom={availability.bookableFrom}
          />

          <NoticePeriod
            listingId={id}
            value={availability.noticePeriodHours}
            // Re-loads rather than patching state: `bookableFrom` is computed by the
            // server from the value just saved, and recomputing it here would be a
            // second definition of the same rule.
            onSaved={load}
          />

          {availability.noticePeriodHours != null && (
            <p className="mt-2 text-xs leading-snug text-stone-500">
              Earliest start right now:{" "}
              <span className="font-medium text-stone-700">
                {formatWhen(availability.bookableFrom)}
              </span>
              .
            </p>
          )}
        </Card>

        <div className="space-y-4">
          <BlackoutForm listingId={id} onAdded={load} />

          <Card className="p-5">
            <h2 className="font-semibold text-stone-900">Dates you have blocked</h2>

            {blackouts.length === 0 ? (
              <p className="mt-0.5 text-sm leading-snug text-stone-600">
                None yet. Everything not already booked is available.
              </p>
            ) : (
              <ul className="mt-1 divide-y divide-stone-200">
                {blackouts.map((blackout) => (
                  <BlackoutRow
                    key={blackout.id}
                    listingId={id}
                    blackout={blackout}
                    onRemoved={load}
                  />
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </Page>
  );
}

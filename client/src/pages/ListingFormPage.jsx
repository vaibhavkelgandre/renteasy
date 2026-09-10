/**
 * Create and edit a listing, at `/listings/new` and `/listings/:id/edit`.
 *
 * ONE COMPONENT FOR BOTH, because they are the same form with the same rules — a draft
 * is just a listing that has not been published yet. Two components would be two places
 * to add the next field to, and the second one would be forgotten.
 *
 * THE PUBLISH CHECKLIST IS THE DESIGN OF THIS PAGE. FR-107 requires a verified email,
 * at least one photo, at least one rate and a location before a listing can go live.
 * Discovering those one at a time by pressing Publish and being refused is a guessing
 * game, so the server exposes the same rule through `/readiness` and the page shows it
 * continuously — the owner always knows exactly what is left.
 */

import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Card } from "../components/ui/Card.jsx";
import { Button } from "../components/ui/Button.jsx";
import { Field } from "../components/ui/Field.jsx";
import { Alert } from "../components/ui/Alert.jsx";
import { api } from "../lib/api.js";
import { formatPaise, parseRupeesToPaise, paiseToRupeeInput, RATE_UNITS } from "../lib/money.js";

const CONDITIONS = [
  { value: "NEW", label: "New" },
  { value: "LIKE_NEW", label: "Like new" },
  { value: "GOOD", label: "Good" },
  { value: "FAIR", label: "Fair" },
];

const FULFILMENTS = [
  { value: "PICKUP", label: "Pickup only" },
  { value: "DELIVERY", label: "I can deliver" },
  { value: "BOTH", label: "Either" },
];

const EMPTY = {
  title: "",
  description: "",
  category: "",
  condition: "GOOD",
  hourlyRupees: "",
  dailyRupees: "",
  monthlyRupees: "",
  depositRupees: "",
  locality: "",
  city: "",
  fulfilment: "PICKUP",
};

/** A labelled `<select>`, matching Field's markup so the two line up. */
function SelectField({ label, value, onChange, options, error, hint }) {
  return (
    <div>
      <label className="mb-1.5 block text-sm font-medium text-stone-700">{label}</label>
      <select
        value={value}
        onChange={onChange}
        aria-invalid={error ? true : undefined}
        className={[
          "h-12 w-full rounded-xl border bg-white px-4 text-[15px] text-stone-900",
          error ? "border-rose-400" : "border-stone-300 focus:border-brand-600",
        ].join(" ")}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {error && <p className="mt-1.5 text-sm text-rose-600">{error}</p>}
      {hint && !error && <p className="mt-1.5 text-sm text-stone-500">{hint}</p>}
    </div>
  );
}

export function ListingFormPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const isNew = !id;

  const [form, setForm] = useState(EMPTY);
  const [categories, setCategories] = useState([]);
  const [listing, setListing] = useState(null);
  const [readiness, setReadiness] = useState(null);
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState("");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const update = (field) => (event) => setForm((prev) => ({ ...prev, [field]: event.target.value }));

  useEffect(() => {
    let active = true;

    api
      .get("/listings/categories")
      .then((data) => {
        if (!active) return;
        setCategories(data.categories);
        // Default to the first category rather than an empty option: a select whose
        // first entry is blank invites submitting it.
        setForm((prev) => (prev.category ? prev : { ...prev, category: data.categories[0]?.slug ?? "" }));
      })
      .catch(() => {});

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (isNew) {
      setLoaded(true);
      return undefined;
    }

    let active = true;

    api
      .get(`/listings/${id}`)
      .then((data) => {
        if (!active) return;
        const l = data.listing;
        setListing(l);
        setForm({
          title: l.title,
          description: l.description,
          category: l.category_slug,
          condition: l.condition,
          hourlyRupees: paiseToRupeeInput(l.hourly_rate_paise),
          dailyRupees: paiseToRupeeInput(l.daily_rate_paise),
          monthlyRupees: paiseToRupeeInput(l.monthly_rate_paise),
          depositRupees: paiseToRupeeInput(l.deposit_paise),
          locality: l.locality ?? "",
          city: l.city ?? "",
          fulfilment: l.fulfilment,
        });
        setLoaded(true);
      })
      .catch((error) => active && (setFormError(error.message), setLoaded(true)));

    return () => {
      active = false;
    };
  }, [id, isNew]);

  /** Re-reads the publish checklist. Called after anything that could satisfy an item. */
  async function refreshReadiness(listingId) {
    try {
      setReadiness(await api.get(`/listings/${listingId}/readiness`));
    } catch {
      // A checklist that fails to load must not break the form it sits beside.
    }
  }

  useEffect(() => {
    if (!isNew && listing) refreshReadiness(listing.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listing?.id]);

  /** Everything the API expects, converted once at the boundary. */
  function toPayload() {
    return {
      title: form.title,
      description: form.description,
      category: form.category,
      condition: form.condition,
      hourlyRatePaise: parseRupeesToPaise(form.hourlyRupees),
      dailyRatePaise: parseRupeesToPaise(form.dailyRupees),
      monthlyRatePaise: parseRupeesToPaise(form.monthlyRupees),
      depositPaise: parseRupeesToPaise(form.depositRupees) ?? 0,
      locality: form.locality.trim() || null,
      city: form.city.trim() || null,
      fulfilment: form.fulfilment,
    };
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setErrors({});
    setFormError("");
    setMessage("");
    setSaving(true);

    try {
      if (isNew) {
        const data = await api.post("/listings", toPayload());
        // Straight to the edit page for the new draft: photos cannot be attached until
        // the listing exists, so creating and then landing back on an empty form would
        // strand the owner one step short of being able to publish.
        navigate(`/listings/${data.listing.id}/edit`, { replace: true });
        return;
      }

      const data = await api.patch(`/listings/${id}`, toPayload());
      setListing(data.listing);
      setMessage("Saved.");
      await refreshReadiness(id);
    } catch (error) {
      setErrors(error.errors ?? {});
      if (!error.errors || Object.keys(error.errors).length === 0) setFormError(error.message);
    } finally {
      setSaving(false);
    }
  }

  async function handlePublishToggle() {
    setFormError("");
    setMessage("");
    setSaving(true);

    const action = listing.status === "PUBLISHED" ? "unpublish" : "publish";
    try {
      const data = await api.post(`/listings/${id}/${action}`);
      setListing(data.listing);
      setMessage(action === "publish" ? "Your listing is live." : "Your listing is hidden.");
    } catch (error) {
      setFormError(error.message);
      await refreshReadiness(id);
    } finally {
      setSaving(false);
    }
  }

  if (!loaded) {
    return (
      <p className="mx-auto max-w-2xl px-5 py-14 text-stone-500" role="status">
        Loading…
      </p>
    );
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-5 py-10 sm:py-14">
      <Link to="/listings/mine" className="text-sm text-stone-500 underline underline-offset-2">
        ← Your listings
      </Link>

      <h1 className="mt-4 text-2xl font-semibold tracking-tight text-stone-900">
        {isNew ? "List something" : form.title || "Edit listing"}
      </h1>

      {!isNew && listing && (
        <PublishPanel
          listing={listing}
          readiness={readiness}
          busy={saving}
          onToggle={handlePublishToggle}
        />
      )}

      {formError && (
        <Alert tone="error" className="mt-6">
          {formError}
        </Alert>
      )}
      {message && (
        <Alert tone="success" className="mt-6">
          {message}
        </Alert>
      )}

      <form onSubmit={handleSubmit} className="mt-6 space-y-5" noValidate>
        <Card className="space-y-5 p-6 sm:p-7">
          <Field label="Title" value={form.title} onChange={update("title")} error={errors.title} />

          <div>
            <label className="mb-1.5 block text-sm font-medium text-stone-700">Description</label>
            <textarea
              value={form.description}
              onChange={update("description")}
              rows={5}
              aria-invalid={errors.description ? true : undefined}
              className={[
                "w-full rounded-xl border bg-white px-4 py-3 text-[15px] text-stone-900",
                errors.description ? "border-rose-400" : "border-stone-300 focus:border-brand-600",
              ].join(" ")}
            />
            {errors.description && (
              <p className="mt-1.5 text-sm text-rose-600">{errors.description}</p>
            )}
          </div>

          <div className="grid gap-5 sm:grid-cols-2">
            <SelectField
              label="Category"
              value={form.category}
              onChange={update("category")}
              options={categories.map((c) => ({ value: c.slug, label: c.name }))}
              error={errors.category}
            />
            <SelectField
              label="Condition"
              value={form.condition}
              onChange={update("condition")}
              options={CONDITIONS}
              error={errors.condition}
            />
          </div>
        </Card>

        <Card className="space-y-5 p-6 sm:p-7">
          <div>
            <h2 className="text-base font-semibold text-stone-900">Price</h2>
            {/* Says the rule out loud rather than only enforcing it. Three empty boxes
                with no explanation look like three required fields. */}
            <p className="mt-1 text-sm leading-relaxed text-stone-500">
              Fill in at least one. Leave the others blank if you do not rent by that
              unit — someone renting for a month should not have to work out 30 × the
              daily rate.
            </p>
          </div>

          <div className="grid gap-5 sm:grid-cols-3">
            {RATE_UNITS.map((unit) => (
              <Field
                key={unit.key}
                label={unit.label}
                type="text"
                inputMode="decimal"
                value={form[unit.key.replace("RatePaise", "Rupees")]}
                onChange={update(unit.key.replace("RatePaise", "Rupees"))}
                error={errors[unit.key]}
                optional
                placeholder="₹"
              />
            ))}
          </div>

          <Field
            label="Security deposit"
            type="text"
            inputMode="decimal"
            value={form.depositRupees}
            onChange={update("depositRupees")}
            error={errors.depositPaise}
            optional
            hint="Refunded when the item comes back. Leave blank for none."
          />
        </Card>

        <Card className="space-y-5 p-6 sm:p-7">
          <div>
            <h2 className="text-base font-semibold text-stone-900">Where it is</h2>
            {/* FR-113, said to the person it protects. The absence of a street address
                field is a safety decision, and an owner who does not know that will
                type their address into "Area" instead. */}
            <p className="mt-1 text-sm leading-relaxed text-stone-500">
              An area and a city only — never your street address. This is shown
              publicly. You share the exact spot with one person, after a booking is
              agreed.
            </p>
          </div>

          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Area" value={form.locality} onChange={update("locality")} error={errors.locality} />
            <Field label="City" value={form.city} onChange={update("city")} error={errors.city} />
          </div>

          <SelectField
            label="Handover"
            value={form.fulfilment}
            onChange={update("fulfilment")}
            options={FULFILMENTS}
          />
        </Card>

        <Button type="submit" size="lg" loading={saving}>
          {isNew ? "Save draft" : "Save changes"}
        </Button>
      </form>

      {!isNew && listing && (
        <PhotoManager
          listingId={id}
          photos={listing.photos ?? []}
          onChanged={(updated) => {
            setListing(updated);
            refreshReadiness(id);
          }}
        />
      )}
    </div>
  );
}

/** The publish state, its checklist, and the one button that changes it. */
function PublishPanel({ listing, readiness, busy, onToggle }) {
  const isLive = listing.status === "PUBLISHED";
  const blockers = readiness?.blockers ?? [];

  return (
    <Card className="mt-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="font-medium text-stone-900">
            {isLive ? "This listing is live" : "Not published yet"}
          </p>
          <p className="mt-1 text-sm text-stone-500">
            {isLive
              ? "Anyone browsing RentEasy can see it."
              : "Only you can see it until you publish."}
          </p>
        </div>

        <Button
          variant={isLive ? "outline" : "primary"}
          onClick={onToggle}
          loading={busy}
          // Disabled only when we KNOW it would fail. While the checklist is still
          // loading the button stays live rather than flickering to disabled — and the
          // server refuses anyway, so the worst case is an honest error message.
          disabled={!isLive && readiness != null && !readiness.canPublish}
        >
          {isLive ? "Hide it" : "Publish"}
        </Button>
      </div>

      {!isLive && blockers.length > 0 && (
        <div className="mt-5 border-t border-stone-200 pt-4">
          <p className="text-sm font-medium text-stone-700">Before it can go live:</p>
          <ul className="mt-2 space-y-1.5">
            {blockers.map((blocker) => (
              <li key={blocker} className="flex items-start gap-2 text-sm text-stone-600">
                <span aria-hidden="true" className="mt-1.5 size-1.5 shrink-0 rounded-full bg-amber-500" />
                {blocker}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

/** Upload, reorder and delete photos — FR-105, FR-106. */
function PhotoManager({ listingId, photos, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function handleUpload(event) {
    const files = Array.from(event.target.files ?? []);
    // Clearing the input matters: choosing the same file twice in a row fires no change
    // event otherwise, and the second attempt silently does nothing.
    event.target.value = "";
    if (files.length === 0) return;

    setError("");
    setBusy(true);

    try {
      const body = new FormData();
      for (const file of files) body.append("photos", file);

      // FormData, not JSON, so `api` cannot be used — it sets a JSON content type, and
      // multipart needs the browser to set its own boundary.
      const response = await fetch(`/api/listings/${listingId}/photos`, {
        method: "POST",
        body,
        credentials: "same-origin",
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message ?? "Upload failed");

      onChanged(payload.data.listing);
    } catch (uploadError) {
      setError(uploadError.message);
    } finally {
      setBusy(false);
    }
  }

  async function move(photoId, direction) {
    const order = photos.map((photo) => photo.id);
    const from = order.indexOf(photoId);
    const to = from + direction;
    if (to < 0 || to >= order.length) return;

    [order[from], order[to]] = [order[to], order[from]];

    setBusy(true);
    try {
      const data = await api.patch(`/listings/${listingId}/photos/order`, { photoIds: order });
      onChanged(data.listing);
    } catch (moveError) {
      setError(moveError.message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(photoId) {
    setBusy(true);
    try {
      const data = await api.delete(`/listings/${listingId}/photos/${photoId}`);
      onChanged(data.listing);
    } catch (deleteError) {
      setError(deleteError.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mt-5 p-6 sm:p-7">
      <h2 className="text-base font-semibold text-stone-900">Photos</h2>
      <p className="mt-1 text-sm leading-relaxed text-stone-500">
        Up to 8, JPEG or PNG, 5MB each. The first one is what people see in the grid —
        use the arrows to change it.
      </p>

      {error && (
        <Alert tone="error" className="mt-4">
          {error}
        </Alert>
      )}

      {photos.length > 0 && (
        <ul className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {photos.map((photo, index) => (
            <li key={photo.id} className="overflow-hidden rounded-xl border border-stone-200">
              <div className="relative aspect-[4/3] bg-stone-100">
                <img src={photo.thumbUrl} alt="" className="size-full object-cover" loading="lazy" />
                {index === 0 && (
                  <span className="absolute left-2 top-2 rounded-full bg-stone-900/80 px-2 py-0.5 text-xs font-medium text-white">
                    Cover
                  </span>
                )}
              </div>

              <div className="flex items-center justify-between gap-1 p-1.5">
                <div className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy || index === 0}
                    onClick={() => move(photo.id, -1)}
                    aria-label={`Move photo ${index + 1} earlier`}
                  >
                    ←
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy || index === photos.length - 1}
                    onClick={() => move(photo.id, 1)}
                    aria-label={`Move photo ${index + 1} later`}
                  >
                    →
                  </Button>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => remove(photo.id)}
                  aria-label={`Remove photo ${index + 1}`}
                >
                  Remove
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <label className="mt-5 inline-flex cursor-pointer items-center gap-2 rounded-xl border border-stone-300 px-4 py-2.5 text-sm font-medium text-stone-700 hover:bg-stone-50">
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          multiple
          onChange={handleUpload}
          disabled={busy || photos.length >= 8}
          className="sr-only"
        />
        {busy ? "Uploading…" : photos.length >= 8 ? "Maximum reached" : "Add photos"}
      </label>
    </Card>
  );
}

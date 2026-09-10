/**
 * A listing, as a stranger sees it — `/listings/:id`.
 *
 * PUBLIC. Browsing needs no account, so this page must render for a signed-out visitor
 * and never assume `user`. A draft answers 404 to everyone but its owner, and the API
 * makes that decision — this page only renders what it is given.
 *
 * There is no Book button yet: bookings are step 6. Saying so plainly beats a button
 * that does nothing.
 */

import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Card } from "../components/ui/Card.jsx";
import { Button } from "../components/ui/Button.jsx";
import { api } from "../lib/api.js";
import { formatPaise, RATE_UNITS } from "../lib/money.js";

const CONDITION_LABELS = {
  NEW: "New",
  LIKE_NEW: "Like new",
  GOOD: "Good",
  FAIR: "Fair",
};

const FULFILMENT_LABELS = {
  PICKUP: "Pickup only",
  DELIVERY: "Delivery available",
  BOTH: "Pickup or delivery",
};

/** The rate card. The whole reason someone is on this page. */
function RateCard({ listing }) {
  const rates = RATE_UNITS.filter((unit) => listing[unit.column] != null);

  return (
    <Card className="p-6">
      <ul className="space-y-3">
        {rates.map((unit) => (
          <li key={unit.key} className="flex items-baseline justify-between gap-4">
            <span className="text-stone-600">{unit.label}</span>
            <span className="text-lg font-semibold text-stone-900">
              {formatPaise(listing[unit.column])}
            </span>
          </li>
        ))}
      </ul>

      {listing.deposit_paise > 0 && (
        <p className="mt-4 border-t border-stone-200 pt-4 text-sm text-stone-600">
          Refundable deposit{" "}
          <span className="font-medium text-stone-900">{formatPaise(listing.deposit_paise)}</span>
        </p>
      )}

      {/* Honest about what does not exist yet. A disabled "Book" button would imply the
          feature is there and broken. */}
      <div className="mt-5 rounded-xl bg-stone-50 px-4 py-3 text-sm leading-relaxed text-stone-600">
        Booking and price negotiation are not built yet — they arrive with the next
        steps of this project.
      </div>
    </Card>
  );
}

/** Photos: one large, the rest as a strip. */
function Gallery({ photos, title }) {
  const [active, setActive] = useState(0);

  if (photos.length === 0) {
    return (
      <div className="grid aspect-[4/3] place-items-center rounded-2xl bg-stone-100 text-stone-400">
        No photos
      </div>
    );
  }

  const current = photos[Math.min(active, photos.length - 1)];

  return (
    <div>
      <div className="overflow-hidden rounded-2xl bg-stone-100">
        <img
          src={current.url}
          // The listing title, because a photo of a camera on a page headed with that
          // camera's name adds nothing when read aloud — but an empty alt on the ONLY
          // image would leave a screen reader with nothing at all.
          alt={title}
          className="aspect-[4/3] w-full object-cover"
          // Reserving the real dimensions stops the page jumping as it loads, which is
          // why width and height are stored alongside the storage id.
          width={current.width}
          height={current.height}
        />
      </div>

      {photos.length > 1 && (
        <ul className="mt-3 flex gap-2 overflow-x-auto">
          {photos.map((photo, index) => (
            <li key={photo.id}>
              <button
                type="button"
                onClick={() => setActive(index)}
                aria-label={`Photo ${index + 1} of ${photos.length}`}
                aria-current={index === active}
                className={[
                  "size-20 shrink-0 overflow-hidden rounded-lg border-2 transition-colors",
                  index === active ? "border-brand-600" : "border-transparent hover:border-stone-300",
                ].join(" ")}
              >
                <img src={photo.thumbUrl} alt="" className="size-full object-cover" loading="lazy" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ListingDetailPage() {
  const { id } = useParams();
  const [result, setResult] = useState({ id: null, listing: null, error: null });

  useEffect(() => {
    let active = true;

    api
      .get(`/listings/${id}`)
      .then((data) => active && setResult({ id, listing: data.listing, error: null }))
      .catch((error) => active && setResult({ id, listing: null, error: error.message }));

    return () => {
      active = false;
    };
  }, [id]);

  // Keyed by the id it was fetched for, rather than nulled imperatively at the top of
  // the effect — a synchronous setState in an effect body is an extra render and a lint
  // error both.
  if (result.id !== id) {
    return (
      <p className="mx-auto max-w-4xl px-5 py-14 text-stone-500" role="status">
        Loading…
      </p>
    );
  }

  if (result.error) {
    return (
      <div className="mx-auto w-full max-w-lg px-5 py-14 text-center">
        <h1 className="text-xl font-semibold text-stone-900">Listing not found</h1>
        {/* One message for every cause: an unknown id, a malformed one, a draft, and an
            unpublished listing all answer identically, so the copy must not guess. */}
        <p className="mt-3 leading-relaxed text-stone-600">
          It may have been taken down, or the link may be wrong.
        </p>
        <Button as={Link} to="/" variant="outline" className="mt-7">
          Browse RentEasy
        </Button>
      </div>
    );
  }

  const { listing } = result;

  return (
    <div className="mx-auto w-full max-w-4xl px-5 py-8 sm:py-12">
      <div className="grid gap-8 lg:grid-cols-[1.4fr_1fr]">
        <div>
          <Gallery photos={listing.photos} title={listing.title} />

          <h1 className="mt-6 text-2xl font-semibold tracking-tight text-stone-900">
            {listing.title}
          </h1>

          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-stone-500">
            <span>{listing.category_name}</span>
            <span aria-hidden="true">·</span>
            <span>{CONDITION_LABELS[listing.condition]} condition</span>
            {listing.city && (
              <>
                <span aria-hidden="true">·</span>
                {/* An area, never a street address — FR-113. */}
                <span>
                  {listing.locality}, {listing.city}
                </span>
              </>
            )}
          </div>

          <p className="mt-6 whitespace-pre-line leading-relaxed text-stone-700">
            {listing.description}
          </p>

          <dl className="mt-8 grid grid-cols-2 gap-4 border-t border-stone-200 pt-6 text-sm">
            <div>
              <dt className="text-stone-500">Handover</dt>
              <dd className="mt-0.5 font-medium text-stone-900">
                {FULFILMENT_LABELS[listing.fulfilment]}
              </dd>
            </div>
            {(listing.min_duration_hours || listing.max_duration_hours) && (
              <div>
                <dt className="text-stone-500">Rental length</dt>
                <dd className="mt-0.5 font-medium text-stone-900">
                  {listing.min_duration_hours ? `From ${listing.min_duration_hours}h` : ""}
                  {listing.min_duration_hours && listing.max_duration_hours ? " " : ""}
                  {listing.max_duration_hours ? `up to ${listing.max_duration_hours}h` : ""}
                </dd>
              </div>
            )}
          </dl>

          <p className="mt-6 text-sm text-stone-500">
            Listed by{" "}
            <Link
              to={`/u/${listing.owner_id}`}
              className="font-medium text-brand-700 underline underline-offset-2"
            >
              the owner
            </Link>
          </p>
        </div>

        {/* Sticky on a wide screen: the price is what a reader keeps referring back to
            while scrolling a long description. */}
        <div className="lg:sticky lg:top-24 lg:self-start">
          <RateCard listing={listing} />
        </div>
      </div>
    </div>
  );
}

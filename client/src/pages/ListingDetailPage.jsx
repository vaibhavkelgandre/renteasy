/**
 * A listing, as a stranger sees it — `/listings/:id`.
 *
 * PUBLIC. Browsing needs no account, so this page must render for a signed-out visitor
 * and never assume `user`. A draft answers 404 to everyone but its owner, and the API
 * makes that decision — this page only renders what it is given.
 *
 * Availability (FR-205) is fetched SEPARATELY from the listing rather than embedded in
 * it. Two reasons: a calendar is paged by month while a listing is not, and a visitor
 * who never scrolls that far should not pay for the query.
 */

import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { AvailabilityCalendar } from "../components/AvailabilityCalendar.jsx";
import { Card } from "../components/ui/Card.jsx";
import { Button } from "../components/ui/Button.jsx";
import { Page } from "../components/ui/Page.jsx";
import { api } from "../lib/api.js";
import { formatWhen } from "../lib/dates.js";
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

/**
 * The rate card. The whole reason someone is on this page.
 *
 * ONE PRICE IS THE HEADLINE, the rest are a list. The first version rendered every
 * rate at the same weight in a flat column, so a listing with three of them presented
 * the reader with three equal numbers and no answer to "what does this cost" — which
 * is the question they came with. The cheapest unit leads at full size; the others
 * sit under it as alternatives.
 */
function RateCard({ listing }) {
  const rates = RATE_UNITS.filter((unit) => listing[unit.column] != null);
  const [headline, ...alternatives] = rates;

  return (
    <Card className="overflow-hidden">
      <div className="p-6">
        {headline && (
          <p className="flex items-baseline gap-1.5">
            <span className="tabular text-3xl font-semibold tracking-tight text-stone-900">
              {formatPaise(listing[headline.column])}
            </span>
            <span className="text-stone-500">/ {headline.short}</span>
          </p>
        )}

        {alternatives.length > 0 && (
          <ul className="mt-4 space-y-2 border-t border-stone-200 pt-4">
            {alternatives.map((unit) => (
              <li key={unit.key} className="flex items-baseline justify-between gap-4 text-sm">
                <span className="text-stone-600">{unit.label}</span>
                <span className="tabular font-medium text-stone-900">
                  {formatPaise(listing[unit.column])}
                </span>
              </li>
            ))}
          </ul>
        )}

        {listing.deposit_paise > 0 && (
          <p className="mt-4 flex items-baseline justify-between gap-4 border-t border-stone-200 pt-4 text-sm">
            <span className="text-stone-600">Refundable deposit</span>
            <span className="tabular font-medium text-stone-900">
              {formatPaise(listing.deposit_paise)}
            </span>
          </p>
        )}

        {/* Booking exists now. The placeholder that used to say it did not has gone,
            rather than being left to contradict a working button. */}
        <Button as={Link} to={`/listings/${listing.id}/book`} size="lg" fullWidth className="mt-5">
          Request to book
        </Button>

        <p className="mt-3 text-center text-sm text-stone-500">
          Nothing is charged. The owner has 48 hours to reply.
        </p>
      </div>

      {/* Still honest about what does not exist: negotiation is step 7. On its own
          tinted foot rather than as a fourth rule inside the card — it is a note
          about the product, not another line of the price. */}
      <p className="border-t border-stone-200 bg-stone-50 px-6 py-3 text-sm leading-relaxed text-stone-500">
        Price negotiation is not built yet — for now the rate card is the price.
      </p>
    </Card>
  );
}

/** Photos: one large, the rest as a strip. */
function Gallery({ photos, title }) {
  const [active, setActive] = useState(0);

  if (photos.length === 0) {
    return (
      <div className="grid aspect-[3/2] place-items-center rounded-2xl bg-stone-100 text-stone-400">
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
          // 3:2, not 4:3. This image is the tallest thing on the page and it sets
          // where everything under it begins; a quarter less height brings the
          // description and the handover details above the fold.
          //
          // `max-h` on top of the ratio, because a ratio alone means a wider page is
          // a taller photograph — at 1440px this box would be 640px deep and undo
          // exactly what the 3:2 was for. Beyond the cap it crops rather than grows.
          className="aspect-[3/2] max-h-[460px] w-full object-cover"
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

/**
 * FR-205 — when this listing is unavailable, as a visitor sees it.
 *
 * NO `kind`. The API sends that only to the owner, so the calendar renders one
 * undifferentiated "unavailable" here without this component needing to know the
 * distinction exists. Whether a period is somebody else's booking or the owner keeping
 * it back is not a visitor's business.
 *
 * Renders NOTHING when the fetch fails, rather than an error box. A calendar is a
 * supporting detail on this page: a failure here tells a reader nothing they can act
 * on, and an alert in its place would push the price further down the screen.
 */
function Availability({ listingId }) {
  const [state, setState] = useState({ id: null, data: null });

  useEffect(() => {
    let active = true;

    api
      .get(`/listings/${listingId}/availability`)
      .then((data) => active && setState({ id: listingId, data }))
      .catch(() => active && setState({ id: listingId, data: null }));

    return () => {
      active = false;
    };
  }, [listingId]);

  if (state.id !== listingId || !state.data) return null;

  const { unavailable, noticePeriodHours, bookableFrom } = state.data;

  return (
    <Card className="mt-4 p-5">
      <h2 className="font-semibold text-stone-900">Availability</h2>

      {noticePeriodHours != null && (
        <p className="mb-3 mt-1 text-sm leading-relaxed text-stone-600">
          The owner needs notice — the earliest you can start is{" "}
          <span className="font-medium text-stone-900">{formatWhen(bookableFrom)}</span>.
        </p>
      )}

      <div className="mt-3">
        <AvailabilityCalendar unavailable={unavailable} bookableFrom={bookableFrom} />
      </div>
    </Card>
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
      <p className="text-stone-500" role="status">
        Loading…
      </p>
    );
  }

  if (result.error) {
    return (
      <Page width="reading" className="text-center">
        <h1 className="text-xl font-semibold text-stone-900">Listing not found</h1>
        {/* One message for every cause: an unknown id, a malformed one, a draft, and an
            unpublished listing all answer identically, so the copy must not guess. */}
        <p className="mt-3 leading-relaxed text-stone-600">
          It may have been taken down, or the link may be wrong.
        </p>
        <Button as={Link} to="/" variant="outline" className="mt-7">
          Browse RentEasy
        </Button>
      </Page>
    );
  }

  const { listing } = result;

  return (
    <Page>
      {/* A FIXED sidebar, not a fraction of the page. At `1.4fr 1fr` the rate card
          grew with the window and was 570px wide on a large monitor — a price, a
          button and a calendar, none of which is better for being stretched. Pinning
          it hands every extra pixel to the photograph and the description, which are
          the things a wider screen actually helps. */}
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div>
          <Gallery photos={listing.photos} title={listing.title} />

          <h1 className="mt-6 text-3xl font-semibold tracking-tight text-stone-900">
            {listing.title}
          </h1>

          {/* CHIPS, not a dot-separated grey line. Three facts run together in one
              muted sentence are read as one blur; the same three as separate objects
              are scanned. They are also the only colour on an otherwise grey block
              of text. */}
          <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
            <span className="rounded-full bg-brand-50 px-3 py-1 font-medium text-brand-800">
              {listing.category_name}
            </span>
            <span className="rounded-full bg-stone-100 px-3 py-1 text-stone-700">
              {CONDITION_LABELS[listing.condition]} condition
            </span>
            {listing.city && (
              // An area, never a street address — FR-113.
              <span className="rounded-full bg-stone-100 px-3 py-1 text-stone-700">
                {listing.locality}, {listing.city}
              </span>
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
            while scrolling a long description.

            THE CALENDAR BELONGS HERE, NOT UNDER THE DESCRIPTION. "Is it free that
            weekend?" is the same question as "what does it cost?" — one decision, and
            the first version made you scroll past the whole description to answer half
            of it. Below the rate card rather than above it, because the price is what
            brought them to the page. */}
        <div className="lg:sticky lg:top-20 lg:self-start">
          <RateCard listing={listing} />
          <Availability listingId={listing.id} />
        </div>
      </div>
    </Page>
  );
}

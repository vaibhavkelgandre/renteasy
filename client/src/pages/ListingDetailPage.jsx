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
import { Button } from "../components/ui/Button.jsx";
import { Page, Section } from "../components/ui/Page.jsx";
import { Rating } from "../components/ui/Rating.jsx";
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
 * A fact with a label above it.
 *
 * Used for the handover terms and the rental length. Replaces a `<dl>` of grey labels
 * and black values with something that reads as a spec strip — the labels are small
 * and quiet, the values are the size of body copy, and the eye lands on the answers.
 */
function Fact({ label, children }) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-wider text-faint">{label}</dt>
      <dd className="mt-1 font-medium text-ink">{children}</dd>
    </div>
  );
}

/**
 * The rate card. The whole reason someone is on this page.
 *
 * ONE PRICE IS THE HEADLINE, the rest are a list. The first version rendered every
 * rate at the same weight in a flat column, so a listing with three of them presented
 * the reader with three equal numbers and no answer to "what does this cost" — which
 * is the question they came with. The cheapest unit leads at full size; the others
 * sit under it as alternatives.
 *
 * THIS IS ONE OF THE THREE PLACES IN THE APP STILL ALLOWED TO BE A CARD. It has to
 * stay legible while a long description scrolls past it, which is exactly the case the
 * `Card` primitive's own doc reserves a border and a background for.
 */
function RateCard({ listing }) {
  const rates = RATE_UNITS.filter((unit) => listing[unit.column] != null);
  const [headline, ...alternatives] = rates;

  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-surface">
      <div className="p-5 sm:p-6">
        {headline && (
          // 36px, weight 700, tight. The price is the single largest thing on the page
          // after the photograph, because it is the thing being decided.
          <p className="flex items-baseline gap-2">
            <span className="tabular text-4xl font-bold leading-none tracking-tight text-ink">
              {formatPaise(listing[headline.column])}
            </span>
            <span className="text-sm text-muted">per {headline.short}</span>
          </p>
        )}

        {alternatives.length > 0 && (
          <ul className="mt-5 space-y-2.5 border-t border-line pt-4">
            {alternatives.map((unit) => (
              <li key={unit.key} className="flex items-baseline justify-between gap-4 text-sm">
                <span className="text-muted">{unit.label}</span>
                <span className="tabular font-semibold text-ink-soft">
                  {formatPaise(listing[unit.column])}
                </span>
              </li>
            ))}
          </ul>
        )}

        {listing.deposit_paise > 0 && (
          // The deposit is set apart in its own well rather than as one more line in
          // the rate list. It is not a rate — it is money that comes back — and a
          // renter who reads it as a fourth price has been misled by the layout.
          <div className="mt-4 rounded-xl bg-raised p-3">
            <div className="flex items-baseline justify-between gap-4 text-sm">
              <span className="font-medium text-ink-soft">Security deposit</span>
              <span className="tabular font-semibold text-ink">
                {formatPaise(listing.deposit_paise)}
              </span>
            </div>
            <p className="mt-1 text-xs text-muted">Refundable when the item comes back.</p>
          </div>
        )}

        <Button as={Link} to={`/listings/${listing.id}/book`} size="lg" fullWidth className="mt-5">
          Reserve dates
        </Button>

        <p className="mt-3 text-center text-sm text-muted">
          Nothing is charged. The owner has 48 hours to reply.
        </p>
      </div>

      {/* Still honest about what does not exist: negotiation is step 7. On its own
          tinted foot rather than as a fourth rule inside the card — it is a note about
          the product, not another line of the price. */}
      <p className="border-t border-line bg-raised px-5 py-3 text-xs leading-relaxed text-muted sm:px-6">
        Price negotiation is not built yet — for now the rate card is the price.
      </p>
    </div>
  );
}

/**
 * Photos: one large, the rest as a strip.
 *
 * NO FRAME AND NO PADDING. The photograph runs to its own rounded edge and sits
 * directly on the page, which is the difference between a marketplace and a catalogue
 * entry inside a form.
 */
function Gallery({ photos, title }) {
  const [active, setActive] = useState(0);

  if (photos.length === 0) {
    return (
      <div className="grid aspect-[3/2] place-items-center rounded-2xl border border-line bg-raised text-faint">
        No photos
      </div>
    );
  }

  const current = photos[Math.min(active, photos.length - 1)];

  return (
    <div>
      <div className="group relative overflow-hidden rounded-2xl border border-line bg-raised">
        <img
          src={current.url}
          // The listing title, because a photo of a camera on a page headed with that
          // camera's name adds nothing when read aloud — but an empty alt on the ONLY
          // image would leave a screen reader with nothing at all.
          alt={title}
          // 3:2, not 4:3. This image is the tallest thing on the page and it sets where
          // everything under it begins; a quarter less height brings the description
          // and the handover details above the fold.
          //
          // `max-h` on top of the ratio, because a ratio alone means a wider page is a
          // taller photograph — at 1440px this box would be 640px deep and undo exactly
          // what the 3:2 was for. Beyond the cap it crops rather than grows.
          className="aspect-[3/2] max-h-[460px] w-full object-cover transition-transform duration-700 group-hover:scale-[1.03]"
          // Reserving the real dimensions stops the page jumping as it loads, which is
          // why width and height are stored alongside the storage id.
          width={current.width}
          height={current.height}
        />

        {photos.length > 1 && (
          // A counter rather than arrows. The strip below is already the control, and
          // arrows over the image would be a second one doing the same job — but
          // without a count there is nothing telling you the strip is worth looking at.
          <span className="pointer-events-none absolute bottom-3 right-3 rounded-full bg-canvas/80 px-2.5 py-1 text-xs font-semibold tabular text-ink backdrop-blur-sm">
            {Math.min(active, photos.length - 1) + 1} / {photos.length}
          </span>
        )}
      </div>

      {photos.length > 1 && (
        <ul className="mt-3 flex gap-2 overflow-x-auto pb-1">
          {photos.map((photo, index) => (
            <li key={photo.id}>
              <button
                type="button"
                onClick={() => setActive(index)}
                aria-label={`Photo ${index + 1} of ${photos.length}`}
                aria-current={index === active}
                className={[
                  "size-20 shrink-0 overflow-hidden rounded-lg border-2 transition-all duration-150",
                  index === active
                    ? "border-accent"
                    : // Unselected thumbnails are dimmed rather than merely unbordered.
                      // Against a dark page an un-highlighted thumbnail is already
                      // quiet, so a border alone is too weak a signal for which one is
                      // showing; brightness is the stronger one.
                      "border-transparent opacity-55 hover:opacity-100",
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
    <div className="mt-4 rounded-2xl border border-line bg-surface p-5">
      <h2 className="text-sm font-semibold uppercase tracking-[0.08em] text-muted">Availability</h2>

      {noticePeriodHours != null && (
        <p className="mt-2 text-sm leading-relaxed text-muted">
          The owner needs notice — the earliest you can start is{" "}
          <span className="font-semibold text-ink">{formatWhen(bookableFrom)}</span>.
        </p>
      )}

      <div className="mt-3">
        <AvailabilityCalendar unavailable={unavailable} bookableFrom={bookableFrom} />
      </div>
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
      <p className="text-muted" role="status">
        Loading…
      </p>
    );
  }

  if (result.error) {
    return (
      <Page width="reading" className="py-12 text-center">
        <h1 className="text-2xl font-bold text-ink">Listing not found</h1>
        {/* One message for every cause: an unknown id, a malformed one, a draft, and an
            unpublished listing all answer identically, so the copy must not guess. */}
        <p className="mt-3 leading-relaxed text-muted">
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
      {/* A FIXED sidebar, not a fraction of the page. At `1.4fr 1fr` the rate card grew
          with the window and was 570px wide on a large monitor — a price, a button and
          a calendar, none of which is better for being stretched. Pinning it hands every
          extra pixel to the photograph and the description, which are the things a wider
          screen actually helps. */}
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_380px] lg:gap-10">
        <div className="min-w-0">
          <Gallery photos={listing.photos} title={listing.title} />

          {/* THE HEADER BLOCK: name, then the three things a renter checks before
              reading anything — where it is, what state it is in, how it has been
              rated. All on one line under the title rather than scattered down the
              page, because these are what decide whether the description is worth
              reading at all. */}
          <h1 className="mt-7 text-3xl font-bold leading-tight tracking-tight text-ink sm:text-4xl">
            {listing.title}
          </h1>

          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
            {/* FR-806. Beside the title rather than down with the owner link: it is a
                reason to keep reading, and nobody scrolls to find out whether a thing
                is worth scrolling for. */}
            <Rating rating={listing.rating} size="sm" empty="No reviews for this item yet" />

            {listing.city && (
              <>
                <span className="text-line-strong" aria-hidden="true">
                  •
                </span>
                {/* An area, never a street address — FR-113. */}
                <span className="inline-flex items-center gap-1.5 text-muted">
                  <svg
                    className="size-4 shrink-0"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.75"
                    aria-hidden="true"
                  >
                    <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" />
                    <circle cx="12" cy="10" r="3" />
                  </svg>
                  {listing.locality}, {listing.city}
                </span>
              </>
            )}

            <span className="text-line-strong" aria-hidden="true">
              •
            </span>
            <span className="text-muted">{listing.category_name}</span>

            {/* CONDITION KEEPS ITS CHIP while the other two facts became plain text.
                It is the one piece of metadata that varies in a way a renter cares
                about — "Fair" and "Like new" are a real difference — so it earns the
                only enclosure on the line. */}
            <span className="rounded-full border border-line bg-raised px-2.5 py-1 text-xs font-semibold text-ink-soft">
              {CONDITION_LABELS[listing.condition]} condition
            </span>
          </div>

          {/* COPY: "Everything you need to know", not "Description". The old heading
              named the field in the database; this one says what the section is for. */}
          <Section title="Everything you need to know" className="mt-9">
            <p className="whitespace-pre-line leading-relaxed text-ink-soft">
              {listing.description}
            </p>

            <dl className="mt-7 grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3">
              <Fact label="Handover">{FULFILMENT_LABELS[listing.fulfilment]}</Fact>

              {(listing.min_duration_hours || listing.max_duration_hours) && (
                <Fact label="Rental length">
                  {listing.min_duration_hours ? `From ${listing.min_duration_hours}h` : ""}
                  {listing.min_duration_hours && listing.max_duration_hours ? " " : ""}
                  {listing.max_duration_hours ? `up to ${listing.max_duration_hours}h` : ""}
                </Fact>
              )}

              <Fact label="Listed by">
                <Link
                  to={`/u/${listing.owner_id}`}
                  className="text-accent underline underline-offset-2 transition-colors hover:text-accent-hover"
                >
                  the owner
                </Link>
              </Fact>
            </dl>
          </Section>
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

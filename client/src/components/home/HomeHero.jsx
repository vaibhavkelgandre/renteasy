/**
 * The marketing hero at the top of the home page (`/`).
 *
 * NO SEARCH BOX HERE, on purpose. `SearchBox` lives in the header and nowhere else —
 * its own file explains why: a second instance would share its accessible name
 * ("Search listings") with the header's copy, which breaks `getByLabelText` in tests
 * and is two implementations of one control drifting apart. This hero's job is to
 * sell the idea and hand off to the header search or the categories below it, not to
 * duplicate the search itself.
 *
 * TWO CTAs, ONE PRIMARY. "Browse listings" just scrolls to the results already on this
 * same page — there is no separate route to send someone to. "List your item" goes
 * through the ordinary `/listings/new` route, which is already behind `RequireAuth`;
 * a signed-out visitor clicking it is bounced to `/login` and back by the existing
 * guard, so this component needs no auth check of its own.
 *
 * THE BANNER SITS TO THE RIGHT OF THE TEXT ON `lg` AND UP, STACKED BELOW IT ON A
 * PHONE — a two-column `grid`, not an absolutely-positioned image behind the text,
 * because an overlay risks the headline landing on a busy part of the artwork at
 * some width nobody tested. `object-contain`, not `object-cover`: this is a composite
 * illustration, not a photo with a forgiving amount of background to crop into — the
 * exact mistake fixed elsewhere in this app for listing photos (see `listingPhotoUrl`
 * in `cloudinary.js`) is not one to reintroduce here.
 *
 * NO CARD FRAME AROUND IT, ON DIRECT REQUEST. The artwork's own background is already
 * near-black, so a bordered `bg-raised` box around it just drew a visible seam where
 * the image's dark background met the panel's slightly-lighter one instead of blending
 * into the page. `rounded-2xl` stays on the `<img>` itself — dropping the frame is not
 * the same as dropping every corner treatment.
 */

import { Link } from "react-router-dom";
import { Button } from "../ui/Button.jsx";

/**
 * @param {object} props
 * @param {number|null} [props.totalListings] Live count, once the results below have
 *        loaded. `null` while loading or on failure — the line is omitted rather than
 *        shown as "0 listings" for a moment on every load.
 * @param {() => void} props.onBrowseClick Scrolls to the results section.
 */
export function HomeHero({ totalListings = null, onBrowseClick }) {
  return (
    <section className="relative overflow-hidden pb-14 pt-6 sm:pb-20 sm:pt-10">
      {/* The image column is deliberately wider than the text column (`1fr` vs
          `1.15fr`) — asked to be made bigger, and the artwork is the more eye-catching
          half of the two. */}
      <div className="grid items-center gap-10 lg:grid-cols-[1fr_1.15fr] lg:gap-14">
        <div className="max-w-2xl">
          {totalListings != null && totalListings > 0 && (
            // A LIVE FIGURE, NOT A SLOGAN. "Trusted by thousands" on a fresh
            // marketplace is the kind of claim nobody believes; a real count of what
            // is actually listed right now is small and true instead.
            <p className="mb-4 inline-flex items-center gap-2 rounded-full border border-line bg-raised px-3 py-1 text-xs font-semibold text-muted">
              <span className="size-1.5 rounded-full bg-good" aria-hidden="true" />
              <span className="tabular text-ink">{totalListings}</span> listings
              available right now
            </p>
          )}

          {/* The site's original tagline — used here rather than invented, because it
              already describes the product rather than the screen underneath it,
              which is exactly the job a hero headline has and a results-page heading
              does not. */}
          <h1 className="text-4xl font-bold leading-[1.1] tracking-tight text-ink sm:text-5xl">
            Rent almost anything, <span className="text-accent">nearby</span>.
          </h1>

          <p className="mt-4 max-w-lg text-lg leading-relaxed text-muted">
            Cameras, tools, bikes and the rest — by the hour, the day or the month,
            from people a few streets away instead of a warehouse.
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Button size="lg" onClick={onBrowseClick}>
              Browse listings
            </Button>
            <Button as={Link} to="/listings/new" size="lg" variant="outline">
              List your item
            </Button>
          </div>

          <p className="mt-5 text-sm text-faint">
            Free to browse — creating an account is only needed to list something or
            reserve one.
          </p>
        </div>

        {/* `order-first` on mobile would put a tall image above the headline, pushing
            the actual pitch below the fold — so it stays document-order (below the
            text) until `lg`, where the grid places it beside the text instead. */}
        <div className="mx-auto w-full max-w-xl lg:max-w-none">
          <img
            src="/images/home-hero-banner.webp"
            // Decorative: every category it depicts (cameras, bikes, tools, a tent,
            // a sofa) is already named in the paragraph beside it, so a screen
            // reader announcing this image again would be repeating itself.
            alt=""
            // Matches the source asset's own 1671x940 ratio, so it never has to
            // letterbox or stretch — `object-contain` is then a no-op sizing decision
            // rather than a fallback for a mismatched box. `rounded-2xl` is on the
            // image itself now that there's no frame around it to carry the radius.
            className="aspect-[1671/940] w-full rounded-2xl object-contain"
            width={1671}
            height={940}
            // Eager, not lazy: this is above the fold on every viewport it renders
            // on, so lazy-loading it would just delay something already visible.
            loading="eager"
          />
        </div>
      </div>
    </section>
  );
}

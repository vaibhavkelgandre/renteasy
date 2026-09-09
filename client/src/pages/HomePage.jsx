/**
 * The landing page — public, and the same page whether you are signed in or not.
 *
 * DELIBERATELY HONEST ABOUT WHAT EXISTS. There are no listings yet, so there is no
 * fake grid of cameras: a placeholder tile reading "Canon EOS R6 — ₹800/day" is
 * indistinguishable from a real one, and a page of invented inventory teaches you to
 * distrust the real listings when they arrive.
 *
 * So it explains the product and says plainly what is coming. When step 3 lands, the
 * category strip below becomes real links and this copy becomes a search bar.
 */

import { Link } from "react-router-dom";
import { Card } from "../components/ui/Card.jsx";
import { Button } from "../components/ui/Button.jsx";
import { useAuth } from "../context/AuthContext.jsx";

/**
 * The categories the product is built around.
 *
 * V1 handles PORTABLE GOODS — cameras, bikes, tools, appliances. Property is
 * deliberately absent: it needs rental agreements, longer terms and local legal
 * compliance that would swamp everything else (docs/0.product-overview.md §7).
 */
const CATEGORIES = [
  { label: "Cameras & lenses", hint: "hourly or daily" },
  { label: "Bikes & scooters", hint: "daily" },
  { label: "Power tools", hint: "hourly or daily" },
  { label: "Appliances", hint: "monthly" },
];

/** What is not built yet, in build order. This panel disappears as each lands. */
const COMING_NEXT = [
  "Listings, with hourly, daily and monthly rates",
  "Availability calendars, so nothing is double-booked",
  "Booking requests and price negotiation",
  "Handover, return and two-way reviews",
];

export function HomePage() {
  const { user, isVerified } = useAuth();

  return (
    <div className="space-y-10">
      <section className="py-6 sm:py-10">
        <h1 className="max-w-2xl text-3xl font-semibold leading-tight tracking-tight text-stone-900 sm:text-4xl">
          Rent almost anything — by the hour, the day or the month.
        </h1>
        <p className="mt-4 max-w-xl leading-relaxed text-stone-600">
          A camera for the weekend. A drill for an afternoon. A water purifier for a
          year. Borrow what you need from people nearby, and earn from the things you
          already own but rarely use.
        </p>

        {/* The rate example, in the app's mono/tabular treatment.
            NOT decoration: the cheapest-applicable-rate rule is the product's least
            obvious behaviour, and showing three prices side by side is how someone
            grasps it before they ever see a listing. */}
        <div className="mt-8 inline-flex flex-wrap items-center gap-x-6 gap-y-2 rounded-2xl border border-stone-200 bg-white px-5 py-4">
          <span className="text-sm text-stone-500">A camera might rent for</span>
          <span className="font-mono text-sm tabular text-stone-900">₹150/hour</span>
          <span className="font-mono text-sm tabular text-stone-900">₹800/day</span>
          <span className="font-mono text-sm tabular text-brand-700">₹15,000/month</span>
        </div>
        <p className="mt-3 max-w-xl text-sm leading-relaxed text-stone-500">
          Rent for a month and you pay the monthly rate — never thirty times the daily
          one. We always charge the cheapest combination and show you the breakdown
          before you book.
        </p>

        {!user && (
          <div className="mt-8 flex flex-wrap gap-3">
            <Button as={Link} to="/register" size="lg">
              Get started
            </Button>
            <Button as={Link} to="/login" size="lg" variant="outline">
              Sign in
            </Button>
          </div>
        )}

        {user && isVerified && (
          <p className="mt-8 text-sm text-stone-500">
            Your email is confirmed — you&rsquo;ll be able to list and book as soon as
            listings are live.
          </p>
        )}
      </section>

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">
          What people rent
        </h2>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {CATEGORIES.map((category) => (
            <Card key={category.label} className="p-5">
              <p className="font-medium text-stone-900">{category.label}</p>
              {/* The typical unit differs per category, and that is a real product
                  fact rather than filler — a drill is rented by the hour and a water
                  purifier by the month. */}
              <p className="mt-1 text-sm text-stone-500">Usually {category.hint}</p>
            </Card>
          ))}
        </div>
      </section>

      <section>
        <Card className="p-6">
          <h2 className="font-semibold text-stone-900">Coming next</h2>
          <p className="mt-1 text-sm text-stone-500">
            Not built yet. This panel disappears as each part lands.
          </p>
          <ul className="mt-4 space-y-2.5">
            {COMING_NEXT.map((item, index) => (
              <li key={item} className="flex items-start gap-3 text-sm text-stone-700">
                <span className="grid size-6 shrink-0 place-items-center rounded-full bg-stone-100 font-mono text-xs tabular text-stone-500">
                  {index + 1}
                </span>
                {item}
              </li>
            ))}
          </ul>
        </Card>
      </section>
    </div>
  );
}

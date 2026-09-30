/**
 * The site footer — every page inside AppLayout gets it, nothing else does.
 *
 * NOTHING HERE IS INVENTED. There is no About/Contact/Help page in this app (see
 * App.jsx's route list), so this does not link to one — a footer full of dead
 * anchors reads as unfinished faster than a short, honest one does. Same reason the
 * cities and categories below are FETCHED, not typed in: a hardcoded "Pune, Mumbai,
 * Bengaluru" list would drift the moment the actual data doesn't match it, exactly
 * the failure mode `docs/1.status.md` calls out for any list that could instead be
 * derived.
 *
 * REUSES THE SAME TWO ENDPOINTS HomePage.jsx ALREADY CALLS for its own filter
 * dropdowns (`/listings/categories`, `/listings/cities`) rather than inventing a
 * footer-specific one — this is the same list, just rendered somewhere else on the
 * page. A silent failure (`.catch(() => {})`) just means those two columns render
 * empty; the footer's links and brand column need no network call at all and must
 * not disappear because one fetch failed.
 */

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Logo } from "../Logo.jsx";
import { api } from "../../lib/api.js";

/** Real routes only — see the file header for why. */
const EXPLORE_LINKS = [
  { to: "/", label: "Browse listings" },
  { to: "/listings/new", label: "List an item" },
];

const ACCOUNT_LINKS = [
  { to: "/login", label: "Sign in" },
  { to: "/register", label: "Create account" },
  { to: "/terms", label: "Terms of service" },
];

function FooterColumn({ title, links }) {
  return (
    <div>
      <h3 className="text-sm font-semibold text-ink">{title}</h3>
      <ul className="mt-4 space-y-2.5">
        {links.map((link) => (
          <li key={link.to}>
            <Link to={link.to} className="text-sm text-muted transition-colors hover:text-ink">
              {link.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Footer() {
  const [categories, setCategories] = useState([]);
  const [cities, setCities] = useState([]);

  useEffect(() => {
    let active = true;

    Promise.all([api.get("/listings/categories"), api.get("/listings/cities")])
      .then(([categoryData, cityData]) => {
        if (!active) return;
        setCategories(categoryData.categories);
        setCities(cityData.cities);
      })
      // Silent: a footer that fails to load its two extra columns should still be a
      // footer, not an error box under every page in the app.
      .catch(() => {});

    return () => {
      active = false;
    };
  }, []);

  return (
    <footer className="border-t border-line bg-surface">
      <div className="mx-auto grid max-w-content gap-10 px-5 py-12 sm:grid-cols-2 lg:grid-cols-[1.3fr_1fr_1fr_1.3fr] lg:gap-8 lg:px-8">
        <div className="max-w-xs">
          <Logo />
          <p className="mt-4 text-sm leading-relaxed text-muted">
            Rent almost anything, nearby — cameras, tools, bikes and the rest, by the
            hour, the day or the month, from people a few streets away.
          </p>
        </div>

        <FooterColumn title="Explore" links={EXPLORE_LINKS} />
        <FooterColumn title="Account" links={ACCOUNT_LINKS} />

        {/* Omitted entirely while empty (still loading, or the fetch failed) rather
            than rendering an empty "Popular categories" heading over nothing. */}
        {categories.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold text-ink">Popular categories</h3>
            <ul className="mt-4 space-y-2.5">
              {/* Six, not all of them — a footer column is a sample of what's here,
                  not the same picker the browse filters already are. */}
              {categories.slice(0, 6).map((category) => (
                <li key={category.slug}>
                  <Link
                    to={`/?category=${category.slug}`}
                    className="text-sm text-muted transition-colors hover:text-ink"
                  >
                    {category.name}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {cities.length > 0 && (
        <div className="border-t border-line">
          <div className="mx-auto max-w-content px-5 py-6 lg:px-8">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-faint">
              Currently available in
            </h3>
            {/* Pills, not a comma-separated line — matches the "listings available
                right now" chip HomeHero already uses for the same kind of live,
                small fact about the marketplace. */}
            <div className="mt-3 flex flex-wrap gap-2">
              {cities.map((city) => (
                <span
                  key={city}
                  className="rounded-full border border-line bg-raised px-3 py-1 text-xs text-muted"
                >
                  {city}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="border-t border-line">
        <div className="mx-auto max-w-content px-5 py-6 text-xs text-faint lg:px-8">
          {/* No "made with", no social icons, no company address — none of them
              exist for this project, and a footer inventing them would be lying
              about a demo marketplace's provenance for no reason. */}
          <p>© {new Date().getFullYear()} RentEasy.</p>
        </div>
      </div>
    </footer>
  );
}

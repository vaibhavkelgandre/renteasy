/**
 * Somebody's public profile — FR-033, at `/u/:id`.
 *
 * PUBLIC, with no session required, because the whole point is that a listing can name
 * who is offering it to a visitor who has no account.
 *
 * WHAT IS NOT HERE, and must never be added: the email address and the phone number.
 * The API does not return them — the query selects four columns rather than filtering a
 * wider row — so this page could not display them if it tried. Both facts matter: a
 * marketplace puts strangers in contact, and leaking a contact detail from a profile
 * page is the difference between "someone wants to rent my camera" and "someone knows
 * how to reach me at home".
 *
 * PARTIAL BY DESIGN, for now. FR-033 also asks for a rating and a listing count, and
 * neither has a table yet (steps 9 and 3). The API returns `null` for both — meaning
 * "unknown", not "zero" — and this page says so rather than rendering a confident 0
 * that would read as "this person has never listed anything".
 */

import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Card } from "../components/ui/Card.jsx";
import { Rating } from "../components/ui/Rating.jsx";
import { Button } from "../components/ui/Button.jsx";
import { api } from "../lib/api.js";

/** Formats a timestamp as a plain month and year. */
function memberSince(iso) {
  return new Date(iso).toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

/** The circle of initials shown in place of an avatar. */
function Initials({ name }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join("");

  return (
    <div
      className="grid size-16 place-items-center rounded-full bg-accent-soft text-xl font-semibold text-accent"
      aria-hidden="true"
    >
      {initials}
    </div>
  );
}

export function PublicProfilePage() {
  const { id } = useParams();

  // Keyed by the id it was fetched for, rather than nulled imperatively at the top of
  // the effect. A synchronous setState in an effect body is both an extra render and a
  // lint error; comparing the stored key to the current param says "stale" without one.
  const [result, setResult] = useState({ id: null, profile: null, error: null });
  const [reviews, setReviews] = useState(null);

  useEffect(() => {
    let active = true;

    api
      .get(`/users/${id}/public`)
      .then((data) => active && setResult({ id, profile: data.profile, error: null }))
      .catch((error) => active && setResult({ id, profile: null, error: error.message }));

    // A separate call, deliberately. Reviews are public and paginated and belong to
    // their own endpoint; folding them into the profile response would make every
    // profile read carry a list most callers do not want.
    api
      .get(`/users/${id}/reviews?limit=5`)
      .then((data) => active && setReviews(data))
      .catch(() => active && setReviews(null));

    return () => {
      active = false;
    };
  }, [id]);

  const settled = result.id === id;

  if (!settled) {
    return (
      <div className="mx-auto w-full max-w-2xl">
        <Card className="p-8">
          <div className="h-16 w-16 animate-pulse rounded-full bg-raised" />
          <span className="sr-only" role="status">
            Loading profile
          </span>
        </Card>
      </div>
    );
  }

  if (result.error) {
    return (
      <div className="mx-auto w-full max-w-2xl text-center">
        <h1 className="text-xl font-semibold text-ink">Profile not found</h1>
        {/* One message for every cause. The API answers an identical 404 for an unknown
            id, a malformed one and a suspended or deleted account — a stranger has no
            more reason to learn somebody was once here than to learn they never were. */}
        <p className="mt-3 leading-relaxed text-muted">
          There is nobody here. The link may be wrong, or the account may no longer be
          active.
        </p>
        <Button as={Link} to="/" variant="outline" className="mt-7">
          Browse RentEasy
        </Button>
      </div>
    );
  }

  const { profile } = result;

  return (
    <div className="mx-auto w-full max-w-2xl">
      <Card className="p-7 sm:p-8">
        <div className="flex items-center gap-5">
          <Initials name={profile.name} />
          <div className="min-w-0">
            <h1 className="truncate text-xl font-semibold tracking-tight text-ink">
              {profile.name}
            </h1>
            <p className="mt-1 text-sm text-muted">
              Member since {memberSince(profile.memberSince)}
            </p>

            {/* FR-033, FR-806. TWO RATINGS, NEVER ONE — being reliable to lend to
                says very little about being reliable to lend TO, and a blended
                average hides exactly what a reader came to find out. Each is shown
                only once somebody has actually been rated that way. */}
            {reviews?.rating?.asOwner?.count > 0 && (
              <p className="mt-2 flex flex-wrap items-center gap-x-2 text-sm">
                <span className="text-muted">As an owner</span>
                <Rating rating={reviews.rating.asOwner} size="sm" />
              </p>
            )}
            {reviews?.rating?.asRenter?.count > 0 && (
              <p className="mt-1 flex flex-wrap items-center gap-x-2 text-sm">
                <span className="text-muted">As a renter</span>
                <Rating rating={reviews.rating.asRenter} size="sm" />
              </p>
            )}
          </div>
        </div>

        {/* A confirmed email is the only trust signal this product can currently show.
            It is deliberately modest: it says the address is real, not that the person
            is. Phone and ID verification are the higher tiers (FR-035 to FR-038) and
            neither exists yet, so overstating this one would be dishonest. */}
        {profile.emailVerified && (
          <p className="mt-6 inline-flex items-center gap-2 rounded-full bg-good-soft px-3 py-1 text-sm font-medium text-good">
            <svg className="size-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <path
                fillRule="evenodd"
                d="M16.7 5.3a1 1 0 010 1.4l-8 8a1 1 0 01-1.4 0l-4-4a1 1 0 011.4-1.4L8 12.6l7.3-7.3a1 1 0 011.4 0z"
                clipRule="evenodd"
              />
            </svg>
            Email confirmed
          </p>
        )}

        {reviews?.reviews?.length > 0 && (
          <div className="mt-7 border-t border-line pt-6">
            <h2 className="font-semibold text-ink">
              What people said
            </h2>
            <ul className="mt-3 space-y-4">
              {reviews.reviews.map((review) => (
                <li key={review.id}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span aria-label={`${review.rating} out of 5`} className="text-accent">
                      {"★".repeat(review.rating)}
                      <span className="text-faint">{"★".repeat(5 - review.rating)}</span>
                    </span>
                    <span className="text-sm text-muted">
                      {review.direction === "OF_OWNER" ? "as an owner" : "as a renter"}
                    </span>
                  </div>
                  {review.body && (
                    <p className="mt-1 leading-relaxed text-ink-soft">{review.body}</p>
                  )}
                  {review.reply_body && (
                    <p className="mt-2 rounded-lg bg-raised px-3 py-2 text-sm leading-relaxed text-muted">
                      <span className="font-medium">Reply: </span>
                      {review.reply_body}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        <dl className="mt-7 grid grid-cols-2 gap-4 border-t border-line pt-6">
          <div>
            <dt className="text-sm text-muted">Listings</dt>
            <dd className="mt-0.5 font-medium text-ink">
              {/* null means "listings do not exist yet", not "this person has none". */}
              {profile.listingCount ?? "—"}
            </dd>
          </div>
          <div>
            <dt className="text-sm text-muted">Rating</dt>
            <dd className="mt-0.5 font-medium text-ink">{profile.rating ?? "—"}</dd>
          </div>
        </dl>

        <p className="mt-5 text-sm leading-relaxed text-muted">
          Listings and reviews arrive with the rest of the marketplace.
        </p>
      </Card>
    </div>
  );
}

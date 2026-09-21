/**
 * Reviews on a completed booking — FR-800 to FR-805, FR-808.
 *
 * THE BLIND PERIOD IS THE THING TO GET RIGHT IN THE UI, not just the API. An author
 * who writes a review and then sees nothing happen will assume it failed, so the
 * panel has to say plainly that it is written, that it is hidden, and why.
 */

import { useCallback, useEffect, useState } from "react";
import { Alert } from "../ui/Alert.jsx";
import { Button } from "../ui/Button.jsx";
import { Section } from "../ui/Page.jsx";
import { api, ApiError } from "../../lib/api.js";
import { formatWhen } from "../../lib/dates.js";

/**
 * A row of stars.
 *
 * Buttons when it is an input, plain text when it is not — rather than disabled
 * buttons, which are five tab stops with nothing at any of them.
 */
function Stars({ value, onChange = null, size = "text-2xl" }) {
  if (!onChange) {
    return (
      <span className={`${size} leading-none text-accent`} aria-label={`${value} out of 5`}>
        {"★".repeat(value)}
        <span className="text-faint">{"★".repeat(5 - value)}</span>
      </span>
    );
  }

  return (
    <span className="flex gap-1">
      {[1, 2, 3, 4, 5].map((star) => (
        <button
          key={star}
          type="button"
          onClick={() => onChange(star)}
          aria-label={`${star} star${star === 1 ? "" : "s"}`}
          aria-pressed={value === star}
          className={`${size} leading-none transition-transform hover:scale-110 ${
            star <= value ? "text-accent" : "text-faint"
          }`}
        >
          ★
        </button>
      ))}
    </span>
  );
}

function WriteReview({ bookingId, onWritten }) {
  const [rating, setRating] = useState(0);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit(event) {
    event.preventDefault();
    if (!rating) {
      setError("Choose a rating first.");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await api.post(`/bookings/${bookingId}/reviews`, {
        rating,
        body: body.trim() || undefined,
      });
      onWritten();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not save that.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-3 space-y-3">
      <div>
        <span className="mb-1.5 block text-sm font-medium text-ink-soft">How did it go?</span>
        <Stars value={rating} onChange={setRating} />
      </div>

      <textarea
        value={body}
        onChange={(event) => setBody(event.target.value)}
        rows={3}
        maxLength={2000}
        placeholder="Anything worth telling the next person? (optional)"
        aria-label="Your review"
        className="w-full resize-y rounded-xl border border-line bg-raised px-3 py-2 text-[15px] text-ink transition-colors placeholder:text-faint focus:border-accent"
      />

      {error && <Alert tone="error">{error}</Alert>}

      {/* Said BEFORE they write, not after. Somebody who submits and then sees
          nothing appear will assume it failed. */}
      <p className="text-sm leading-relaxed text-muted">
        Neither review is visible until you have both written one, or two weeks have
        passed — so nobody can reply to a rating with a rating.
      </p>

      <Button type="submit" loading={busy}>
        Submit review
      </Button>
    </form>
  );
}

function ReviewCard({ review, canReply, onReplied }) {
  const [replying, setReplying] = useState(false);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post(`/reviews/${review.id}/reply`, { body: body.trim() });
      setReplying(false);
      onReplied();
    } catch (caught) {
      setError(caught.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="border-t border-line pt-4 first:border-0 first:pt-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Stars value={review.rating} size="text-base" />
          <span className="text-sm font-medium text-ink">
            {review.isMine ? "You" : review.author_name}
          </span>
        </div>
        <span className="text-xs text-muted">{formatWhen(review.created_at)}</span>
      </div>

      {review.body && (
        <p className="mt-2 whitespace-pre-wrap leading-relaxed text-ink-soft">{review.body}</p>
      )}

      {!review.isPublished && (
        // The author is the only person who can see this, so it is the only person
        // who needs telling why nobody else can.
        <p className="mt-2 rounded-lg bg-raised px-3 py-2 text-sm text-muted">
          Written, but not visible yet — it appears once the other party reviews you,
          or after two weeks.
        </p>
      )}

      {review.reply_body && (
        <div className="mt-3 rounded-xl bg-raised px-3 py-2.5">
          <p className="text-xs font-medium text-muted">Reply</p>
          <p className="mt-0.5 whitespace-pre-wrap leading-relaxed text-ink-soft">
            {review.reply_body}
          </p>
        </div>
      )}

      {canReply && !review.reply_body && !replying && (
        <button
          type="button"
          onClick={() => setReplying(true)}
          className="mt-2 text-sm font-medium text-accent underline underline-offset-2"
        >
          Reply publicly
        </button>
      )}

      {replying && (
        <form onSubmit={submit} className="mt-3 space-y-2">
          <textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            rows={2}
            maxLength={2000}
            aria-label="Your reply"
            placeholder="Your side of it…"
            className="w-full resize-y rounded-xl border border-line bg-raised px-3 py-2 text-sm text-ink transition-colors focus:border-accent"
          />
          {error && <Alert tone="error">{error}</Alert>}
          {/* Said out loud because it is irreversible and public. */}
          <p className="text-xs text-muted">
            One reply per review, and it cannot be changed afterwards.
          </p>
          <div className="flex gap-2">
            <Button type="submit" size="sm" loading={busy} disabled={!body.trim()}>
              Post reply
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setReplying(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </li>
  );
}

/**
 * @param {object} props
 * @param {string} props.bookingId
 * @param {string} props.bookingStatus
 * @param {string} props.currentUserId
 */
export function BookingReviews({ bookingId, bookingStatus, currentUserId }) {
  const [state, setState] = useState({ reviews: [], canReview: false, loaded: false });

  const load = useCallback(
    () =>
      api
        .get(`/bookings/${bookingId}/reviews`)
        // DEFAULTED, NEVER SPREAD BLIND. The same mistake as ConditionPhotos in
        // step 8: a response that is not the shape this panel expects must not
        // blank the whole page, and `{...data}` with no `reviews` key leaves the
        // list undefined at the first `.length`. One panel's bad answer is a quiet
        // empty panel, not a crashed booking.
        .then((data) =>
          setState({
            reviews: data?.reviews ?? [],
            canReview: Boolean(data?.canReview),
            loaded: true,
          })
        )
        // Reviews are a footnote on a booking that is already fully rendered; an
        // error box here would be louder than the feature.
        .catch(() => setState({ reviews: [], canReview: false, loaded: true })),
    [bookingId]
  );

  useEffect(() => {
    load();
  }, [load]);

  // FR-801 — nothing to show and nothing to do until the rental is over. Rendering
  // an empty "Reviews" card on every live booking is noise on the screen people
  // spend the most time on.
  if (bookingStatus !== "COMPLETED" || !state.loaded) return null;

  return (
    <Section title="Reviews" className="mt-8">
      {state.canReview && <WriteReview bookingId={bookingId} onWritten={load} />}

      {state.reviews.length > 0 && (
        <ul className="mt-4 space-y-4">
          {state.reviews.map((review) => (
            <ReviewCard
              key={review.id}
              review={review}
              // Only the person a review is ABOUT may answer it, and only once it
              // is public — there is nothing to answer before that.
              canReply={review.subject_id === currentUserId && review.isPublished}
              onReplied={load}
            />
          ))}
        </ul>
      )}

      {!state.canReview && state.reviews.length === 0 && (
        <p className="mt-2 text-sm leading-relaxed text-muted">
          No reviews yet.
        </p>
      )}
    </Section>
  );
}

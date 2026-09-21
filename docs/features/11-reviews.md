# 11 — Two-way reviews

**FR-800 to FR-808.** Status: **complete** — 18 integration tests, review and reply
on the booking page, ratings on the public profile and on each listing.

Unblocks three long-standing partials: FR-033 (rating on a profile), FR-306 (sort by
rating — see §8) and FR-310 (a listing's rating).

---

## 1. FR-804 is the feature; everything else is downstream

*Blind until both submit, or the window closes.*

Without it the second review is a **reply** to the first: you read that they called
you difficult, and you mark them down for it. Neither number then measures the
rental — they measure each other.

Two triggers publish a pair:

- **Both written.** Checked the moment the second one lands.
- **The window ran out** — 14 days, swept hourly by the existing `SWEEPS` list.

> The window is measured from the **review's own `created_at`**, not the booking's
> end. Otherwise one written on day thirteen publishes tomorrow while one written on
> day one waits a fortnight, which makes the window a lottery rather than a rule.

Three different answers come out of one read, and that is the whole visibility model:

| Who | Sees |
|---|---|
| the author | their own, always — published or not |
| the subject | only once published |
| anybody else | only published ones |

## 2. Where FR-804 and FR-805 contradict each other

FR-805 says a review is **editable for 48 hours**. FR-804 says it is **blind until
both submit**. Read independently, those conflict:

> If the other party writes theirs an hour after yours, both publish. A 48-hour edit
> window would then let you rewrite yours **having read theirs** — exactly the
> retaliation FR-804 exists to prevent.

**Publication closes the edit window early.** Editable for 48 hours *or until
published, whichever comes first.*

The cost is real and accepted: two people who both review promptly get no edit
window at all. That is the honest reading — once you can see theirs, you can no
longer change yours in response. There is a test that writes a review, has the other
party reply with a 1-star, and asserts the first author cannot then retaliate.

## 3. Two ratings, never one

A review carries a `direction` — `OF_OWNER` or `OF_RENTER` — and the aggregates stay
apart.

**Being reliable to lend to says very little about being reliable to lend *to*.** A
single blended average hides exactly what somebody came to find out, and it would
let a prolific renter's good record paper over a poor record as an owner.

`direction` is derivable from the booking but is stored, because otherwise every
aggregate query joins back through `bookings` to `listings` to work out who owned
what.

**Derived, not stored.** Same habit as `count(*) OVER ()` and the LMS ledger: a
number you can compute cannot drift. If it ever costs enough to matter, the fix is a
column maintained by the publishing sweep — not a different shape at the repository.

## 4. A listing's rating is its owner's, for that listing

FR-806 wants a rating per listing. There is deliberately **no separate "review of a
listing"**: a review is of a person (FR-800), and a second kind would let the two
disagree about the same rental.

So a listing's rating is the average of `OF_OWNER` reviews for **bookings of that
listing**. Reached through the booking, in one grouped query.

## 5. Never deletable, but not append-only

`booking_events`, `booking_photos` and `booking_messages` are all append-only by
trigger. Reviews are **not**, and the difference is deliberate: a review is edited
(FR-805), published later, and can gain a reply (FR-808), so `UPDATE` is part of its
normal life.

What must never happen is deletion, and that is its own trigger. **A reputation
somebody can erase by deleting the bad ones is not a reputation**, and "let them
remove one left by mistake" is indistinguishable from "remove the one that was
deserved".

## 6. The subject decides the review, never the request

Who is being reviewed follows from who is writing: a booking has exactly two people,
and the author's role picks the other. Taking a `subjectId` from the body would let
somebody aim a review at a third party, and there is nothing to choose anyway.

## 7. Notifications

- **`REVIEW_INVITED`** when a booking completes — **to both parties**, which is the
  only booking notification that is. Every other tells the party who did *not* act,
  because an action needs no announcing to the person who took it; completion opens
  something new for each of them.
- **`REVIEW_PUBLISHED`** when the blind period ends, by either trigger. That instant
  is the only one worth a notification, because it is the first time either of them
  can read anything.

**No rating in either message.** "You were given 2 stars" on a lock screen is a
worse way to find out than opening the app — FR-987's reasoning covers a number that
stings as much as one that is valuable.

## 8. Schema

Migration `011_create_reviews.sql`. Column notes: [3.db.md](../3.db.md).

> The notification type list was **read out of the database** before being
> re-stated, not copied from migration 010 — and this time the check was automated
> before applying, comparing the live list against the one about to replace it.

## 9. What this does NOT do

- **No rating sort in browse (FR-306).** The rating exists per listing now, but
  sorting the browse query by it needs a join on every row, which is the one place
  where deriving rather than storing would actually cost something. It is the
  natural first consumer of a denormalised column if one is ever added.
- **No review reminders.** A nudge before the window closes would raise the response
  rate, and it needs a rule for not re-sending daily — the same design work FR-983's
  reminders need.
- **No moderation.** A review cannot be reported or removed by anybody, including an
  admin, because there is no admin surface. The reply (FR-808) is the only answer a
  subject has.
- **No "verified rental" badge**, because every review already requires a completed
  booking — there is no unverified kind to distinguish it from.

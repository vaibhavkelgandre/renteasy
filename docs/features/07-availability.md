# 07 — Availability: blackouts, the notice period and the calendar

**FR-200 to FR-206**, plus the halves of **FR-303**, **FR-503** and **FR-504** that were waiting on
them. Status: **complete** — API, client screens and 22 integration tests.

Built after step 6, out of order, because five of these seven requirements need a `bookings` table
to mean anything at all.

---

## 1. The shape

```
GET    /listings/:id/availability   public, owner-aware  → when it is unavailable
GET    /listings/:id/blackouts      owner only           → ids and reasons
POST   /listings/:id/blackouts      owner only           → 201
DELETE /listings/:id/blackouts/:blockId
PATCH  /listings/:id                { noticePeriodHours } — FR-203
```

Client: `/listings/:id/availability` is the owner's screen (calendar, blackout list, notice
period), and the public listing page carries the same calendar without the owner-only field.

## 2. There is no availability table

The tempting design is a table of free or busy periods that bookings and blackouts both write to.
It is wrong, and the reason is the usual one: it is **derived data that can fall out of sync** with
the two tables it comes from, and nothing would notice when it did.

`findUnavailablePeriods` is a `UNION ALL` over `bookings` (confirmed only) and
`availability_blocks`, tagged with a `kind`. FR-201 — "a confirmed booking blocks its dates
automatically" — is therefore not a feature that was built; it is a consequence of never having
recorded the same fact twice.

## 3. The decisions that carry weight

### 3.1 A blackout is its own table, not a fake booking

The shortcut is to insert a booking with no renter. That means a nullable `renter_id`, a status
nothing can transition out of, a price of zero that is not a price, and every booking query in the
product having to remember to exclude them. A blackout has none of a booking's parts — no
counterparty, no money, no state machine — so it gets its own table with four columns.

### 3.2 FR-206 is a trigger, and it is knowingly weaker than FR-202

A blackout may not cover a booking the owner already committed to. That rule spans **two tables**,
and no `EXCLUDE` constraint can express one — so it is a trigger.

A trigger is not the same strength of guarantee, and pretending otherwise would be the worse
mistake. Under READ COMMITTED this is classic write skew: one transaction inserts a blackout while
another accepts a booking for the same dates, neither sees the other's uncommitted row, and both
commit. Closing it needs SERIALIZABLE or an explicit lock on the listing.

**That window is accepted, and the stakes are why.** A double booking promises one stranger's
camera to two people — an obligation the platform cannot honour. An overlapping blackout is the
owner contradicting their own calendar: visible to them, fixable by them, harming nobody else.
Paying for SERIALIZABLE across the whole booking path to close it would be the wrong trade.

The trigger still earns its place. It makes the rule impossible to skip from a code path nobody has
written yet, which a service-layer check does not — and there is a test that inserts a blackout
with raw SQL, bypassing the service entirely, to prove it.

### 3.3 The trigger shipped broken, and it failed open

Worth recording in full, because the same shape will recur anywhere a generated column meets a
trigger.

The first version was `BEFORE INSERT OR UPDATE`. `period` is a **stored generated column**, and
Postgres computes those *after* row-level BEFORE triggers run — so `NEW.period` was `NULL`,
`b.period && NULL` evaluated to `NULL` rather than true, `IF FOUND` never fired, and **every
blackout was allowed**.

It failed open: the guard looked correct, the migration applied cleanly, and nothing complained.
Only a test that actually attempted the overlap found it. The fix is `AFTER` — the row is inserted
first and the exception rolls it back, which for a validation trigger is equivalent, and it avoids
re-deriving `tstzrange(starts_at, ends_at, '[)')` in a second place where it could drift from the
column's own definition.

The general lesson: **a guard that can fail open needs a test that tries to defeat it**, not a test
that exercises the happy path and finds nothing wrong.

### 3.4 One endpoint, two audiences, one field apart — FR-204 and FR-205

`getAvailability` returns `kind` (`BOOKING` or `BLACKOUT`) to the owner and omits it for everybody
else. A renter is told a period is taken; the owner is additionally told which kind it is, because
one of them is theirs to change and the other is not.

A renter must not learn the difference: "blocked by the owner" versus "booked by somebody else" is
a fact about the owner's business and about another renter's arrangements, and neither is theirs.

The client mirrors this **structurally**, not by being told. `AvailabilityCalendar` decides whether
to distinguish the two kinds by checking whether `kind` arrived at all — so it is incapable of
displaying a distinction that never reached the browser. There is no `isOwner` prop to get wrong.

### 3.5 The editable list is a second endpoint, deliberately

The calendar comes from the public `/availability`; the owner's editable list comes from
`/blackouts`. Two requests where one would do, on purpose: an **id** is a handle for deleting a
row, and a **reason** is the owner's private note. Folding either into a world-readable response to
save a round trip would publish both to every visitor.

### 3.6 The notice period is resolved by the server, never by the client

FR-203 is `notice_period_hours` on the listing. The availability response carries both the raw
number and `bookableFrom` — the rule already applied to an instant.

A client computing `now + noticePeriodHours` would be a second copy of the rule, and it would drift
from the booking endpoint's refusal the moment the definition changed. `earliestBookableFrom` is
exported from the service and used by the availability response, the booking refusal and the browse
filter, so a listing page and a rejection cannot disagree by an hour. A test asserts exactly that:
*"advertises the same instant it enforces"*.

The value lives on `listings` rather than in its own table because it is a property of the item —
"I need a day's notice to fetch it from storage" is the same kind of fact as "the minimum rental is
two days", which was already there.

### 3.7 FR-303 is a `NOT EXISTS`, not a join

Filtering browse by a free date range against two tables invites a join. A join multiplies a
listing by its bookings, so it needs a `DISTINCT` — and a `DISTINCT` breaks the `count(*) OVER ()`
that FR-307 relies on to keep `total` and the page **structurally** inseparable rather than merely
consistent by discipline.

`NOT EXISTS` also reads as the rule itself: return listings for which no confirmed booking and no
blackout overlaps the window. The notice period is a third condition in the same clause, so the
filter answers "can I actually book this" rather than only "is it free".

**Both dates or neither** — the server refuses a half-open range with a 400, and the client
therefore sends nothing until both are filled. A half-completed form should show unfiltered results,
not an error.

### 3.8 `[)` bounds, everywhere, including the browser

`availability_blocks.period` uses the same `tstzrange(starts_at, ends_at, '[)')` as
`bookings.period`. The two are compared constantly, and two different notions of "overlap" in one
product is a bug waiting for a boundary case.

The calendar applies the same rule when deciding whether a day is taken, which is why
`lib/dates.js` has an explicit `endOfDay` returning the *next* midnight. Get it wrong and one extra
day is painted as unavailable — invisible until somebody loses a booking to it. The client test
pins this by asserting the day *after* a period's end is still bookable, with a fixture built from
**local** midnights so the assertion is about the bounds and not about the reader's timezone.

## 4. Schema

Migration `007_create_availability.sql`: `availability_blocks`, its no-overlap `EXCLUDE`,
`listings.notice_period_hours`, and the FR-206 trigger. Column notes: [3.db.md](../3.db.md).

## 5. What this does NOT do

- **No recurring blackouts.** "Every weekend" has to be entered as separate blocks. Recurrence
  rules are a surprising amount of machinery (and a second, harder overlap question) for something
  nobody has asked for.
- **No blackout editing.** Remove and re-add. An edit would need the same two overlap checks as a
  create, against the merged row rather than the patch — worth building the first time somebody
  wants to shift a block by a day, not before.
- **The notice period is offered as five choices, not a free number.** The column accepts any value
  up to a year and the API will store it; the owner's dropdown offers none / 2h / 12h / 1 day /
  3 days, because "how many hours of notice do you need" is a question almost nobody has a precise
  answer to.
- **The calendar does not select a booking range.** It shows availability and takes a click; the
  booking form still has its own two `datetime-local` fields, because this product rents by the
  hour and a day-granularity calendar cannot express a six-hour rental.
- **Nothing sweeps a blackout once it is past.** They accumulate. Harmless, and the calendar will
  not page backwards into them.

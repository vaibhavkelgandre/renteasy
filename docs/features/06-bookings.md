# 06 — Bookings, the double-booking guard and the state machine

**FR-500 to FR-514**, plus FR-400–407 (the [quote engine](../7.functional-requirements.md), built
first). Status: **complete** — API, client screens, 31 integration tests and 26 unit tests for
pricing.

The step the README calls one of the four things this product lives or dies on.

---

## 1. The shape

```
POST /bookings                 verified renter  → 201, REQUESTED
GET  /bookings?side=renter     your rentals
GET  /bookings?side=owner      bookings on your listings
GET  /bookings/:id             + the full append-only trail
POST /bookings/:id/actions     { action, comment? }
```

**One endpoint for every transition**, not `/accept`, `/decline`, `/cancel`. The state machine
already decides what is legal and for whom; a route per action would duplicate that decision in the
routing table, and the two would drift the first time an action's rules changed. A new action now
needs no new route and — because the validator's enum is derived from the machine — no new
validation either.

## 2. Nothing is booked until it is priced

The quote engine came first because a booking has to **freeze the agreed price into itself**. That
is the only way FR-112 can hold: "changing the rate card never alters an already-confirmed booking"
cannot be enforced by refusing the owner's edit, because FR-108 explicitly permits it.

So a booking stores `rent_paise`, `tax_paise`, `deposit_paise`, `commission_paise`,
`renter_total_paise`, `owner_payout_paise` and the itemised `quote_lines` — computed at request
time from the listing as it was then. A later edit has nothing to reach. There is a test that
changes the daily rate from ₹800 to ₹5,000 after a request and asserts the booking is untouched.

## 3. The decisions that carry weight

### 3.1 No double booking is a database constraint, never an application check

```sql
EXCLUDE USING gist (listing_id WITH =, period WITH &&)
  WHERE (status IN ('ACCEPTED', 'ACTIVE'))
```

**This is the whole reason step 6 exists in the shape it does.** An application check reads "is
there an overlapping booking?" and then inserts. Two requests arriving in the same millisecond both
read *no* and both insert, and the camera is promised to two people. No amount of care in the
service closes that gap — it is between the read and the write. Serialising it in the application
means a lock, which means remembering to take the lock on every future path that writes a booking.

An `EXCLUDE` constraint moves the question into the one place that can answer it atomically.

**Verified, not asserted.** A test fires twenty concurrent accepts of overlapping requests and
asserts exactly **1 accepted, 19 refused**, then re-counts in SQL. FR-514 is not something this
application achieves; it is something it cannot prevent.

`btree_gist` is required so one constraint can mix `=` on a uuid with `&&` on a range — GiST alone
has no operator class for uuid equality.

### 3.2 What holds dates, and what does not

The constraint is **partial**, and the status list is the product decision:

| Status | Holds dates? | Why |
|---|---|---|
| `REQUESTED` | **no** | Several people may ask for one weekend; the owner picks. Blocking here would make the fastest requester win rather than the owner choosing |
| `ACCEPTED` | **yes** | The owner has committed |
| `ACTIVE` | **yes** | The renter physically has the item |
| `RETURNED` | no | The item is back, even if the booking is not closed |
| `COMPLETED` / `DECLINED` / `CANCELLED` / `EXPIRED` | no | Nothing is held |

**Range bounds are `[)`** — inclusive start, exclusive end. A booking ending at 10:00 and one
starting at 10:00 do not overlap, which is exactly what handover means. With `[]`, every
back-to-back rental in the product would be refused as a clash. There is a test.

**`period` is a stored generated column**, derived from `starts_at`/`ends_at` rather than
maintained. A trigger or application code writing it would eventually let them drift, and the drift
would surface as a booking that overlaps another while the constraint says otherwise.

### 3.3 The service pre-checks for a message, never for correctness

`findOverlappingBooking` runs before an accept. It does **not** prevent a double booking — the
constraint does. It exists so the ordinary, uncontended case gets *"you have already accepted
another booking that overlaps these dates"* instead of a database error code.

The `23P01` handler catches the contended case and returns **the same 409**, so the two paths are
indistinguishable from outside. That is the point: correctness does not depend on which one caught
it.

Deleting the pre-check would cost a good error message. Relying on it instead of the constraint
would cost a double booking.

### 3.4 You cannot book your own listing — FR-502

**403, not 404.** The caller demonstrably knows the listing exists, because they wrote it.

Checked **before the overlap check**, deliberately: an owner probing their own listing should learn
nothing about who else has booked it from the shape of the refusal. There is a test asserting the
message says nothing about other bookings.

### 3.5 Owner cancellation is a separate action

`CANCEL` (renter) and `CANCEL_AS_OWNER` (owner) both lead to `CANCELLED`, and they are two actions
rather than one with a different actor.

FR-510 says an owner cancellation "counts against their reliability". Two actions mean the trail
records **which** happened without anyone inferring it from an actor id later, and a reliability
score becomes a row count rather than a join.

`CANCEL_AS_OWNER` is not legal from `REQUESTED`: refusing a request is `DECLINE`, which costs an
owner nothing. Only breaking a promise counts.

### 3.6 The trail is append-only by trigger

A trigger on `booking_events` refuses `UPDATE` and `DELETE` outright.

**A convention would be worth nothing.** The one time somebody fixes a typo in a comment with an
UPDATE, the trail stops being evidence of anything. A trigger makes it a property of the table, so
the guarantee survives code nobody has written yet. There is a test that attempts both directly in
SQL and expects them to throw.

`actor_id` is nullable because an expiry has **no actor**. Recording the owner as having expired a
request they never saw would put a false action in a trail whose entire value is that everything in
it happened.

### 3.7 Three ways to refuse, and they are different answers

| Situation | Answer |
|---|---|
| Not party to this booking | **404** — a private arrangement; a 403 would confirm it exists |
| Party, but the wrong one of the two | **403** — you legitimately know it exists, you just cannot do that |
| Right party, wrong state | **409** — nothing malformed, nobody forbidden; the state does not allow it |

The actor is checked **before** the state, so a stranger never learns that a booking they have
nothing to do with is "already cancelled".

**A listing that has ever been booked cannot be deleted.** Stricter than FR-110's wording, which
implies one with only old completed bookings could go. It cannot: a completed booking is the other
party's record of what they rented and paid. `ON DELETE RESTRICT` enforces it and the service turns
the refusal into a 409 naming the remedy — unpublish.

> **That refusal raises `23001`, not `23503`.** `ON DELETE RESTRICT` raises `restrict_violation`
> immediately; the default `NO ACTION` defers to constraint-check time and raises
> `foreign_key_violation`. Catching only the familiar 23503 — which this did first — let a RESTRICT
> sail past into a 500.

### 3.8 FR-508 is a timer, and it lives outside the app

A request nobody answers expires after 48 hours. Nothing in a request handler can make that happen
— the whole condition is that no request arrived — so `scheduler.js` runs `sweepExpiredRequests`
hourly. Hourly against a 48-hour window: an hour of lateness is a rounding error nobody can see.

**Started from `server.js`, never `app.js`.** That is the load-bearing part. The integration tests
import `app.js` and never bind a port; a timer started there would run during every test file, in
parallel, expiring fixtures other tests are asserting against — and the failures would look like
concurrency bugs in this code rather than like a stray timer.

The sweep **reuses `actOnBooking`** rather than issuing a bulk UPDATE, so an expiry passes through
the same state machine and writes the same kind of event as every other transition. It records **no
actor**: writing down the owner as having expired a request they never saw would put a false action
in an append-only trail, and the trail's whole value is that everything in it happened.

`runSweeps` never rejects, and there is a test asserting exactly that rather than asserting the
schedule keeps ticking — the first version of that test did the latter and passed with the error
handling removed, because `setInterval` does not care whether its callback rejected. What actually
breaks without it is the process, on an unhandled rejection.

**One instance is assumed.** Two would both sweep; the state machine refuses the loser, so nothing
is corrupted — it just reports real work as `failed`. A second instance needs an advisory lock
first.

## 4. Schema

Migration `006_create_bookings.sql`: `bookings`, `booking_events`, the exclusion constraint, and
the append-only trigger. Column notes: [3.db.md](../3.db.md).

## 5. What this does NOT do

- **No refund policy** (FR-509's second half) — needs payments, step 10.
- **No reliability score** (FR-510's second half) — the data to compute it is recorded; nothing
  computes it.
- **The handover transitions are declared but not exposed.** `START`, `RETURN` and `COMPLETE` are in
  the state machine because it is meant to be the whole truth about what a booking can do — leaving
  them out would make a partial map read like a complete one — but no endpoint reaches them. Step 8.
- **No notifications.** Neither party is told anything; both must look.

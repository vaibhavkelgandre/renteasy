# 08 — Handover, return and completion

**FR-700 to FR-704 and FR-708.** Status: **complete for this pass** — API, client, 22 integration
tests. FR-705 to FR-707 (late fees, damage claims, deposit release) are a deliberate second pass.

Step 7 (negotiation) was **skipped by decision**, not blocked.

---

## 1. The shape

```
ACCEPTED    --START (owner)------------>  HANDED_OVER
HANDED_OVER --CONFIRM_RECEIPT (renter)->  ACTIVE
ACTIVE      --RETURN (renter)---------->  RETURNED
RETURNED    --COMPLETE (owner)-------->   COMPLETED
```

No new route. `POST /bookings/:id/actions` already takes every action and its validator derives the
enum from the state machine, so four new transitions arrived with no routing change at all — the
payoff of the one-endpoint decision made at step 6.

## 2. The receiving party confirms, at both ends

Read literally, **FR-700 says the owner's action makes a booking `ACTIVE`** — which leaves FR-701's
"renter confirms receipt" doing nothing whatsoever. The return side already worked the other way
round: the renter asserts (FR-703) and the *owner's* confirmation completes it (FR-704).

So handover mirrors it. In both halves the party **receiving** the item is the one whose
confirmation advances the state, and the party handing it over can only assert. `HANDED_OVER` and
`RETURNED` are the same shape reflected: claimed by one side, awaiting the other.

That is what makes "you have my camera" a fact both people asserted rather than one person's claim,
which is the entire value of the record when it later goes wrong.

**FR-703 was declared wrong and is corrected here.** The state machine had `RETURN` as
`actors: ["owner"]`, contradicting the requirement — and collapsing the two-sided record, since the
owner would then both declare the return and confirm it.

**`RETURN` is legal from `HANDED_OVER` as well as `ACTIVE`.** A renter who never got round to
confirming receipt but has now handed the thing back must not be stuck, and returning it is a
stronger admission of having had it than confirming receipt would have been.

## 3. Adding a state to a partial-constraint design — where the real bugs were

This is the part worth reading before touching anything similar.

The double-booking guard (migration 006) is a **partial** exclusion constraint: `WHERE status IN
(...)`. A status it does not name holds no dates *at all*. Five places in the codebase listed which
statuses hold dates, and after `HANDED_OVER` existed, **four of them were still wrong**:

| Where | What it would have done |
|---|---|
| the exclusion constraint | let a second booking be accepted for an item already out |
| `findOverlappingBooking` | let the request through, so the clash surfaced late or not at all |
| `findUnavailablePeriods` | **hidden a handed-over item from its own availability calendar** |
| the browse date filter | **offered a handed-over item in "free between these dates"** |
| the FR-206 blackout trigger | **let an owner black out dates over a live handover** |

The three in bold are silent wrong answers. Nothing errors; the product simply tells people
something untrue.

The fix is `DATES_HELD_STATUSES` in `bookingStateMachine.js`, passed **into** each query as a
parameter rather than written out in it. Two copies cannot be removed — a constraint and a trigger
cannot read application code — so those are pinned by a test that reads the constraint back out of
`pg_constraint` and compares it against the array.

**`RETURNED` is deliberately absent from the list.** The item is back on the shelf; holding its
original dates would refuse a real rental for something sitting in the owner's hallway. An early
return genuinely frees the remaining days.

## 4. Condition photos are optional, private and append-only

**Optional**, on a direct decision. Required photos would block a handover happening in a car park
with one bar of signal, and a handover that cannot be recorded is worse than one recorded without
pictures. The UI states plainly when a phase has none — "No photos were taken" is itself the
argument for taking some next time.

**Either party, at either phase**, which is adversarial by design: a scratch is worth photographing
by whichever side thinks it helps them, and a record only one party can contribute to is not a
record.

**Private storage, not the listing pipeline.** A listing photo is `type: "upload"` — world-readable
forever, correct for a shop window. These are taken wherever an item changes hands, so they show
doorways, number plates, the inside of somebody's home. They upload as `type: "authenticated"`,
proven against the real provider: the public URL form of such an asset answers **404** while a
signed one answers **200**.

**The signed URL never reaches the browser.** `GET /bookings/:id/photos/:photoId/file` streams the
bytes through this API rather than redirecting, because a signed URL is a bearer credential for the
five minutes it lives — a redirect would put it in the address bar, the history and any referrer
that follows. The client gets a path it must be authorised for on every single request.

**Append-only by trigger**, like `booking_events`. Evidence either party can delete after the fact
is not evidence, and the tempting exception — "let them remove one added by mistake" — is exactly
the hole, because *by mistake* is indistinguishable from *because it showed the scratch*. The
remedy for a bad photo is another photo with a note.

## 5. FR-708 is a timeout, and it records no actor

Neither party can force the other's hand, so time does it: 48 hours each way, both joining the
existing `SWEEPS` list in `scheduler.js` rather than starting a second timer.

Without them, a renter who never confirms receipt leaves a booking holding its dates forever, and
an owner who never inspects a return leaves the renter's booking — and eventually their deposit —
open indefinitely.

**No actor is recorded**, exactly as for the FR-508 expiry sweep. Writing down the renter as having
confirmed receipt of something they never acknowledged would put a false statement in an
append-only trail whose entire value is that everything in it happened. The event says the system
did it, on the strength of the other side's assertion going unchallenged for two days.

## 6. Schema

Migration `008_handover_and_return.sql`: the `HANDED_OVER` status, the widened exclusion
constraint, the partial index the sweeps use, `booking_photos` and its append-only trigger, and a
`CREATE OR REPLACE` of migration 007's FR-206 trigger function. Column notes:
[3.db.md](../3.db.md).

## 7. What this does NOT do

- **No late-return flagging or late fee** (FR-705) — second pass.
- **No damage claim** (FR-706) — second pass, and the thing that would give "the renter never
  returned it" a real resolution rather than a notification.
- **Nothing releases a deposit** (FR-707). Unreachable until payments exist at step 10; today the
  deposit is a number on a booking that nobody has collected.
- **Nothing chases a renter who simply never returns the item.** The booking sits in `ACTIVE`. An
  overdue *notification* sweep would be the honest first step, and is not built.
- **No trust tiers yet** (FR-035–038: phone OTP, ID verification). Agreed as the next piece of work
  — the private-media path this step built is the prerequisite it was waiting on.

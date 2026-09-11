# 09 — In-app notifications

**FR-985, FR-986, FR-987**, plus the in-app half of FR-980/981/984. Status: **complete for this
pass** — events, API, bell, page, 13 integration and 10 component tests.

Email is deliberately a **separate channel**, not built. The event hooks are the same either way.

---

## 1. Every notification is one sentence

*A transition happened — tell the other party.*

`actOnBooking` is the single funnel every booking state change passes through, so **one hook there
covers eight of the nine events**; `requestBooking` covers the ninth, because a request is the one
event where the booking did not exist a moment earlier.

The alternative — a `notify()` call beside each transition — puts the same decision in nine places
and lets the tenth quietly tell nobody.

| Action | Who hears |
|---|---|
| *(request created)* | owner |
| `ACCEPT` / `DECLINE` | renter |
| `CANCEL` | owner |
| `CANCEL_AS_OWNER` | renter |
| `EXPIRE` | **renter** |
| `START` | renter — "confirm you have it" |
| `CONFIRM_RECEIPT` | owner |
| `RETURN` | owner — "confirm the condition" |
| `COMPLETE` | renter |

**`EXPIRE` goes to the renter, not the owner.** The owner is the one who let it lapse, and telling
somebody their own inaction expired something reads as a reprimand from a system that could simply
have reminded them. The renter is the one left waiting on an answer that is now never coming.

## 2. The map is the point

`BOOKING_NOTIFICATIONS` is keyed by action and lives beside the state machine. A test asserts its
keys **equal** the state machine's, so adding a transition without deciding who hears about it is a
failing test rather than silence.

That test's first version excluded `system`-only actions, on the reasonable-sounding assumption
that nobody needs telling about an automatic change. **`EXPIRE` is the counterexample** — it is
precisely the transition where a notification earns its place — which is why it now covers every
action without exception.

## 3. Never notify the actor of their own action

This is the bug this kind of feature always ships with: "your booking was accepted" arriving for
the person who just pressed Accept.

The guard is in the service, not at the call sites. The recipient is resolved from a **role**
(`owner` / `renter`) against the booking, then compared against the actor — so there is no call
site that could get it wrong. A `system` actor (the sweeps) has no id, so both parties stay
notifiable and the map decides alone; that is correct, because nobody acted.

## 4. FR-985 is the requirement, not defensiveness

*"A notification failure never fails the action that triggered it."*

Every write goes through one `notify()` that catches, logs and returns a boolean. A bell that
misses a row is a nuisance; an accept that answers 500 because of one is a bug in the wrong feature
entirely.

**The test proves it literally** rather than by mocking: it breaks the `notifications` table with a
constraint that rejects every type, then accepts a booking and asserts it worked. A mock would only
prove the code calls a function that was told to fail.

> `ADD CONSTRAINT ... NOT VALID` is what makes that possible. Rows already exist by the time the
> test runs, so a plain `ADD CONSTRAINT` is refused for violating itself before the test can start.
> `NOT VALID` skips existing rows and applies to new ones — exactly the situation being simulated.

## 5. FR-987 applies to in-app, not only to email

No figure and no address in any message, pinned by a test that runs every one of them through a
regex. These are read in a list on a phone, in public: *"₹80,000 camera, Kothrud"* on a lock screen
is an advertisement for a burglary. The price is one tap away, behind a session.

## 6. The count is its own endpoint

`GET /notifications/unread-count` returns one integer and nothing else. The header polls it every
60 seconds for every signed-in user for as long as a tab is open — it is the most frequently
executed query in the product — and deriving it from `GET /notifications` would mean fetching rows
to call `.length` on them. Served by a **partial** index (`WHERE read_at IS NULL`), which stays
small permanently while a full index would grow with every notification ever sent.

**Polled, not pushed.** There is no websocket in this product, and adding one for a number that
changes a few times a day would be a second transport to operate, secure and reconnect.

The bell fetches the **list** only when opened. Nobody reads a list they have not asked to see.

## 7. Schema

Migration `009_create_notifications.sql`. Column notes: [3.db.md](../3.db.md).

## 8. What this does NOT do

- **No email.** FR-980/981/984's email half is a second channel that can reuse these hooks.
- **No reminders** (FR-983). Would join the existing `SWEEPS` list, and needs a rule for not
  re-sending the same reminder daily — which is the actual design work, not the sweep.
- **Nothing about listings yet.** Every event today is booking-shaped, because every listing event
  is something the owner did themselves and does not need telling about. A listing notification
  becomes real with reviews (step 9) or moderation.
- **No grouping.** Twenty requests on one listing is twenty rows. Worth revisiting if anybody's
  bell ever gets noisy; premature before that.
- **No preferences.** Everybody gets everything. There is nothing here frequent enough to need
  muting yet, and a preferences table nobody uses is a table to maintain.

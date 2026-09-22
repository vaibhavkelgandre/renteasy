# 10 — Messaging between the two parties

Status: **complete for this pass** — 20 integration and 11 component tests, an inbox
at `/messages`, a thread page, attachments, contact sharing and reports.

Chat opens when a booking is **requested**, never before. That was a direct product
decision and it removed most of the design.

---

## 1. The booking is the conversation

There is no `conversations` table, and that is the design rather than a shortcut.

One thread per booking, for its two parties, for its whole life — so a conversations
table would be **1:1 with `bookings`**, holding no fact that `bookings` does not
already have: the listing, the renter, the owner, when it started. Messages reference
`booking_id` directly.

**The authorization came free with that.** `loadBookingForParty` already answers "is
this caller one of the two parties, 404 otherwise" for every booking endpoint, so
messaging added **no new permission rule** — which is the part of a chat feature that
usually goes wrong.

> It did force one refactor. `loadBookingForParty` was private to `bookingService`,
> and `messageService` needing it while `bookingService` needs `postSystemMessage`
> back is a circular import. The tempting fix — four duplicated lines — would have
> given this application **two opinions about who may read a booking**. Extracted to
> `bookingAccess.js` instead.

## 2. The thread closes with the booking — the safety rule

Opening chat at request rather than at accept is what makes the feature useful: the
questions that *decide* whether to accept ("does it come with a charger?") all happen
before anyone has agreed to anything.

But it means anybody can open a channel to any lister by pressing one button. So
writability follows the booking:

| State | Chat |
|---|---|
| `REQUESTED` → `RETURNED` | **writable** |
| `DECLINED`, `CANCELLED`, `EXPIRED` | **read-only** — no relationship exists |
| `COMPLETED` | writable for **14 days**, then read-only |

Without the middle row, *request an item → get declined → keep messaging forever* is
a harassment vector with a one-button entry price. There is a test for exactly that.

**Reading is never restricted.** The conversation stays visible to both parties
permanently — half the reason to keep it on the platform is that it is evidence.

The grace window is measured from the booking's **`ends_at`**, not from when the
owner got round to marking it complete. Otherwise an owner confirming three weeks
late would silently extend the channel by three weeks.

`canMessage` lives beside the state machine so it cannot drift from it, and a test
walks every status.

## 3. Append-only, which is why read state is a separate table

`booking_messages` is append-only by trigger, like `booking_events` and
`booking_photos`. A thread either party can edit after the fact is not evidence.

The obvious design puts `read_at` on the message and updates it — **which means the
table cannot be append-only**, and the trigger would have to allow `UPDATE` and then
police which columns changed.

A per-party watermark (`booking_message_reads`) avoids the exception entirely: two
rows per booking at most, updated in place, messages immutable. Unread is then "not
mine, and newer than my watermark", with `COALESCE(..., 'epoch')` so a thread never
opened counts everything rather than nothing.

## 4. One ring per burst

A chat is bursty — four lines in twenty seconds. Four notifications turns the bell
into something people learn to ignore, **and it stops working for the booking
notifications too**, which are the ones that need answering.

So a message rings only if the recipient has nothing unread in that thread already.
Reading it resets the counter.

> The check is `> 1`, not `> 0`, because it runs *after* the insert — the message
> that triggered it is already counted. One means "this is the only thing waiting".
>
> The first version of this called a `hasUnreadInThread` helper returning a
> **boolean** and compared it `> 1`, which is always false — the dedupe would never
> have fired and every message would have rung. Caught by reading the code back, not
> by a test, and the helper was deleted rather than left as a second way to ask.

FR-987 applies here too: the notification names the sender and the item, **never the
message body**. A chat line can contain anything and this is read on a lock screen.

## 5. Attachments reuse the private pipeline

Same `uploadPrivateAsset` as condition photos, scoped to the booking. A photo sent in
a chat is exactly as sensitive as one taken at handover — the inside of a home, a
number plate, a document.

The client gets `hasAttachment: true` and a **path on this server**. The storage id
never leaves the service and the signed URL never reaches the browser; the proxy
re-checks who is asking on every fetch. There is a test asserting no provider host
appears in the response.

## 6. Contact sharing is a message, not a field

Explicitly replacing the automatic reveal-on-accept this product first considered.
As a message it is consensual, **one-directional until reciprocated**, and — since
the thread is append-only — permanently recorded as having happened.

The number is copied into the body rather than referenced, so the thread says what
was shared at the time even if the account's number changes later.

## 7. Its own surface, not a panel on the booking

Messaging first shipped as a card on the booking page, and that page then carried
**five things at once**: the booking's details, its actions, its condition photos, a
live conversation and an audit trail. Two of those you act on, three you read, and
they competed.

- **`/messages`** — the inbox: every thread, newest activity first.
- **`/messages/:bookingId`** — one conversation, full width.
- The booking page keeps a card that links to the thread, nothing more.

**Keyed on the booking id, not a conversation id**, because there is no second
identifier to invent — the booking *is* the conversation (§1).

An inbox is also the shape the feature wanted: a conversation is easier to find by
"who was I talking to" than by remembering which booking it hung off. It is the
first consumer of the `byBooking` counts the unread endpoint already returned.

**The inbox lists only threads that have messages.** One listing every booking you
ever made, most of them empty, is a list people stop reading. A conversation starts
from the booking page, which always offers it.

**Two things are resolved server-side that the client would otherwise re-derive:**
the *other* party's name (which of the two people the caller is decides whose name
to show) and `my_role`. Without the second, somebody who both lends and rents cannot
tell their two conversations apart.

`MessageThread` did not change when it moved. It was already self-contained —
fetching and polling its own data — so the new page only supplies a frame.

## 8. Pushed, with polling kept as the fallback

**This section used to argue the opposite, and the argument was right at the time.** It
read: *"There is no WebSocket in this product. Adding one means a second transport to
operate, secure and reconnect — and a pub/sub backplane the moment a second instance
exists. Messages here are minutes apart, not seconds."*

Every clause of that still holds as a **cost**; what changed is that the cost was paid
deliberately, for the three features it unlocks rather than for the latency. Typing
indicators, presence and read receipts all need a connection as the signal, and this
document's own §10 listed all three as "not built — they need the transport §8 argues
against". See **[12 — Realtime](12-realtime.md)** for the transport itself.

What the thread does now:

| | |
|---|---|
| On mount | one HTTP load, so the conversation renders without waiting on a handshake |
| `thread:join` | authorizes, replays via `since`, subscribes, reports the other party |
| `message:new` | pushed to everyone reading the thread |
| Not connected | the 3-second poll, exactly as before |

**The prediction in the old text turned out to be accurate: the API did not change.**
`?since=` is what `thread:join` sends on a reconnect, and `findMessages` is the same
query the poll used. The transport moved; the question did not.

**Everything merges by message id**, which is what lets those three sources overlap —
and they overlap constantly: the sender receives their own broadcast as well as its
acknowledgement, a poll and a push can carry the same row, and `since` is inclusive at
its boundary (see [troubleshooting](../troubleshooting.md)). At-least-once with a
dedupe by id is the contract; exactly-once is not, and never was.

**Sending text goes over the socket, attachments stay on HTTP** — and neither is a
copy of the other, because both call `messageService.sendMessage`. That function is
where "who may write to this thread" is decided, so the two transports cannot drift
into disagreeing about it. Multipart keeps the magic-byte sniffing and the size limit;
a file has no business being reassembled out of socket frames.

## 9. Schema

Migration `010_create_booking_messages.sql`: `booking_messages`,
`booking_message_reads`, `booking_message_reports`, and `BOOKING_MESSAGE` added to
the notification type list.

> That list was **read out of the database**, not copied from migration 009. There is
> no `ADD VALUE` for a CHECK constraint, so every migration adding a type must
> re-state the whole list, and copying an older ancestor silently deletes everything
> added in between — a failure that is invisible, because `notify()` swallows its own
> errors by design.

## 10. What this does NOT do

- **No enquiry-stage chat.** You cannot message an owner without requesting their
  item. Deliberate: it is the entire spam control.
- **⚠️ Nothing reads the reports.** There is no admin surface, so a report lands in
  `booking_message_reports` and waits for someone with database access. Built anyway
  — the alternative on a channel between strangers carrying photographs is no report
  button at all, and a durable row loses nothing when a review screen is eventually
  built.
- **No block.** Closing the thread with the booking covers the case a block would.
- **No editing or deleting a message**, by design — see §3.
- ~~**No typing indicators, presence or read receipts.** All three need the transport
  §8 argues against.~~ **All three are built** — see [12 — Realtime](12-realtime.md).
  Left struck through rather than deleted, because *"they need the transport §8 argues
  against"* is why §8 was reconsidered at all: these were the features that justified
  it, and the latency never was.
- **No search across conversations**, and no archiving. Both are inbox features that
  earn their place at a volume this product does not have.
- **No off-platform-payment warning.** It would warn about leaving a payment system
  that does not exist yet. Worth adding when payments land — chat is where
  disintermediation happens.

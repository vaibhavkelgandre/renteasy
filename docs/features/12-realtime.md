# 12 — Realtime: the socket transport

Status: **built** — 36 server tests, 13 client tests. Messages, typing indicators,
presence, read receipts and the notification bell all push; both polls survive as
fallbacks.

This reverses a decision recorded twice — in [10 — Messaging](10-messaging.md) §8 and
[09 — Notifications](09-notifications.md) §6 — and the reversal is the most useful
thing in this document, so it comes first.

---

## 1. Why the original argument was right, and what changed

The old text: *"Adding one means a second transport to operate, secure and reconnect —
and a pub/sub backplane the moment a second instance exists. Messages here are minutes
apart, not seconds."*

Every clause of that is still true, and none of it was wrong. **What was wrong was
using latency as the justification either way.** For messages that are minutes apart,
1.5 seconds of average lag is invisible; a socket buys nothing there and nobody would
notice if it were removed.

What it buys is the three features §10 of the messaging doc listed as unbuilt
*because* they need a connection as the signal:

- **Typing indicators** — you cannot poll "is somebody mid-sentence".
- **Presence** — absence of a poll and a slow poll look identical.
- **Read receipts** — a receipt is a claim about a person, and polling made it a claim
  about a request. See §7: the poll marked threads read in background tabs.

And one cost reduction that turned out to be the largest single win, and was not the
reason this started: **the notification bell**. It polled every 60 seconds for every
signed-in user on every page, whether or not they were reading anything.

**The honest crossover, for the next person weighing this:** at 200 concurrent open
threads, 3-second polling is ~67 requests/second of mostly-empty responses, which is
fine. At 20,000 it is not. This product is nowhere near either number — so the
transport is here for the features, and the load saving is a side effect.

## 2. Where it attaches, and why that was the hard part

`app.js` builds the Express app and **never calls `listen()`** — the decision that
lets Supertest drive it in-process without binding a port. Socket.IO needs an
`http.Server`, and the only one in the project is created in `server.js`.

So the socket layer copies that split exactly:

```
app.js              what the HTTP application IS        → driven by supertest
server.js           being a running process             → binds the port
ws/socketServer.js  what the SOCKET LAYER IS            → driven by test clients
```

`createSocketServer(httpServer)` is a factory; nothing runs at import. `server.js`
calls it for the real process, and the integration tests call it against their own
throwaway server on port 0.

**Attached synchronously, immediately after `app.listen()` — outside the callback.**
`listen` binds and returns synchronously while its callback runs later, so a handshake
arriving in that window would reach Express, find no route, and be answered with a 404
the client reads as "realtime is not available here". The boot banner still prints
from inside the callback, which is why the attach logs nothing.

## 3. The path is `/api/socket.io`, not `/socket.io`

Nginx routes to this service by the `/api` prefix and Vite proxies the same prefix, so
putting the handshake inside it means realtime needed **no new proxy rule in either
place**. A default-path socket works locally and then 404s in production against a
proxy nobody told about it.

Socket.IO claims the path on the shared server before Express sees the request, so it
cannot collide with a route — but nothing may ever mount `/api/socket.io` in `app.js`.

**Vite needs `ws: true` on that proxy rule.** Without it the handshake is forwarded but
the `Upgrade` request is not, so Socket.IO connects over HTTP long-polling and stays
there permanently: messaging works, nothing errors, and the thing you built is not
running. Nginx needs `proxy_set_header Upgrade` for the same reason.

## 4. Authentication, and the two things a socket changes

The handshake reads the session from the httpOnly cookie, verifies the JWT, and reads
the user from the database — the same three steps as `requireAuth`. Every failure is
the same refusal, collapsing "no cookie", "expired", "tampered", "deleted" and
"suspended" into one answer, for the reason `verifyAuthToken` returns null for all of
them.

**A browser cannot set headers on a WebSocket**, which is why authenticating from a
cookie is not a convenience here — it is the only option that does not put a token in
a query string, where proxies and access logs keep it.

**WebSockets are not subject to CORS.** There is no preflight, and
`Access-Control-Allow-Origin` means nothing to a handshake — so any page on the
internet can open a socket to this server and the browser will attach the session
cookie. Cross-Site WebSocket Hijacking, in one line of somebody else's JavaScript.
`SameSite=Strict` already blocks it, but coupling the only defence to a cookie
attribute somebody might one day relax to `none` is not a defence, so the handshake
also checks `Origin` against `APP_URL` (`allowRequest`, which covers both transports —
a `cors.origin` setting would only govern the polling half).

**An absent `Origin` is allowed, and that is not the hole it looks like.** A browser
always sends it, including same-origin, and page JavaScript cannot forge or omit it —
so the attack always arrives with an origin present and wrong. A request with none is
a non-browser client: the tests, curl, a future server-to-server caller.

**Staleness is [NFR-5](../4.non-functional-requirements.md)'s hardest case** and takes
three mechanisms — handshake, per-event re-read, five-minute sweep. That NFR has the
full reasoning, including why `connectionStateRecovery` is switched off.

## 5. Rooms, and what is addressed to whom

| Room | Joined | Carries |
|---|---|---|
| `user:<id>` | automatically at connect | notifications, anything about the person |
| `booking:<id>` | on `thread:join`, **after authorization** | messages, typing, receipts, presence |

**A booking names exactly two people, so there is no room model to invent** — no
participant list, no membership table. `loadBookingForParty` already answered "is this
caller one of the two, 404 otherwise" for every booking endpoint, so the socket added
**no new permission rule**.

**One human is many sockets** — a phone, a laptop, three tabs — so anything addressed
to a *person* goes to their room, and presence counts people rather than connections.
Getting that wrong is the classic chat bug: it works in a single-tab dev browser and
breaks the moment a real user has two.

**The room is joined only after `listMessages` has authorized the caller.** Joining
first would deliver one message to a stranger before the refusal landed — and the
refusal would still have looked correct. There is a test for exactly that.

## 6. The event protocol

**Client → server**, all re-authorized per event:

| Event | Payload | Ack |
|---|---|---|
| `thread:join` | `{ bookingId, since? }` | thread, `canSend`, `otherParty` |
| `thread:leave` | `{ bookingId }` | — |
| `message:send` | `{ bookingId, body }` | `{ message }` |
| `thread:typing` | `{ bookingId, isTyping }` | — |
| `thread:read` | `{ bookingId }` | `{ bookingId, userId }` |

**Server → client:**

| Event | Room | Payload |
|---|---|---|
| `message:new` | `booking:<id>` | `{ bookingId, message }` |
| `thread:typing` | `booking:<id>` minus sender | `{ bookingId, userId, name, isTyping }` |
| `thread:read` | `booking:<id>` | `{ bookingId, userId, readAt }` |
| `presence:changed` | `booking:<id>` | `{ bookingId, userId, online, lastSeenAt? }` |
| `notification:new` | `user:<id>` | `{ notification }` |

Acknowledgements use `utils/response.js`'s two shapes, so the client's existing error
handling works unchanged. **One field differs — `status`** — because an ack has no
response line, and without it a socket reply would be strictly less informative than
the HTTP reply it mirrors: a client could not tell a 409 (thread closed) from a 404
(no such booking).

## 7. The three features, and what each one is easy to get wrong

**Typing** is pure transport: never persisted, never replayed, never acknowledged. A
typing state that survived a reload would show somebody composing a message they
finished ten minutes ago. It is also the one event that does **not** re-read the actor
— it grants nothing, and paying a query per keystroke to confirm the right to say
"typing" would make the cheapest event in the app the most expensive. Room membership
is its authorization.

Both sides have a timer. The sender stops announcing after 3 seconds idle; the
receiver expires an indicator after 5. **The receiver's timer is the load-bearing one**
— the sender's explicit "stopped" cannot arrive over a socket that closed mid-word, and
an indicator stuck on forever is worse than none, because it says somebody is about to
reply when nobody is there.

**Presence** is visible only between two parties to a booking — never on a listing,
never in search. Whether somebody is at their phone is a fact about them, and sharing a
rental is what earns the right to see it.

> **Known asymmetry, and it is the cheap end of a real trade.** "Online" means "has the
> app open somewhere" (a global answer), while `presence:changed` only fires when
> somebody *opens a conversation*. So if the other party connects and goes to their
> inbox instead, nobody watching the thread is told, and it keeps showing them as away
> until they open it or the page reloads. Closing it properly means notifying, on every
> connect, each room for each booking that person has — a query per connection to
> answer a question nobody asked — or redefining "online" as "in this room", which is
> then wrong for somebody plainly around and reading something else. The lag is
> one-directional and resolves the moment they look at the thread, which is also the
> moment it starts to matter.

**Read receipts** needed no schema change: `booking_message_reads` already holds a
per-party watermark. What changed is that **reading is no longer implied by fetching**.
While a message could only arrive by being asked for, `listMessages` moving the
watermark was exact — asking for the thread *was* opening it. A pushed message arrives
unasked, so the client now says explicitly when somebody looked, and **only while the
tab is visible**.

That last clause fixes an older bug rather than avoiding a new one: the 3-second poll
marked a thread read on every pass, so a conversation left open in a **background tab**
reported as read by somebody who was not there.

## 8. One instance assumed

Rooms and the connection registry are per process, so a second instance would deliver
to only the half of the connections it happens to hold. This is the same assumption
`scheduler.js` already writes down for its sweeps, and the same one
[NFR-9](../4.non-functional-requirements.md) writes down for its rate-limit store.

What a second instance needs:

- `@socket.io/redis-adapter`, so a publish on one node reaches a socket on another.
- **Sticky sessions at the proxy.** Socket.IO's long-polling fallback performs a
  multi-request handshake that must land on the same node — the classic *"works
  locally, 400s in production"* bug.
- Shared presence. `ws/connectionRegistry.js` is the file that changes; nothing outside
  it knows how the answer is stored.

## 9. Both polls survive, and that is not an oversight

The thread's 3 seconds and the bell's 60. They are no longer how anything keeps up, but
a socket can fail in ways an HTTP request cannot: a proxy that refuses to upgrade, a
captive portal, a corporate network that blocks it. Keeping them costs one `if` and
means realtime **degrades to what the app did before** rather than to a screen that
silently stops updating.

`lib/socket.js` is the only client module importing `socket.io-client`, which is also
what makes one test mock enough for the whole client suite.

## 10. What this does NOT do

- **No presence outside a thread.** The inbox does not show who is online; see §7.
- **No per-message receipts.** One indicator, against the newest thing you said — the
  only one anybody looks for.
- **No typing in the inbox**, for the same reason.
- **No delivery guarantee across a reconnect**, deliberately. Pub/sub is
  fire-and-forget; durability is Postgres, and a client catches up with `since`.
- **No rate limit on `message:send`** — it writes a row and sits under the same
  (absent) policy as the HTTP route beside it. [NFR-9](../4.non-functional-requirements.md)
  has the reasoning.
- **No SSE.** It was the right call while chat only needed push in one direction; once
  typing and receipts were in scope, the client had things to say too.

# 2. API documentation

**Standing rule: any endpoint change updates these files in the same commit.** An undocumented
endpoint cannot be reviewed or consumed.

Base path `/api`. Server runs on **5001** (not 5000 — see [troubleshooting.md](../troubleshooting.md)).

Auth column: **Public** · **Session** (signed in, verified or not) · **Verified** (session + confirmed
email) · **Admin**.

> **Split from a single file at 395 lines**, against this project's 400-line ceiling. The endpoint
> table below stays here because it is the thing most often looked at, and splitting it would mean
> opening three files to answer "what endpoints exist?".

| Area | Endpoints |
|---|---|
| [Authentication](auth.md) | register, verify, sign in, sessions, password reset |
| [Profile](profile.md) | your own account, and the public projection |
| [Listings](listings.md) | create, publish, photos, **browse**, quote and **availability** |
| Bookings and notifications | in the endpoint table below; notes in [features/](../features/) |

---

## Response envelope

```json
{ "success": true,  "message": "...", "data": { } }
{ "success": false, "message": "...", "errors": { "email": "Must be a valid email" } }
```

## Status codes, used deliberately

| Code | Used when |
|---|---|
| `200` | Read, or a successful mutation |
| `201` | A new record exists |
| **`202`** | **Accepted — we have taken the request and will act on it, without confirming what it created.** Registration and resend, so neither discloses whether an account exists |
| `400` | Input malformed |
| `401` | No session, expired, or tampered token |
| `403` | Signed in, action not permitted — includes **email not confirmed** |
| `404` | Absent, or the caller has no more reason to know it exists than a stranger |
| `409` | Valid request refused by current state — a stale terms version |
| **`410`** | **Gone — every single-use-token failure**, verification and password reset alike. Expired, used, unknown, malformed, or issued for a since-changed address: five causes, one answer |
| `429` | Rate limited |

**`202` and `410` are the two that carry design decisions**, not conventions. Both exist to give
several distinguishable situations one indistinguishable answer.

---

## Endpoints

| Method | Path | Auth | Body | Success | Errors |
|---|---|---|---|---|---|
| `GET` | `/health` | Public | — | `200` `{ status, version, uptimeSeconds, database }` | — |
| `GET` | `/auth/terms/current` | Public | — | `200` `{ version, url }` | — |
| `POST` | `/auth/register` | Public | `{ name, email, password, phone?, acceptedTermsVersion }` | **`202`**, `data: null` | `400`, `409`, `429` |
| `POST` | `/auth/verify` | Public | `{ token }` | `200` `{ alreadyVerified }` | `400`, **`410`**, `429` |
| `POST` | `/auth/verify/resend` | Session | — | **`202`**, `data: null` | `401` |
| `POST` | `/auth/login` | Public | `{ email, password }` | `200` `{ user }`, cookie set | `400`, `401`, `429` |
| `POST` | `/auth/logout` | Public | — | `200` | — |
| `GET` | `/auth/me` | Session | — | `200` `{ user }` | `401` |
| `POST` | `/auth/forgot-password` | Public | `{ email }` | **`202`**, `data: null` | `400`, `429` |
| `POST` | `/auth/reset-password` | Public | `{ token, password }` | `200`, `data: null` | `400`, **`410`**, `429` |
| `GET` | `/profile` | Session | — | `200` `{ user }` | `401`, `404` |
| `PATCH` | `/profile` | Session | `{ name?, phone? }` | `200` `{ user }` | `400`, `401` |
| `PATCH` | `/profile/email` | Session | `{ newEmail, currentPassword }` | **`202`**, `data: null` | `400`, `401` |
| `DELETE` | `/profile/email` | Session | — | `200` `{ user }` | `401`, `404` |
| `PATCH` | `/profile/password` | Session | `{ currentPassword, newPassword }` | `200`, `data: null` | `400`, `401` |
| `POST` | `/profile/deletion` | Session | `{ currentPassword }` | `200`, cookie cleared | `400`, `401` |
| `GET` | `/users/:id/public` | **Public** | — | `200` `{ profile }` | `404` |
| `GET` | `/listings` | **Public** | — (query) | `200` `{ listings, total, limit, offset }` | `400` |
| `GET` | `/listings/categories` | **Public** | — | `200` `{ categories }` | — |
| `GET` | `/listings/cities` | **Public** | — | `200` `{ cities }` | — |
| `GET` | `/listings/mine` | Session | — | `200` `{ listings }` | `401` |
| `POST` | `/listings` | **Verified** | listing fields | `201` `{ listing }` | `400`, `401`, `403` |
| `GET` | `/listings/:id` | **Public** | — | `200` `{ listing }` | `404` |
| `PATCH` | `/listings/:id` | Session (owner) | partial fields | `200` `{ listing }` | `400`, `403`, `404` |
| `GET` | `/listings/:id/readiness` | Session (owner) | — | `200` `{ canPublish, blockers }` | `403`, `404` |
| `POST` | `/listings/:id/publish` | **Verified** (owner) | — | `200` `{ listing }` | **`409`**, `403`, `404` |
| `POST` | `/listings/:id/unpublish` | Session (owner) | — | `200` `{ listing }` | `403`, `404` |
| `DELETE` | `/listings/:id` | Session (owner) | — | `200`, `data: null` | `403`, `404` |
| `POST` | `/listings/:id/photos` | **Verified** (owner) | `multipart` — `photos[]` | `201` `{ listing }` | `400`, `403`, `404` |
| `PATCH` | `/listings/:id/photos/order` | Session (owner) | `{ photoIds }` | `200` `{ listing }` | `400`, `403`, `404` |
| `DELETE` | `/listings/:id/photos/:photoId` | Session (owner) | — | `200` `{ listing }` | `403`, `404` |
| `GET` | `/listings/:id/quote` | **Public** | — (`start`, `end`) | `200` `{ quote, blockers, quotedAt }` | `400`, `404` |
| `GET` | `/listings/:id/availability` | **Public**, owner-aware | — (`from`, `to`) | `200` `{ unavailable, noticePeriodHours, bookableFrom }` | `404` |
| `GET` | `/listings/:id/blackouts` | Session (owner) | — (`from`, `to`) | `200` `{ blackouts }` | `401`, `403`, `404` |
| `POST` | `/listings/:id/blackouts` | Session (owner) | `{ startsAt, endsAt, reason? }` | `201` `{ blackout }` | `400`, **`409`**, `403`, `404` |
| `DELETE` | `/listings/:id/blackouts/:blockId` | Session (owner) | — | `200`, `data: null` | `403`, `404` |

### Bookings

Full notes: [features/06-bookings.md](../features/06-bookings.md) — these do not yet have a page of
their own here.

| Method | Path | Auth | Body | Success | Errors |
|---|---|---|---|---|---|
| `POST` | `/bookings` | **Verified** | `{ listingId, startsAt, endsAt, message? }` | `201` `{ booking }` | `400`, **`409`**, `403`, `404` |
| `GET` | `/bookings` | Session | — (`side=renter\|owner`) | `200` `{ bookings, side }` | `400`, `401` |
| `GET` | `/bookings/:id` | Session (party) | — | `200` `{ booking }` — the booking carries `events` and `availableActions` | `403`, `404` |
| `POST` | `/bookings/:id/actions` | Session (party) | `{ action, comment? }` | `200` `{ booking }` | `400`, **`409`**, `403`, `404` |
| `POST` | `/bookings/:id/photos` | Session (party) | `multipart` — `photos[]`, `phase`, `note?` | `201` `{ photos }` | `400`, **`409`**, `404` |
| `GET` | `/bookings/:id/photos` | Session (party) | — | `200` `{ photos }` | `404` |
| `GET` | `/bookings/:id/photos/:photoId/file` | Session (party) | — | `200` image bytes | `404` |

### Notifications

Full notes: [features/09-notifications.md](../features/09-notifications.md). Every route is
`requireAuth` and scoped to the caller by the service — there is no way to ask for somebody else's.

| Method | Path | Auth | Body | Success | Errors |
|---|---|---|---|---|---|
| `GET` | `/notifications` | Session | — (`limit`, `offset`) | `200` `{ notifications, total, limit, offset }` | `400`, `401` |
| `GET` | `/notifications/unread-count` | Session | — | `200` `{ unread }` | `401` |
| `POST` | `/notifications/:id/read` | Session | — | `200` `{ notification }` | `401`, `404` |
| `POST` | `/notifications/read-all` | Session | — | `200` `{ read }` | `401` |

**`unread-count` is its own endpoint deliberately** — it is polled by the header for every
signed-in user for as long as a tab is open, and deriving it from the list would make the most
frequent request in the product one of the most expensive.

**`POST /:id/read` answers `404` for somebody else's id AND for one already read.** Both mean
"there is no unread notification of yours here", and distinguishing them would tell a caller
whether a uuid they guessed exists.

---

## Rate limits

Unauthenticated endpoints only — **never a global limiter**, which would throttle ordinary browsing.

| Endpoint | Key | Counts |
|---|---|---|
| `POST /auth/register` | IP | **all requests** — a *success* here sends an email, so the abuse being capped is mail-quota burn and spamming third parties |
| `POST /auth/login` | IP | **failed attempts only** — a household behind one NAT is a single IP, and counting successes would throttle everyone signing in |
| `POST /auth/verify` | IP | all requests — it is a token-guessing surface |
| `POST /auth/forgot-password` | IP | **all requests** — a success sends an email. **Keyed on the IP, never the submitted address**: a per-address limit would answer differently for one recently used, which is the enumeration oracle rebuilt in the limiter |
| `POST /auth/reset-password` | IP | all requests — token guessing. Deliberately a **separate budget** from `/auth/verify`, so exhausting one cannot lock someone out of the other |

Off under `NODE_ENV=test` unless `RATE_LIMIT_ENABLED=true`. The flag is read **per request**, not
captured at import, so a test can toggle it.

A `429` uses the same envelope as every other error, so the client needs no special case.

---

## Planned

Not built. Listed so the shape is known — see [1.status.md](../1.status.md).

| Endpoint | Step | Note |
|---|---|---|
| `POST /bookings/:id/offers` | 7 | Offer / counter-offer. **Skipped by decision**, not blocked |
| Late fees and damage claims | 8 | FR-705 to FR-707, a second pass. FR-707's deposit release needs payments |
| `POST /bookings/:id/reviews` | 9 | Two-way, and only after a completed booking |
| Payments and payouts | 10 | Never marked paid because the client said so — webhook verification only |

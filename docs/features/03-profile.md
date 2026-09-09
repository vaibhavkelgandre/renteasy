# 03 — Profile, email change and account deletion

**FR-028 to FR-034.** Status: **built and tested** — 29 server tests, 15 client tests. FR-033 is
partial by design; see §6.

Managing your own account: what you look like, how you sign in, and how you leave.

---

## 1. The shape

```
GET    /profile            your own record
PATCH  /profile            name, phone
PATCH  /profile/email      → 202, always. Nothing moves yet.
DELETE /profile/email      abandon a pending change
PATCH  /profile/password   needs the current one
POST   /profile/deletion   needs the current one. Soft.
GET    /users/:id/public   no session. Four columns.
```

**There is no `/profile/:id`.** Every route under `/profile` acts on the caller's own record, taken
from the session and never from the body or a path. With no such route there is no authorization
decision here to get wrong — which is a much stronger position than having one and checking it
carefully.

## 2. What this feature finally proved

Three things had been sitting in the codebase with **no consumer at all**, which this project's
status doc tracks honestly because untested code is not built code. All three got their first real
user here, and all three worked:

| Was unwired | First consumer |
|---|---|
| `RequireAuth` (client) | `/profile` — the first authenticated page in the app |
| `validateParams` | `GET /users/:id/public` — the first route param anywhere |
| `invalidateResetTokensForUser` | Confirming an email change, and changing a password |

## 3. The decisions that carry weight

### 3.1 Changing an email discloses nothing about who owns the target

`PATCH /profile/email` answers **`202` with an identical body** whether the address is free, already
belongs to somebody else, or is the caller's own.

This is the registration guarantee ([features/01](01-public-registration.md) §3.1) defended from the
*inside*. Refusing with "that email is taken" would hand any signed-in user an enumeration oracle
over the entire platform: register one account, then probe addresses one at a time. Everything
registration does to avoid being that oracle would be undone by one helpful error message here.

**The address's real owner is deliberately NOT notified either.** That would turn this endpoint into
a way to send mail to any address a caller can type — the abuse the registration flow's rate limit
and identical response exist to prevent together.

**A wrong password answers `401`, and that is safe.** It is a fact about the caller's own credential,
not about anyone else's address.

### 3.2 Nothing moves until the new address is proved — FR-030

A change writes `users.pending_email` and nothing else. Throughout:

- the current address still signs in
- the current address still receives password resets
- `email_verified_at` is untouched

Only when a link sent to the **new** address is used does it become the real one.

**Why not just overwrite and mark unverified?** Because a typo would then be unrecoverable: the new
address never receives the link, and the old one is already gone. The account is locked out
permanently by a single mistyped character. A pending column costs one migration and removes that
failure entirely.

**`DELETE /profile/email` exists for the same reason.** Without it, a typo leaves the page saying
"waiting for confirmation of asha@gmial.com" until the token expires — and `pending_email` would
outlive even that. It deliberately needs **no password**: it removes a capability rather than
granting one, and the worst an attacker achieves is cancelling a change the owner can request again.

### 3.3 FR-031 comes free, rather than by a sweep

"Changing email invalidates outstanding verification tokens" needs no cleanup job. `issueVerificationToken`
already replaces any live token in one statement via the `uq_evt_active_user` partial index — so
requesting a change kills the previous link in the same breath as minting the new one. There is a
test asserting the first link 410s afterwards.

Reset tokens are handled at the other end: when a change is **confirmed**, `invalidateResetTokensForUser`
runs. A reset link sitting in the *old* inbox must die at that moment rather than merely fail to
match later.

### 3.4 One token flow, two meanings

`POST /auth/verify` now answers two different questions, decided by which column the token's address
matches:

| Token's address matches | Meaning | Response |
|---|---|---|
| `users.email` | first-time verification | `emailChanged: false` |
| `users.pending_email` | completing a change | `emailChanged: true` |
| neither | a cancelled or superseded change | `410` |

**`emailChanged` has to be forwarded by the controller, not merely computed by the service** — it
was dropped on the first pass and a test caught it. The client needs it because "Email confirmed" is
misleading for someone who has just moved their account and must now sign in with a different
address.

**A `23505` on confirmation is an ordinary outcome, not a fault.** Someone else may register the
address while the link sits in an inbox. The unique index arbitrates rather than a check-then-write,
and the race loser gets the same `410` as every other token failure — saying "that address is now
taken" would disclose exactly what §3.1 refuses to.

### 3.5 Sensitive actions re-ask for the password

Changing the email and deleting the account both require `currentPassword`.

**A session cookie proves the browser was signed in at some point, not that the person at the
keyboard is the account's owner.** An unlocked laptop, a shared machine and a stolen session are all
cases where the cookie is valid and the human is not. Both of these actions are irreversible from
the real owner's side.

Changing the password already requires it by definition. Editing a name does not: the worst case is
a silly name, and the owner can change it back.

### 3.6 A public profile is a projection, never a filtered row — FR-033

`findPublicProfileById` selects **four columns**. It does not fetch a user and remove fields.

The difference is what happens next year: with a projection, a column added to `users` cannot leak
here by default. With a filter, every new column is one someone has to remember to exclude. `email`
and `phone` are the two that must never appear, and the only way to be certain is never to select
them.

A marketplace puts strangers in contact. The gap between "someone wants to rent my camera" and
"someone knows how to reach me at home" is this query.

### 3.7 `/terms` admits it is a placeholder

The registration form has linked to `/terms` since day one, and the route did not exist — so the
document a user was legally agreeing to was a 404.

**The page now says, in a banner at the top, that the text is placeholder and was not written or
reviewed by anyone qualified.** That is the whole design decision. Filling it with plausible-sounding
legalese would be *worse* than the 404: registration records which version each person accepted
(`accepted_terms_version`), and the entire point of that column is being able to say later exactly
what somebody agreed to. Text nobody wrote would make that record confidently wrong.

The version is fetched from `GET /auth/terms/current` rather than hardcoded, so this page and the
sign-up checkbox cannot disagree about what is current.

## 4. Small things that are still decisions

- **Editing a phone number is one step beyond FR-029's literal "edit name".** Included because the
  field is captured at signup and was otherwise uncorrectable by anyone — a typo could never be
  fixed. It grants nothing: the number is unverified either way, and FR-036 gates high-value
  listings on a *verified* phone, a separate flow (FR-035) that does not exist.
- **`phone: null` clears it, omitting `phone` leaves it alone.** Without that distinction a number
  could never be removed once entered.
- **`PATCH /profile` refuses an empty body** rather than answering `200` to a request that changed
  nothing, which would suggest something was saved.
- **The new-password minimum is the same 10 characters as registration and reset.** All three must
  agree: the weakest is the way around the policy. A new password identical to the current one is
  refused.
- **Changing your password keeps you signed in here.** It is a deliberate act by the owner; signing
  them out of the tab they are looking at would read as a failure.
- **The account page is four separate forms, not one Save.** They have genuinely different rules —
  two need a password, one takes effect immediately, one takes effect only when a link is clicked. A
  single Save button could only report the vaguest possible outcome.

## 5. Schema

Migration `003_alter_users_add_pending_email_and_deletion.sql`. Column notes: [3.db.md](../3.db.md).

```sql
ALTER TABLE users ADD COLUMN pending_email text;   -- NOT unique, deliberately
ALTER TABLE users ADD COLUMN deleted_at    timestamptz;
```

**`pending_email` is not unique on purpose.** Two people may both want the same address; that is not
a conflict, because nothing has happened yet. `uq_users_email_lower` decides at confirmation time. A
unique constraint here would let the first person to *request* an address reserve it forever without
ever proving they own it — a denial of service on somebody else's real email.

## 6. FR-033 is partial, and will stay partial

Built: the page, the route, member-since, the verified badge, and the never-show-contact-details
rule. Not built: **rating** (needs `reviews`, step 9) and **listing count** (needs `listings`, step 3).

The API returns `null` for both — **unknown, not zero** — and the page renders an em dash. A
hardcoded `0` would read as "this person has never listed anything" rather than "listings do not
exist yet", which is a different and false statement.

## 7. What this does NOT do

- **Deletion is soft, and the address is not released.** The row survives, so the person cannot sign
  up with that address again — and a later registration attempt gets the usual silent `202`, so they
  get no explanation either. There is a test pinning this as a limitation rather than asserting it is
  desirable. Releasing it needs a scrub step (overwrite `email` with a tombstone) that is not built.
- **No grace period and no self-service undo on deletion.** No scheduler exists in this project, and
  an admin restore screen is FR-950 territory.
- **No "your email was changed" or "your password was changed" notice to the old address.** Standard
  practice, and the thing that tells a real owner about a takeover. Deliberately out of scope: both
  actions already require the current password, and neither is asked for by FR-028–034. They want
  their own requirement rather than arriving as a surprise.
- **Neither a password change nor a reset signs out other sessions** — the significant remaining gap.
  See [02-password-reset.md](02-password-reset.md) §7 and [1.status.md](../1.status.md) §5.3.
- **No avatar upload.** Initials only, until media storage exists for listings.

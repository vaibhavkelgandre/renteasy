# 02 — Password reset

**FR-020 to FR-027.** Status: **built and tested** — 19 server tests, 9 client tests.

Recovering an account whose password is lost, without the recovery flow becoming a way to find out
who has an account.

---

## 1. Why this came first

It was hit for real during development. An account was created, its password was lost, and the only
recovery was deleting the database row. Registering the same address again deliberately does not
help — it answers `202` and re-sends a *verification* link, which does nothing about a password.

The sign-in page made it worse by being reassuring about the wrong thing: it promised help for an
unconfirmed **email** and said nothing about a forgotten **password**, which is the gap a user
actually falls into.

## 2. The shape

```
POST /auth/forgot-password  { email }
   → 202, always, identically
   → and IF the address has an active account, an email with a link

GET  /reset-password/<token>          (frontend — renders a form, spends nothing)
POST /auth/reset-password  { token, password }
   → 200, and NO session
   → or 410, identically, for every possible failure
```

Two tokens exist in this product now and they are **separate tables**, not one table with a
`purpose` column. They differ in every parameter that matters — one hour against 24, what consuming
one does, and what a leaked row grants (an account, versus a confirmed address). A shared table
would mean every query carrying a `WHERE purpose = …` that is a silent account-takeover bug the one
time someone forgets it.

## 3. The decisions that carry weight

### 3.1 Asking for a reset discloses nothing — FR-021

`POST /auth/forgot-password` answers **`202` with a byte-identical body** in all four cases:

| Situation | Response | Email sent |
|---|---|---|
| Active account | `202` | reset link |
| Suspended or deleted account | `202` | **nothing** |
| No such address | `202` | **nothing** |
| Inside the 15-minute cooldown | `202` | **nothing** |

Same rule as registration ([features/01](01-public-registration.md) §3.1), and the same reason: a
reset endpoint that answered differently for a registered address would be a free membership oracle
for the whole platform — worth something to anyone who wants to know whether a person is on it.

**Three properties protect this, and all three are easy to undo by accident.** They are commented as
such in `authService.js`:

1. **The send is fire-and-forget, never awaited.** An awaited provider round trip is hundreds of
   milliseconds for a real account against a couple for an unknown one — a single-request-pair
   timing oracle that hands back exactly what the identical response withholds. **This is a
   security decision, not a performance one.**
2. **A delivery failure must never become a 5xx.** Same leak by another route: `500` for real
   accounts and `202` for unknown ones, throughout any mail outage.
3. **The cooldown returns silently.** Saying "wait 15 minutes" would confirm the account exists.

**Honest limit:** the residual timing difference is one `INSERT` — real addresses do a little more
work than unknown ones. That is microseconds against registration's deliberate ~60ms bcrypt on every
path, and is not separately defended. It is recorded rather than claimed away.

**The rate limit is keyed on the IP, never on the submitted address.** A per-address limit would
answer differently for an address that had recently been used, which is the oracle rebuilt in the
limiter. The per-account cooldown lives in the database, where it is invisible from outside.

### 3.2 Every token failure is one answer — FR-024

`POST /auth/reset-password` answers **`410` with an identical body** for:

- an unknown token
- an expired one
- one already used
- one whose account has since **changed its email address**
- one whose account has since been **suspended**

Five causes, one answer. Distinguishing them would tell someone guessing tokens which guesses were
closer, and would turn a spent link into a probe for whether the account still exists.

### 3.3 A reset does not sign you in — FR-025

No cookie, and no user in the response body.

Whoever holds the link has proved control of an **inbox**. That is a good reason to let them set a
password and a poor one to hand them a live session: if a reset email is read by someone who should
not have it, a session is immediate silent access, whereas a password change is at least visible to
the real owner the next time they try to sign in.

The client says so out loud on both the form and the sign-in page it lands on, because every other
credential flow people meet *does* sign them in — so silence here reads as a bug.

### 3.4 The reset page must not spend its token on load

**The one structural difference from `VerifyPage`**, which posts in an effect and needs a `useRef`
guard because StrictMode double-invokes it.

`ResetPasswordPage` has **no effect at all**. The token is spent only by submitting the form. That
is required, not merely tidier: mail clients, link scanners and corporate security gateways
*prefetch* links, so a reset page that consumed its token on mount would be burned before the
recipient typed anything — and they would then be told a perfectly good link had expired.

There is a test asserting no request is made on load.

### 3.5 A token is bound to the address it was mailed to

`password_reset_tokens.email` records the address, and consuming the token sets the password **only
if `users.email` still matches**.

Without it, the sequence *request a reset → change the account's email → click the old link* lets
whoever controls the **old** address set the password on an account that has nothing to do with them
any more. It also delivers FR-031 (changing an email invalidates outstanding tokens) for free, with
no sweep to write and nothing to remember to call.

### 3.6 An unverified account can still reset

They have a password and can forget it, and the link goes to the address on the account either way.
Refusing would leave an unverified account with no recovery at all.

**A successful reset deliberately does NOT mark the email verified**, even though clicking the link
does demonstrate control of the address. Verifying it would be defensible; keeping the two flows
separate means neither can turn into the other by accident, and "reset your password" quietly
conferring a verified status is the kind of coupling nobody remembers a year later. Pinned by a test
so it cannot drift in silently.

### 3.7 Claiming the token and setting the password is ONE statement

`consumeTokenAndSetPassword` is a single SQL statement with a data-modifying CTE. There is no
transaction helper in this codebase, and the two-statement version is wrong in **both** possible
orders:

| Order | Failure between the two |
|---|---|
| consume, then update | token burned, password unchanged — the user is stuck with a dead link |
| update, then consume | password changed, **token still live** — the link is replayable by anyone holding the email |

The second is a security bug rather than an inconvenience. One statement has neither window.

`AND used_at IS NULL` inside the CTE is the atomic claim, so four simultaneous submissions produce
exactly one `200` and three `410`s. There is a test for precisely that — without it, two submissions
would both set a password and the second would silently overwrite the first, which is a confusing
way to lose an account.

**This is the one place `users` is written outside `userRepository.js`.** The atomicity is worth the
exception, and it is commented at both ends.

### 3.8 Issuing is also one statement

`issuePasswordResetToken` folds the cooldown into an `INSERT … ON CONFLICT … DO UPDATE … WHERE`.
Three bugs are unreachable because of that shape:

1. **Two concurrent requests both minting a working link.** A select-then-insert lets both pass.
2. **The cooldown evaluated against a JS clock.** Both sides are now the *database's* clock, so
   Node and Postgres in different timezones cannot silently disable it.
3. **A `409` that answers only for registered addresses.** Without `ON CONFLICT`, the concurrent
   case raises `23505`, which the error handler maps to `409` — so a real address would answer `409`
   where an unknown one answers `202`. That is the oracle rebuilt by accident, and there is a
   regression test named for it.

## 4. The numbers, and why

| Parameter | Value | Reasoning |
|---|---|---|
| Token size | 32 bytes (256 bits) | Guessing is not a threat model at this size |
| Storage | SHA-256 hash | A leak of this table must not be a leak of live takeover credentials |
| **TTL** | **1 hour** | Against verification's 24. A reset link is a live takeover credential sitting in an inbox; a verification link's worst case is a confirmed address |
| **Resend cooldown** | **15 minutes** | See below |
| Live tokens per user | **1** | Partial unique index. Asking again kills the previous link, which is what a user expects |
| Rate limit — request | 5 / hour / IP | Counts **successes**, because a success is what sends mail |
| Rate limit — confirm | 20 / 15 min / IP | Counts everything; token guessing is the threat |
| Minimum password | 10 characters | **The same rule as registration** — see below |

**The cooldown looks user-hostile and is not.** The obvious objection is that an attacker can hammer
the endpoint and lock the victim out of resetting. That is wrong: every request an attacker triggers
delivers a *working* link to the victim's own inbox. So a long window costs a legitimate user
nothing while capping abuse at ~96 emails/day/address — which matters on a 300/day Brevo quota
shared with another project. It is deliberately **shorter than the TTL**, so the link already sent
stays valid across the whole cooldown; if it ever exceeded the TTL there would be a dead window
where the old link had expired and a new one could not be requested.

**The password minimum matches registration exactly.** A reset accepting something weaker would make
this endpoint the way around the policy; demanding something stronger would refuse a password the
account could legitimately already have.

## 5. Schema

Migration `002_create_password_reset_tokens.sql`. Full column notes: [3.db.md](../3.db.md).

```sql
CREATE TABLE password_reset_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,   -- SHA-256, never the token
  email      text NOT NULL,          -- the address it was mailed to (§3.5)
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_prt_active_user
  ON password_reset_tokens (user_id) WHERE used_at IS NULL;
```

## 6. The email — FR-026

One email, sent only to an address that really has an active account.

**What it must never contain**, because anyone can trigger it for any address they can type:

- a session, or anything that signs the recipient in
- a second credential of any kind
- stored detail the recipient might not already know (phone, and so on)

The body says *"Someone asked to reset"*, not *"you asked"* — the person reading it may not be the
person who asked. A test asserts the message contains **exactly one link**, because a stray
verification or sign-in link would be a second credential in the same message.

**The subject is plainly specific** (*"Reset your RentEasy password"*), and that is a deliberate
trade. It does tell a shoulder-surfer reading a lock screen that this address has an account — but a
vague subject on a security email reads as phishing, which costs more than the leak is worth, and
the leak is bounded anyway: the email only ever reaches an address that does have an account, so its
mere arrival carries the same fact.

## 7. What this does NOT do

Named deliberately, so they are gaps rather than oversights.

- **A reset does not sign out other sessions.** This is the significant one. A JWT is signed over
  the user id, not the password hash, so a session stolen before the reset stays valid for up to 12
  hours after it — which undercuts the main reason people reset a password in the first place.
  Fixing it needs a `token_version` column on `users`, carried in the JWT and compared in
  `requireAuth`. Already recorded in [1.status.md](../1.status.md) §8.
- **No "your password was changed" notification.** Standard practice, and the thing that tells a
  real owner their account was taken. Deliberately out of scope here: FR-020–027 do not ask for it,
  and it wants its own requirement rather than arriving as a surprise.
- **No password strength feedback**, no breach-list check, no re-use check against the old password.
- **No account lockout.** Rate limiting is by IP only.
- **The cooldown is keyed on the user**, so it does not slow an attacker cycling many *different*
  known addresses. That is what the IP rate limit is for, and it is per-process in-memory — a second
  server instance would need a shared store before the numbers mean anything.

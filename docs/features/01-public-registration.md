# 01 — Public registration & email verification

**Status:** designed, not built. Awaiting approval before implementation.

The first feature. Everything else needs an account, and the decisions taken here — what identity
means, what an unverified user may do, how we answer a duplicate — are expensive to change later.

Context: [`../0.product-overview.md`](../0.product-overview.md).

---

## 1. Requirement

> **Anyone can create an account from the public site. They confirm their email before they can list
> anything or book anything — but they can browse without an account at all.**

### What is deliberately NOT here

**No role is chosen at signup.** There is no "I want to rent out" versus "I want to rent" switch.
Everyone is a **user**; you become an owner the moment you publish a listing and a renter the moment
you book one, often both in the same week. Asking up front forces a choice people cannot yet make,
and produces two half-accounts for the same person.

**No approval step.** A human approving signups does not scale and adds nothing — verification is
what proves the address is real, and the deposit plus reviews are what manage risk.

**Registration does not sign you in.** See §3.2 — we cannot know the account is yours until the
address is confirmed.

---

## 2. Business rules

| # | Rule |
|---|---|
| BR-1 | Registration is **public**. No invitation, no code, no approval. |
| BR-2 | Required: **name, email, password, explicit acceptance of the terms**. Phone is optional. |
| BR-3 | Email is the **login identity**, matched case-insensitively. |
| BR-4 | An account starts **unverified**. |
| BR-5 | An unverified user **can sign in and browse**, but **cannot list, book, or negotiate**. |
| BR-6 | **The response never reveals whether an email is already registered.** See §3.1 — this is the central decision of this feature. |
| BR-7 | Verification is a **single-use token**, valid 24 hours, stored only as a hash. |
| BR-8 | A verification token verifies **an email address**, not merely a user. |
| BR-9 | Resending is allowed, with a **cooldown**. |
| BR-10 | The **terms version** accepted is recorded, with a timestamp. |
| BR-11 | Registration is **rate limited by IP**, counting successes as well as failures. |
| BR-12 | Registration **never sets a session cookie**. |
| BR-13 | Only an `ADMIN` flag exists as a role, for platform staff. It is never self-assignable. |

---

## 3. The decisions worth arguing about

### 3.1 A duplicate email must not produce a different answer

**The problem.** Registration is inherently an account-enumeration oracle. Type `priya@gmail.com`,
get *"that email is already registered"*, and you have learned Priya has an account here. On a rental
marketplace that discloses something real: who owns things, who rents, who is worth targeting.

Worse, it is trivially automatable against a list of addresses.

**The rule: every registration attempt returns the same status, the same body, and the same shape —
regardless of whether that email exists.** The branch happens in the **email**, not the response:

| Situation | What is created | What is emailed |
|---|---|---|
| Email is new | user (unverified) + verification token | *"Confirm your email"* with the link |
| Email exists, **unverified** | nothing; token reissued | *"Confirm your email"* — same as above |
| Email exists, **verified** | nothing | *"Someone tried to register with your email. If it was you, you already have an account — sign in, or reset your password."* |

Every case answers:

```
202 Accepted
{ "success": true, "message": "Check your email to finish creating your account.", "data": null }
```

**`202`, not `201`, and that is not pedantry.** `201 Created` asserts a resource now exists — which
is exactly the fact we are declining to disclose. `202 Accepted` says "we have taken your request and
will act on it", which is true in all three cases and reveals nothing.

**The timing side-channel is real and is handled.** The new-email path runs bcrypt (~60ms); the
other two would not. That difference is measurable over a handful of requests and reconstructs the
oracle the identical response exists to remove. **So the password is hashed FIRST, before the lookup,
on every path** — even when the hash is then thrown away. It is the same trick login uses in reverse.

**The cost, stated honestly:** someone who genuinely forgot they had an account gets a confirmation
email that is not quite what they expected. That is why the third email's wording matters — it says
plainly that an account already exists and offers both a sign-in and a reset link. This is what
Slack, Notion and Figma do, and it is worth the small confusion.

### 3.2 Registration does not sign you in

Tempting, because it is one less step. Wrong, because at the moment of registering **we do not know
the address belongs to the person typing**. Signing them in would mean anyone can obtain a working
session on any email address they can spell — and by §3.1 we cannot even tell them the account
already existed.

So: no cookie, no token, no session. Confirm the email, then sign in.

### 3.3 An unverified user CAN sign in

The opposite trade. Blocking sign-in until verification sounds tidier, but it strands anyone whose
email was slow, filtered, or mistyped — with nowhere to go and nothing to click.

Signed in but unverified, they land on a page that says what is missing and offers **Resend**. The
gate moves from the door to the actions:

```
No account          browse, search, view listings
Registered          + sign in, edit profile, resend verification
Verified            + create listings, book, negotiate, review
Phone verified      + high-value listings                    (later)
```

**This ladder is the feature.** Every later document refers back to it.

### 3.4 A token verifies an address, not a user

`email_verification_tokens` stores the **address it was sent to**, and consuming it only verifies
the user if `users.email` still equals that address.

Without this, the sequence *register as `a@x.com` → change email to `b@y.com` → click the old link*
marks `b@y.com` verified having proved nothing about it. Rare, and free to prevent.

### 3.5 Rate limiting counts successes here, unlike login

Login counts **failed** attempts only, because an office behind one NAT signing in on Monday morning
is legitimate traffic.

Registration is the opposite: **a success is what sends an email**, so the abuse being capped is
mail-quota burn and using our sender to spam third parties. Both outcomes are triggered by success.

Applies to `POST /auth/register` and `POST /auth/verify/resend`.

---

## 4. Edge cases

| # | Case | Behaviour |
|---|---|---|
| E-1 | Email exists, verified | §3.1 — identical response, "someone tried" email |
| E-2 | Email exists, unverified | §3.1 — identical response, verification reissued |
| E-3 | Differs only by case (`Priya@` vs `priya@`) | Same account. Unique index on `lower(email)` |
| E-4 | Plus-addressing (`priya+rent@gmail.com`) | **Allowed.** A distinct address by the standard; normalising it away breaks a legitimate habit. Revisit only if it becomes a real abuse vector |
| E-5 | Registering while already signed in | `409`. Sign out first — silently replacing a live session is worse |
| E-6 | Verification link clicked twice | **Idempotent.** Second click answers *"already verified"*, not an error. Mail clients prefetch links |
| E-7 | Link expired (>24h) | `410 Gone`, with a resend action |
| E-8 | Link for an address since changed | Refused. §3.4 |
| E-9 | Token malformed or unknown | `410`, **byte-identical to expired** — any difference is an oracle |
| E-10 | Resend before the cooldown | `202`, silently. Telling the caller they are too early confirms the account exists |
| E-11 | Terms not accepted | `400`, field error. Cannot be defaulted to true |
| E-12 | Suspended account re-registers | Identical response; **no email sent**. A suspended user must not self-restore |
| E-13 | Mail provider down | Registration still succeeds (`202`). The user row and token are committed before any send |
| E-14 | Name is whitespace only | `400` — trimmed before length check |
| E-15 | Absurdly long input | `400`. Name ≤120, email ≤254 (the RFC maximum) |
| E-16 | Disposable-domain address | **Allowed in V1.** Noted as a real gap: a blocklist is a maintenance burden, and the deposit plus verification carry more weight |
| E-17 | Two simultaneous registrations, same email | The unique index decides. `23505` maps to the same `202`, not a `409` |

**E-17 deserves its own line.** A check-then-insert lets both requests pass the check before either
commits. Letting the index arbitrate is what makes this correct — and the loser must answer `202`
like everyone else, because an error there would be the enumeration oracle arriving by another route.

---

## 5. Data model

```sql
CREATE TABLE users (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                   text NOT NULL,
  email                  text NOT NULL,
  password_hash          text NOT NULL,

  -- NULL means unverified. A nullable timestamp rather than a boolean: it answers
  -- both "is it verified" and "since when", and there is no way to be verified
  -- without a date.
  email_verified_at      timestamptz,

  phone                  text,
  phone_verified_at      timestamptz,

  status                 text NOT NULL DEFAULT 'ACTIVE'
                           CHECK (status IN ('ACTIVE','SUSPENDED','DELETED')),

  -- Platform staff. NOT a marketplace role - see 0.product-overview.md §2. Never
  -- settable from a request body, only by another admin or a migration.
  is_admin               boolean NOT NULL DEFAULT false,

  -- Which terms they agreed to, and when. A marketplace takes money and moves goods
  -- between strangers; "they accepted the terms" is worth nothing without a version.
  accepted_terms_version text NOT NULL,
  accepted_terms_at      timestamptz NOT NULL DEFAULT now(),

  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_users_email_lower ON users (lower(email));

CREATE TABLE email_verification_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- SHA-256 only. A database leak must not hand over the ability to verify - and
  -- therefore to activate - every pending account.
  token_hash text NOT NULL UNIQUE,

  -- The address this token was issued for. Consuming it verifies the user ONLY if
  -- users.email still matches. See 3.4.
  email      text NOT NULL,

  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_evt_user ON email_verification_tokens (user_id, created_at DESC);

-- At most ONE live token per user. Reissuing replaces rather than accumulating, so
-- an old link in an old email stops working the moment a new one is sent - which is
-- what a user expects from "resend".
CREATE UNIQUE INDEX uq_evt_active_user
  ON email_verification_tokens (user_id)
  WHERE used_at IS NULL;
```

**`uq_users_email_lower` on the expression, not the column.** Otherwise `Priya@x.com` and
`priya@x.com` are two accounts and only one of them can ever sign in.

**`uq_evt_active_user` is a partial index**, and it is what makes reissuing atomic: `INSERT … ON
CONFLICT (user_id) WHERE used_at IS NULL DO UPDATE` replaces the live token in one statement. A
select-then-delete-then-insert would let two concurrent resends both succeed and mint two live links.

---

## 6. API design

Base `/api`. Envelope `{ success, message, data | errors }`.

| Method | Path | Auth | Body | Success | Errors |
|---|---|---|---|---|---|
| `POST` | `/auth/register` | public | `{ name, email, password, phone?, acceptedTermsVersion }` | **`202`**, `data: null` | `400`, `409` already signed in, `429` |
| `POST` | `/auth/verify` | public | `{ token }` | `200`, `data: { alreadyVerified }` | `410`, `429` |
| `POST` | `/auth/verify/resend` | signed in | — | **`202`** | `401`, `429` |
| `GET` | `/auth/terms/current` | public | — | `200`, `data: { version, url }` | — |

### `POST /auth/register`

**Always `202`, always the same body**, whether the email is new, unverified or verified (§3.1).

```json
{ "success": true, "message": "Check your email to finish creating your account.", "data": null }
```

Never sets a cookie (§3.2). `400` is reserved for a genuinely malformed body — never for "that email
is taken", which is not a client error and is not disclosed.

### `POST /auth/verify`

Token in the **body, not the URL**. A token in a query string lands in browser history, server access
logs and any `Referer` header sent to a third-party asset on the confirmation page. The emailed link
points at a frontend route (`/verify/<token>`) which reads it and POSTs.

```json
{ "success": true, "message": "Email confirmed.", "data": { "alreadyVerified": false } }
```

`alreadyVerified: true` on a second click (E-6) — a `200`, not an error, because mail clients
prefetch links and the user did nothing wrong.

**Every failure is `410 Gone` with an identical body** — expired, already used, unknown, malformed,
or issued for an address since changed. Five causes, one answer, because distinguishing them tells an
attacker which guesses were closer.

### `POST /auth/verify/resend`

Requires a session — the caller is signed in but unverified (§3.3), so there is no address to guess.
Always `202`, including inside the cooldown (E-10).

### Rate limits

| Endpoint | Key | Counts |
|---|---|---|
| `POST /auth/register` | IP | **all requests** (§3.5) |
| `POST /auth/verify` | IP | all requests — it is a token-guessing surface |
| `POST /auth/verify/resend` | IP + per-user cooldown | all requests |

---

## 7. Validation

| Field | Rule | Why |
|---|---|---|
| `name` | trimmed, 1–120 | Shown to the person handing over a ₹80,000 camera |
| `email` | trimmed, lowercased, valid, ≤254 | 254 is the RFC 5321 maximum |
| `password` | ≥10 | Length beats complexity rules, which mostly produce `Password1!` |
| `phone` | optional, E.164-ish | Not verified at signup; used for the later trust tier |
| `acceptedTermsVersion` | required, must equal the current version | See below |

**`acceptedTermsVersion` must match the server's current version**, not merely be present. A client
sending a stale version means the page was open when the terms changed — and recording agreement to
terms they never saw is exactly the thing this field exists to prevent. Answer `409` and reload.

**No maximum password length, and no complexity rules.** bcrypt hashes to a fixed size, so a long
passphrase is free to store; capping it only weakens the strongest passwords people choose.

---

## 8. Test cases

**The security properties — these are the ones that matter:**

- a new email, an existing unverified email and an existing verified email produce **byte-identical
  responses**, asserted with `toEqual`
- registration **sets no cookie**, on any path
- the password is hashed on **every** path, including when no account is created (timing)
- the raw token is **absent from the database** — only its hash
- expired, used, unknown and malformed tokens produce **byte-identical `410`s**
- a token issued for an address the user has since changed is refused
- concurrent registrations with the same email create **exactly one** user, and both callers get `202`

**Behaviour:**

- verifying twice answers `200` with `alreadyVerified: true`
- resending invalidates the previous link
- resending inside the cooldown still answers `202`
- an unverified user can sign in; creating a listing answers `403`
- a suspended email gets the same `202` and **no email**
- `Priya@x.com` and `priya@x.com` are one account
- missing terms acceptance answers `400`; a stale version answers `409`

**Resilience:**

- with the mail transport forced to throw, `POST /auth/register` still answers `202` and the user row
  and token both exist. *The single most valuable test here* — it pins a design decision, not a
  behaviour.

---

## 9. Open decisions

**Email or phone as the primary identity?** This spec assumes **email**, because it is free, needs no
provider integration, and works for the browse-first flow. In India phone is often the more natural
identity — but SMS costs money per message and OTP adds a whole flow. Phone is captured at signup and
verified later as a trust tier.

**Worth confirming before implementation**, because switching afterwards means a migration, a new
provider, and reworking this entire document.

**Deferred and named, so they are gaps rather than oversights:** social sign-in (Google), disposable
domain blocking, CAPTCHA on registration, and account deletion under data-protection law.

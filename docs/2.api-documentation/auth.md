# API — authentication

Registration, email verification, sign-in, sessions and password reset.

Part of the [API documentation](README.md), which holds the response envelope, the status-code
policy and the full endpoint table.

---

## `POST /auth/register`

**Always `202`, always the same body**, whether the email is new, registered-but-unverified, or a
live verified account. Full reasoning:
[features/01-public-registration.md](../features/01-public-registration.md) §3.1.

```json
{ "success": true, "message": "Check your email to finish creating your account.", "data": null }
```

The branch happens in the **email**, never the response:

| Situation | Created | Emailed |
|---|---|---|
| New email | user (unverified) + token | *"Confirm your email"* + link |
| Exists, unverified | nothing; token reissued | *"Confirm your email"* — identical |
| Exists, verified | nothing | *"Someone tried to register with your email"* — **no credential in it** |
| Suspended | nothing | **nothing at all** |

**Sets no cookie.** At this moment nobody has proved the address is theirs.

**`400`** is only ever a malformed body — never "that email is taken", which is not a client error
and is not disclosed. **`409`** means the submitted `acceptedTermsVersion` is not the current one:
safe to be specific, because it says nothing about the account and the client genuinely needs to
reload.

**Fields silently stripped:** `role`, `isAdmin`, `is_admin`, `status`, `emailVerified`. Zod discards
unknown keys, so they never reach a service — the difference between "we don't read that" and "that
cannot be set from outside".

## `POST /auth/verify`

Token in the **body, not the URL**. A token in a query string lands in browser history, server
access logs, and any `Referer` sent to a third-party asset. The emailed link points at a *frontend*
route (`/verify/<token>`) which reads it and POSTs.

```json
{ "success": true, "message": "Email confirmed.", "data": { "alreadyVerified": false, "emailChanged": false } }
```

**`emailChanged` distinguishes two things one endpoint does.** The same token flow confirms a brand
new address *and* completes an email change started from the profile (FR-030) — the difference is
whether the token's address matches `users.email` or `users.pending_email`. The client needs it
because "Email confirmed" is misleading for somebody who has just moved their account and must now
sign in with the new address.

`alreadyVerified: true` on a second click — a **`200`, not an error**, because mail clients prefetch
links and the user did nothing wrong.

**Every failure is `410` with an identical body.** Expired · already used with a since-changed
address · unknown · malformed · issued for an address that no longer matches. Distinguishing them
would tell someone guessing tokens which guesses were closer.

## `POST /auth/verify/resend`

Requires a session, deliberately: the caller is signed in but unverified, so there is no address for
a stranger to guess. An unauthenticated version would be an open email-sending endpoint aimed at any
address a caller can type.

**Always `202`** — sent, inside the 2-minute cooldown, or already verified all answer the same.

## `POST /auth/login`

An **unverified user can sign in** — see §3.3 of the feature doc. Blocking them would strand anyone
whose email was slow or mistyped, with nothing to click.

Wrong password, unknown email and suspended account return the **same `401` message**. The response
body carries the user but **never the token** — that would defeat `httpOnly`, since JavaScript could
then read and store it.

## `GET /auth/me`

Reads the user **fresh from the database** on every request. That is why the JWT carries only an id:
baked-in verification state would keep saying "unverified" for the token's full 12-hour life, so
someone who just confirmed their email could not act until they signed out and back in.

## `POST /auth/forgot-password`

**Always `202`, always the same body** — an active account, a suspended one, an unknown address, or a
request inside the 15-minute cooldown. Full reasoning:
[features/02-password-reset.md](../features/02-password-reset.md) §3.1.

```json
{ "success": true, "message": "If that address has an account, we've emailed a reset link.", "data": null }
```

The branch happens in the **email**, never the response:

| Situation | Emailed |
|---|---|
| Active account | *"Reset your RentEasy password"* + link |
| Suspended or deleted | **nothing** |
| No such address | **nothing at all** — deliberately not "you have no account here", which would make this a way to mail any address a caller can type |
| Inside the cooldown | **nothing**. The link from minutes ago is still valid for the rest of the hour |

**`400`** is only ever a malformed address — safe to report, because it is refused on shape alone,
before any lookup happens.

**Three properties keep the guarantee**, all easy to undo by accident: the send is fire-and-forget
and never awaited (an awaited provider round trip is a timing oracle), a delivery failure never
becomes a 5xx, and the cooldown returns silently.

## `POST /auth/reset-password`

Token in the **body, not the URL** — and it matters more here than for verification, because this
token sets a password, so a copy in an access log or a `Referer` header is a copy of an
account-takeover credential. The emailed link points at a *frontend* route
(`/reset-password/<token>`) which renders a form.

```json
{ "success": true, "message": "Password updated. You can now sign in.", "data": null }
```

**Sets no cookie, and returns no user (FR-025).** Whoever holds the link has proved control of an
inbox — a good reason to let them set a password and a poor one to hand them a live session.

**Every failure is `410` with an identical body.** Unknown · expired · already used · the account's
address changed since it was issued · the account is no longer active. Five causes, one answer.

**`400`** is a password below the 10-character minimum — **the same rule as registration**, so this
endpoint is not a way around the policy. A `400` does **not** spend the token.

The token is consumed and the password set in **one SQL statement**, so four simultaneous
submissions produce exactly one `200` and three `410`s.

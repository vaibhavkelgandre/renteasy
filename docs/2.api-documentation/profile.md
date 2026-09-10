# API — profile and public profiles

A user's own account, and the tiny projection strangers may read.

Part of the [API documentation](README.md).

---

## Profile

Everything under `/profile` acts on the **caller's own record**, taken from the session. There is no
`/profile/:id` — with no such route there is no chance of an authorization check being forgotten on
it. Reading somebody else's profile is a separate, deliberately tiny endpoint.

### `PATCH /profile`

At least one of `name` or `phone` is required; `{}` answers `400` rather than reporting a save that
did nothing.

**`phone: null` clears it; omitting `phone` leaves it alone.** Without that distinction a number
could never be removed once entered.

**Fields silently stripped:** `email`, `status`, `isAdmin`, `is_admin`, `emailVerified`,
`email_verified_at`, `id`. Zod discards unknown keys, so none of them reach a service. Changing an
email has its own endpoint precisely because it needs proof of the new address, and it must not be
reachable by smuggling a key into a name update. There is a test sending all of them at once.

### `PATCH /profile/email`

**Always `202`, always the same body** once the password checks out — whether the address is free,
already belongs to somebody else, or is the caller's own.

**Nothing about the account changes.** The current address keeps signing in and keeps receiving
password resets until a link sent to the new one is used, so `202` is the only honest answer. A typo
therefore costs nothing; overwriting the address immediately would lock the account out permanently.

The **identical response is a security property, not politeness**: refusing with "that email is
taken" would hand any signed-in user an enumeration oracle over the whole platform — register one
account, then probe addresses one at a time. That defeats the property registration protects
([features/01](../features/01-public-registration.md) §3.1) from the inside.

**`401` for a wrong password is safe to disclose**: it is a fact about the caller's own credential,
not about anyone else's address. The password is required because a session cookie proves the
browser was signed in at some point, not that the person at the keyboard owns the account.

**Not gated on a verified email**, deliberately — someone whose address was mistyped at signup is
exactly who needs this, and `requireVerifiedEmail` here would trap them permanently.

### `PATCH /profile/password`

Same 10-character minimum as registration and reset; all three must agree or the weakest is the way
around the policy. Refuses (`400`) a new password identical to the current one.

**Keeps the caller signed in** — this is a deliberate act by the account's owner, and signing them
out of the tab they are looking at would read as a failure. It does **not** sign out other sessions;
see [1.status.md](../1.status.md) §5.3. Any outstanding reset token is invalidated.

### `POST /profile/deletion`

`POST`, not `DELETE`: this is a soft delete carrying a body (the password confirmation), and `DELETE`
with a body is poorly supported by enough clients to be worth avoiding.

Clears the session cookie. **The address is NOT released** — the row survives, so the person cannot
sign up with it again. A later registration attempt gets the usual `202` and no email, because a
non-ACTIVE account is deliberately silent, which means no explanation either. Named as a limitation
in [features/03](../features/03-profile.md) §7.

## `GET /users/:id/public`

Public, because a listing has to name who is offering it to a visitor with no account.

```json
{ "success": true, "message": "OK",
  "data": { "profile": { "id": "…", "name": "Asha Patil", "memberSince": "2026-03-14T00:00:00Z",
                         "emailVerified": true, "rating": null, "listingCount": null } } }
```

**Four columns, selected — never a filtered row.** `email` and `phone` are absent at the SQL level,
so a column added to `users` later cannot leak here by default.

**`rating` and `listingCount` are `null`, meaning unknown, not zero.** Neither has a table yet
(steps 9 and 3). A hardcoded `0` would read as "this person has never listed anything".

**One `404` for three causes**: unknown id, malformed id, and a suspended or deleted account. A
stranger has no more reason to learn somebody was once here than to learn they never were, and a
`400` for a bad id would disclose that ids are UUIDs. There is a test asserting all three are
byte-identical.

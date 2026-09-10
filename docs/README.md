# RentEasy documentation

A two-sided marketplace for renting things — bikes, cameras, water purifiers, tools — **by the hour,
the day or the month**, at a price you can negotiate.

## Start here

**[1.status.md](1.status.md) — what works, what doesn't, what's next.** Read it first.

**[7.functional-requirements.md](7.functional-requirements.md) — every requirement, built or not.**
The canonical list. Cite its IDs (`FR-103`) rather than describing a requirement in prose; they are
never renumbered and never reused.

---

## The documents

| Doc | Holds | Update when |
|---|---|---|
| [0.product-overview.md](0.product-overview.md) | What the product is, the two-sided model, the hard problems | The shape of the product changes |
| **[1.status.md](1.status.md)** | **Completed / pending, per step and per requirement. Plus "built but not wired to anything"** | **Every change — same commit** |
| [2.api-documentation/](2.api-documentation/README.md) | Every endpoint: method, auth, body, response, errors. **Split into a folder at 395 lines** — [auth](2.api-documentation/auth.md), [profile](2.api-documentation/profile.md), [listings](2.api-documentation/listings.md) | **Any endpoint changes — same commit** |
| [3.db.md](3.db.md) | Every table, column, constraint and index, with reasoning | **Any migration is added — same commit** |
| [4.non-functional-requirements.md](4.non-functional-requirements.md) | NFR-1..NFR-15 — cross-cutting, with honest status | An NFR advances |
| [5.design-system.md](5.design-system.md) | Colours, type, layout, primitives, and the copy rules | Any new UI pattern |
| [6.media-storage.md](6.media-storage.md) | How listing photos are stored, served and cleaned up | The storage provider or pipeline changes |
| **[7.functional-requirements.md](7.functional-requirements.md)** | **Every requirement, built or not — FR-001 to FR-987. The canonical list, and the IDs to cite** | **A requirement is added, changed, completed or withdrawn** |
| [features/](features/) | One spec per feature, with the reasoning behind each decision | A feature is designed |
| [troubleshooting.md](troubleshooting.md) | Solved bugs: symptom, root cause, fix | After solving anything non-trivial |

### Feature specs

- [01 — Public registration & email verification](features/01-public-registration.md) ✅ built
- [02 — Password reset](features/02-password-reset.md) ✅ built
- [03 — Profile, email change and account deletion](features/03-profile.md) ✅ built
- [04 — Listings, the rate card and photos](features/04-listings.md) ✅ built
- [05 — Browse, search and pagination](features/05-browse.md) ✅ built

## Four docs are not optional

A change that skips one is unfinished:

- **`1.status.md`** — a tracker that lags is worse than none, because it gets trusted.
- **`7.functional-requirements.md`** — mark a requirement done in the same commit that does it.
- **`2.api-documentation/`** — an undocumented endpoint cannot be reviewed or consumed.
- **`3.db.md`** — a migration without an entry means reading SQL to understand the schema.
- **`troubleshooting.md`** — so nothing is diagnosed twice.

## The four things this product lives or dies on

Named here because every feature doc refers back to them.

**1. No role hierarchy.** The same person lists a camera and rents a bike, so authorization is
*"am I this listing's owner?"* — a relationship to a record, never a property of a person.
([0.product-overview.md](0.product-overview.md) §2)

**2. Registration discloses nothing.** Identical answers for a new, unverified and verified email;
the difference lives in the email, where only its owner can read it.
([features/01](features/01-public-registration.md) §3.1)

**3. The cheapest applicable rate.** 30 days is charged at the monthly rate, never 30 × daily.
Computed server-side and shown itemised. ([0.product-overview.md](0.product-overview.md) §4)

**4. Nothing is rented twice over.** Two people can hit Book on one camera in the same millisecond,
so the guard belongs in the database, not in an application check a future code path might skip.
([4.non-functional-requirements.md](4.non-functional-requirements.md) NFR-8)

## Running it

Requires Node 20+ and PostgreSQL 14+. **Ports are 5001 (API) and 5174 (client)** — not the framework
defaults, deliberately, so this can run alongside another project.

```
npm run install:all
psql -U postgres -c "CREATE DATABASE renteasy;" -c "CREATE DATABASE renteasy_test;"
cd server && cp .env.example .env && cp .env.test.example .env.test   # fill DB_PASSWORD, JWT_SECRET
cd server && npm run migrate && npm run migrate:test
npm run dev          # API    :5001
npm run dev:client   # client :5174
```

`npm test` at the root runs everything — server suite, then client.

In development **every emailed link prints to the server console** — verification and password reset
alike. That is the only place they exist: the database stores only a hash. To send real mail instead
(locally too), set `BREVO_API_KEY` and `MAIL_FROM` in `server/.env`; the boot banner reports which
mode is active. See [1.status.md](1.status.md) §5.2.

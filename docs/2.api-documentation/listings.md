# API — listings, photos and browse

Creating, editing and publishing a listing; its photos; and the public browse endpoint.

Part of the [API documentation](README.md).

---

## Listings

**Ownership is a relationship, not a role (FR-111).** There is no listing-manager permission. Every
mutating endpoint asks one question — "is this caller the owner of this row?" — in the service, next
to the data. That is why no route here carries an authorization middleware: answering it requires
loading the listing, which the service does anyway.

### 403 versus 404, and why they differ by status

| Caller | DRAFT / UNPUBLISHED listing | PUBLISHED listing |
|---|---|---|
| the owner | `200` | `200` |
| anyone else | **`404`** | `403` on a write, `200` on a read |

A draft answers `404` because nobody but its owner has any way to know it exists — a `403` would
confirm that this particular id is somebody's unpublished listing, which is exactly the fact a draft
keeps private. A published listing is world-readable, so pretending otherwise would be theatre.

### `POST /listings`

**`201`, and always a DRAFT.** `status` and `publishedAt` in the body are stripped; publishing has
conditions and an insert that could set `PUBLISHED` would be a route straight past them.

Requires a **verified email** — the first endpoint in the application to use `requireVerifiedEmail`,
which had existed since step 1 with no consumer. Gated at creation as well as at publish, so an
unverified account is not left accumulating drafts it can never publish.

**A draft needs almost nothing**: a title, description, category and condition. No price, no
location, no photos. Refusing to save a half-finished draft would stop somebody who wants to think
about the price overnight from starting at all.

### `POST /listings/:id/publish` — FR-107

**`409` listing EVERY unmet condition at once**, not the first:

```json
{ "success": false,
  "message": "This listing is not ready yet: Add at least one photo; Set at least one price — hourly, daily or monthly.",
  "errors": { "publish": "Add at least one photo; Set at least one price — hourly, daily or monthly" } }
```

Reporting them one at a time turns publishing into a guessing game where each fix reveals the next
obstacle. `GET /listings/:id/readiness` returns the same list without attempting anything, computed
by the same function, so the owner's checklist cannot drift from the rule that refuses them.

Publishing an already-published listing is a **`200`, not an error** — it is idempotent, and
`published_at` is stamped only the first time.

### `POST /listings/:id/photos` — FR-105

`multipart/form-data`, field name **`photos`**, up to **8 files** of **5MB** each.

**The real type is sniffed from the leading bytes.** The extension and the client's `Content-Type`
are both supplied by the uploader, so both are claims — `payload.php` renamed to `holiday.jpg`
arrives declaring itself a JPEG. JPEG, PNG and WebP only; **SVG is deliberately excluded** because it
is a document that can carry script and would be served from our own CDN domain.

**One bad file rejects the whole batch.** A listing that silently came out with three photos when
four were chosen is a bug the user cannot see or explain.

**EXIF is stripped on upload.** A phone photo carries GPS coordinates, so publishing one otherwise
publishes the owner's home address.

Order of operations, and it is the whole design: ownership → cap → real-type check → **upload** →
**insert**. Uploading after every check and before the insert means a rejected request never creates
a remote asset, and a failed upload never leaves a half-attached listing.

### `PATCH /listings/:id/photos/order` — FR-106

Must name **every** photo of the listing exactly once; a partial list is `400`. Position 0 is the
cover. Backed by a `DEFERRABLE` unique constraint, so the permutation happens in one statement.

### What the API returns for a photo

Never a stored URL — Postgres holds a `storage_id` and every size is built on read:

```json
{ "id": "…", "sortOrder": 0, "width": 1200, "height": 900,
  "thumbUrl": ".../w_400,h_300,c_fill,f_auto,q_auto/…",
  "url":      ".../w_1200,c_limit,f_auto,q_auto/…" }
```

`width`/`height` are returned so the client can reserve the space before the image arrives, which is
what stops a grid jumping as photos load.

---

---

## `GET /listings` — browse

**Public.** The endpoint that makes a published listing findable; before it, a listing was visible
only to somebody who already had its URL.

```json
{ "success": true, "message": "OK",
  "data": { "listings": [ … ], "total": 57, "limit": 24, "offset": 0 } }
```

| Parameter | Notes |
|---|---|
| `q` | Title and description. **Trigram**, so partial words match — "puls" finds "Pulsar" |
| `category` | Slug |
| `city` | Case-insensitive |
| `unit` | `hourly` / `daily` / `monthly`. **Defaults to `daily`** |
| `minPricePaise`, `maxPricePaise` | Against the chosen `unit` |
| `sort` | `newest` (default) / `price_asc` / `price_desc` |
| `limit` | Default **24**, max **48** |
| `offset` | Default 0 |

**`total` is counted by the same STATEMENT as the page**, via `count(*) OVER ()` — not merely the
same WHERE. Sharing a clause relies on discipline; sharing a statement makes disagreement
impossible, and the failure it prevents is silent: a pager offering a page four that renders empty.

**`limit` above the cap is a `400`, not a silent clamp.** A caller that asked for 100000 should
learn its request was refused rather than quietly receive 48.

**`limit` and `offset` are echoed back**, so a defaulted or capped value is visible in the response
rather than differing invisibly from the request.

**A price filter EXCLUDES listings with no rate for that unit.** "Under ₹1000 a day" cannot
sensibly include something priced only by the month. When *sorting* rather than filtering, those
listings sink to the bottom via `NULLS LAST` — Postgres puts NULLs first on `ASC`, which would head
"cheapest first" with every unpriced listing.

**Drafts and unpublished listings never appear (FR-309)**, through any filter. `status =
'PUBLISHED'` is the first condition in the where-builder so it cannot be lost among the optional
ones, and there is a test probing each filter separately.

**`%` and `_` in `q` are escaped**, so "50% off" searches for that text rather than matching
everything.

Ordering always falls through to `created_at DESC` as a tiebreaker. Without it, two listings at the
same price have no defined order and the same row can appear on two pages.

## `GET /listings/cities`

**Public.** The distinct cities that currently have something published — derived, not a stored
list, which would go stale in both directions: offering places with nothing to rent and omitting the
one somebody just listed in. A draft's city does not appear, for the same reason the draft does not.

---

## `GET /listings/:id/quote` — what a rental would cost

**Public**, and side-effect free. `?start=` and `?end=` are ISO instants, because this product
rents by the hour as well as the month and a bare date cannot express a six-hour rental.

```json
{ "success": true, "message": "OK",
  "data": {
    "quote": {
      "requestedHours": 960, "coveredHours": 960,
      "lines": [
        { "unit": "month", "quantity": 1,  "unitPricePaise": 1500000, "subtotalPaise": 1500000 },
        { "unit": "day",   "quantity": 10, "unitPricePaise": 80000,   "subtotalPaise": 800000 }
      ],
      "rentPaise": 2300000,
      "taxPaise": 0, "taxBasisPoints": 0,
      "depositPaise": 500000, "depositRefundable": true,
      "renterTotalPaise": 2800000,
      "commissionPaise": 230000, "commissionBasisPoints": 1000,
      "ownerPayoutPaise": 2070000
    },
    "blockers": [],
    "quotedAt": "2026-09-10T12:00:00.000Z"
  } }
```

**The cheapest applicable combination, never a naive multiplication (FR-400).** Six hours are
charged as a day when a day is cheaper than six hours; thirty days as a month; forty days as a
month plus ten days. The three worked examples from
[0.product-overview.md](../0.product-overview.md) §4 are pinned as tests.

**Itemised (FR-401)** — units, the rate applied and the subtotal. A total on its own is unauditable
by the person paying it.

**Computed server-side and nowhere else (FR-404).** The client renders what this returns and has no
arithmetic of its own, which makes "a client-supplied total is never trusted" structural rather than
a rule somebody has to remember.

**`coveredHours` can exceed `requestedHours`** — six hours billed as a day covers 24 — so the client
can say so rather than leaving somebody to wonder why six hours cost a day's rate.

**Commission is deducted from `ownerPayoutPaise`, never added to `renterTotalPaise`.** The quoted
price is the price paid. Nothing collects it yet.

**A duration outside the listing's own min/max returns `blockers`, not an error.** Same shape as the
publish checklist: a caller who cannot see the price cannot work out what to change.

`400` for an inverted range or a listing with no rate at all — quoting ₹0 for a camera would be
worse than refusing. `404` for a draft, unless you own it.

# 04 — Listings, the rate card and photos

**FR-100 to FR-116.** Status: **built and tested** — 38 server tests, 17 client tests. Three
requirements wait on a `bookings` table; see §7.

The step where this stops being an auth demo and becomes a marketplace.

---

## 1. The shape

```
GET    /listings/categories          public
POST   /listings                     verified  → 201, always a DRAFT
GET    /listings/mine                session   → drafts included
GET    /listings/:id                 public    → 404 for a draft, unless you own it
PATCH  /listings/:id                 owner
GET    /listings/:id/readiness       owner     → the publish checklist
POST   /listings/:id/publish         verified owner
POST   /listings/:id/unpublish       owner
DELETE /listings/:id                 owner
POST   /listings/:id/photos          verified owner, multipart
PATCH  /listings/:id/photos/order    owner
DELETE /listings/:id/photos/:photoId owner
```

## 2. What this step finally proved

**`requireVerifiedEmail` had zero routes from step 1 until now.** FR-005 — "unverified users may
browse but not list" — was a design intention with nothing enforcing it. It now gates create, add
photos and publish, and a test asserts an unverified account gets `403` with
`reason: EMAIL_NOT_VERIFIED`.

This project tracks unwired code deliberately, because untested code is not built code, and this one
sat unproven for two whole steps.

## 3. The decisions that carry weight

### 3.1 A listing is always created as a draft — FR-100

`POST /listings` cannot produce a published listing. `status` and `publishedAt` are stripped from the
body, and the repository takes no `status` parameter at all — publishing has conditions, and an
insert that could set `PUBLISHED` would be a route straight past them.

**A draft needs almost nothing**: title, description, category, condition. No price, no location, no
photos. That is not laxness — refusing to save a half-finished draft would stop somebody who wants to
think about the price overnight from starting at all.

### 3.2 The rate card is three nullable columns, not a rates table

**A deliberate deviation from the shape sketched in `3.db.md`'s planned section**, which had
`listing_rates` as its own table. Columns won for two reasons:

- **No join on the hottest read.** Every listing view and every browse tile needs the rate card, so a
  table means a join on the one query that runs most.
- **The unit set is closed.** Hourly, daily, monthly — this is not a list that grows with use, which
  is the test that sends something to its own table (see `categories`, which is the opposite case).

A rates table would only pay off if units became user-defined, and nothing in FR-400–439 suggests
they will.

**All three nullable, with no CHECK requiring one**, and that looks like a gap until you line it up
with §3.1: FR-103's "at least one required" is a **publish** condition (FR-107), not a storage one.
`> 0` rather than `>= 0`, because a rate of zero is not a free rental, it is a missing price.

**Integer paise everywhere.** `client/src/lib/money.js` is the only place that converts, and it
rounds rather than truncating — `19.99 * 100` is `1998.9999…` in binary floating point, so truncation
would silently shave a paisa off a large share of ordinary prices.

### 3.3 Ownership is a relationship, and the refusal differs by status — FR-111

There is no listing-manager role and no `requireOwner` middleware. One function, `loadOwnListing`,
answers "is this caller the owner of this row?" in the service, next to the data — a middleware would
have to load the listing to answer, and then the service would load it again.

| Caller | DRAFT / UNPUBLISHED | PUBLISHED |
|---|---|---|
| the owner | `200` | `200` |
| anyone else | **`404`** | `403` on a write |

**The split is the interesting part.** A draft answers `404` because nobody but its owner has any way
to know it exists — a `403` would confirm that this id is somebody's unpublished listing, which is
the fact a draft keeps private. A published listing is world-readable, so pretending it does not
exist would be theatre. This follows the rule already written into `utils/errors.js`.

### 3.4 The publish gate is one function, and reports everything at once — FR-107

Four conditions: a verified email, at least one photo, at least one rate, a location. Collected in a
single `publishBlockers` function, because a gate whose conditions are spread across a controller, a
validator and two services is one nobody can audit — and this is the rule that decides what strangers
can see.

**It returns every unmet condition, not the first.** Reporting them one at a time turns publishing
into a guessing game where each fix reveals the next obstacle.

**`GET /:id/readiness` runs the same function** and changes nothing, so the checklist on the edit
screen cannot drift from the rule that actually refuses. That endpoint exists because discovering the
requirements by pressing Publish repeatedly is a bad way to learn them.

Publishing an already-published listing is a **`200`**, and `published_at` is stamped only the first
time — it records when the listing first went live, which is a different question from whether it is
live now.

### 3.5 A file's real type is read from its bytes — FR-105

The extension and the client's `Content-Type` are both supplied by whoever is uploading, so both are
claims. `payload.php` renamed to `holiday.jpg` arrives with a `.jpg` extension and an `image/jpeg`
content type, because the uploader chose them.

`utils/imageType.js` reads the leading bytes instead. **JPEG, PNG and WebP only. SVG is deliberately
excluded and must stay excluded** — it is a document, it can carry `<script>`, and it would be served
from our own CDN domain, so accepting one is accepting stored XSS with our domain's trust attached.

**This runs after the bytes are in memory, not in multer's `fileFilter`.** A `fileFilter` runs while
the file is still streaming, so all it can inspect is the very metadata that cannot be trusted.

**One bad file rejects the whole batch.** A listing that silently came out with three photos when
four were chosen is a bug the user cannot see or explain.

**EXIF is stripped on upload, and this is a safety control rather than an optimisation.** A phone
photo carries GPS coordinates. Publishing a listing photo with them intact publishes the owner's home
address to anyone who downloads it.

> **This shipped broken first, and the reason is worth keeping.** The original passed
> `image_metadata: false`, which reads exactly like the right parameter and is not — it controls
> whether the API *returns* metadata in its response, not whether the stored asset keeps it.
> Cloudinary strips metadata from **derived** images, so the thumbnails the app serves were always
> clean; but the untransformed original stayed at `/image/upload/<public_id>` with the coordinates
> intact, and the public_id is in the page's HTML.
>
> The fix is an **incoming transformation**, which replaces the stored original with the transformed
> version so no original survives to hold them:
>
> ```js
> transformation: [{ width: 2400, height: 2400, crop: "limit", quality: "auto:good", flags: "strip_profile" }]
> ```
>
> **`quality: auto:good` is load-bearing, not tuning.** `c_limit` only acts when an image is too
> big, so a photo already under 2400px would pass through untouched — the quality directive is what
> forces the re-encode regardless of size.
>
> **Verified against the real provider**, not inferred: a JPEG carrying an Exif APP1 segment with GPS
> tags and a marker string went in at 246 bytes and the re-downloaded stored original came back at
> 160 with neither the `Exif` header nor the marker. `listingUploadOptions` was extracted so
> `cloudinary.test.js` can assert the transformation is present — the suite runs against a fake
> uploader that never builds these options, which is why nothing caught the first version.

**Order of operations, which is the whole design:** ownership → cap → real-type check → upload →
insert. Uploading after every check and before the insert means a rejected request never creates a
remote asset, and a failed upload never leaves a half-attached listing — nothing has touched Postgres
at that point. If one file in a batch fails mid-upload, the ones already sent are destroyed before
the error propagates, rather than being left for a sweep.

### 3.6 Photo order is a `sort_order` with a DEFERRABLE constraint — FR-106

Position 0 is the cover. Ordering rather than an `is_cover` flag: with a flag, "exactly one cover" is
an invariant to enforce, and a listing whose cover was deleted has none.

**`uq_listing_photo_position` is `DEFERRABLE INITIALLY DEFERRED`, and without that word reordering
does not work.** A permutation passes through states where two rows share a position — swapping 0 and
1 must transiently have two of one. A normal UNIQUE is checked per row as the statement runs, so it
refuses every reorder that is not a strict rotation. Deferred, the check happens at commit, so one
`UPDATE … FROM unnest(...) WITH ORDINALITY` rewrites the whole order and only the final arrangement
is validated.

**A reorder must name every photo exactly once.** A partial list would leave the unnamed ones at
positions that now collide, and "what happened to the rest?" has no good answer.

### 3.7 Location is an area, and the form says so — FR-113

There is no `address_line` column anywhere, and adding one would be a safety regression rather than a
feature: a published listing is world-readable, so a street address on it says where a valuable
object is kept and where its owner lives.

**The form states this in the section it applies to**, not in a policy page. An owner who does not
know the rule will type their address into "Area" instead, and the schema cannot stop them.

## 4. Two dependencies added, and why the mailer's "no SDK" rule did not apply

`multer` and `cloudinary`.

`config/mailer.js` deliberately has **no** provider SDK, because Brevo's send is one JSON POST and a
package would buy nothing but risk. A Cloudinary upload is a multipart POST whose signature is a
SHA-1 over sorted parameters — a real algorithm with a real chance of being subtly wrong, and a wrong
signature fails identically to a wrong key. The SDK is the reference implementation of exactly that.

**The wrapper is what keeps the deviation contained.** `config/cloudinary.js` exports
`upload / destroy / url` functions rather than a configured client, the same shape as the mailer, so
the R2 migration named in [6.media-storage.md](../6.media-storage.md) §3 stays a one-file change.

Under `NODE_ENV=test` it returns a deterministic fake **first and unconditionally**, for the same
reason the mailer does: `env.js` calls `dotenv.config()` on import, so real credentials in `.env` are
visible to the suite whether `.env.test` mentions them or not. Without that guard ahead of
everything, one test touching an upload would write real assets into the real account and nothing
would ever clean them up.

## 5. Schema

Migration `004_create_listings.sql` — `categories` (seeded), `listings`, `listing_photos`. Column
notes: [3.db.md](../3.db.md).

## 6. Client

| Page | Route | Note |
|---|---|---|
| Your listings | `/listings/mine` | **Shows drafts**, which are invisible everywhere else — hide them here and they are unreachable |
| Listing form | `/listings/new`, `/listings/:id/edit` | One component for both: a draft is just an unpublished listing, and two components would be two places to add the next field to |
| Listing detail | `/listings/:id` | Public. Renders for a visitor with no account |

Creating a draft navigates straight to its edit page, because photos cannot be attached until the
listing exists — landing back on an empty form would strand the owner one step short of publishing.

The detail page **says booking is not built yet** rather than showing a disabled Book button, which
would imply the feature exists and is broken.

## 7. What this does NOT do

- **FR-112 is not built and could not be**, and this is worth being precise about. "Changing the rate
  card never alters an already-confirmed booking" is a guarantee a *booking* provides, by copying the
  agreed price into itself when it is confirmed. An owner editing a rate is exactly the event FR-112
  exists to survive — refusing the edit would be the wrong fix, and FR-108 explicitly permits it.
- **FR-110's condition is unenforced.** Deleting a listing is unconditional; there is no bookings
  table to consult. First thing to change at step 6.
- **FR-109's unpublish works**, but "keeps confirmed bookings intact" is untestable until there are
  bookings.
- **FR-114's durations are stored and validated, not enforced.** Nothing yet checks a request against
  them, because nothing yet makes a request.
- **No browse or search.** `GET /listings/:id` is the only public read; there is no list endpoint.
  That is step 5, and the partial indexes in migration 004 are already sized for it.
- **No orphan sweep.** A crash between a successful upload and a failed insert leaves an asset with
  no row. Accepted for V1 — it costs storage and nothing else — and named in
  [6.media-storage.md](../6.media-storage.md) §7.
- **No moderation and no reporting.** A public marketplace where anyone uploads images will receive
  content that should not be there. Real, out of scope, and a deliberate decision rather than a
  discovery.
- **No image dimension minimum.** A 100×80 photo will look terrible in a grid; nothing refuses it.

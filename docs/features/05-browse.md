# 05 — Browse, search and pagination

**FR-300 to FR-310.** Status: **built and tested** — 25 server tests, 24 client tests. FR-303 waits
on availability; the rating halves of FR-306 and FR-310 wait on reviews.

The endpoint that makes a published listing findable. Before this, a listing was visible only to
somebody who already had its URL — which is not a marketplace.

## 0. `/` is home AND browse — deliberately one route

A hero, a "browse by category" tile grid and a "how it works" section now render above this
page's own filter rail and grid (`HomeHero.jsx`, `CategoryShowcase.jsx`, `HowItWorksSection.jsx`,
under `client/src/components/home/`), and they show for every visitor, signed in or not — the
requirement was explicitly "show the home and all listings to new users too", not gate anything
behind an account.

A separate `/browse` route was considered and rejected: it would have touched the header's search
box (`onBrowse = location.pathname === "/"`), the header nav's own "Browse" link, three
"Browse listings" buttons elsewhere in the app, and the post-login redirect — all to solve a
problem a single route already solves. Instead, the marketing section renders **only while
`!hasFilters`** — the moment a search, a category or a shared filtered link is active, it gets out
of the way and the page is exactly the results view it always was. A category tile's `onClick`
calls the exact same `apply({ category: slug })` the filter rail's own `<select>` calls, so it is a
second entry point into one filter state, not a second implementation of filtering.

**One page, two headings, never both `h1`.** The hero has its own `h1` ("Rent almost anything,
nearby."); "Available near you" — the original heading, unchanged in wording — is written by hand
in `HomePage.jsx` rather than handed to `Page`'s own `title` prop (which always renders an
unconditional `h1`), and downgrades to an `h2` for exactly as long as the hero's `h1` is also on the
page. Listing/booking still require an account — that was already true (`RequireAuth` on
`/listings/new` and `/listings/:id/book`), so a signed-out click on "List your item" is bounced to
`/login` and back by the existing guard, with no change needed here.

---

## 1. The shape

```
GET /listings                 public, paginated, filtered
GET /listings/cities          public — the cities that currently have something
GET /listings/categories      public — built at step 3
```

Query parameters, all optional and all validated:

| | |
|---|---|
| `q` | Text search, title and description |
| `category` | Slug |
| `city` | Case-insensitive |
| `unit` | `hourly` / `daily` / `monthly` — defaults to `daily` |
| `minPricePaise`, `maxPricePaise` | Against the chosen unit |
| `sort` | `newest` (default) / `price_asc` / `price_desc` |
| `limit`, `offset` | Defaulted to 24, capped at 48 |

## 2. Two pieces of code finally have a consumer

`validateQuery` was written at step 1 and had no endpoint taking a query string until now. So was
the `req.validatedQuery` convention it depends on — **Express 5 made `req.query` a getter with no
setter**, so the middleware cannot replace it in place, and a handler reading `req.query` would
bypass every default, coercion and cap. That is now exercised rather than merely written.

## 3. The decisions that carry weight

### 3.1 Filter state lives in the URL, not in component state

Everything the browse page shows is derived from the query string. There is no `useState` mirror of
the filters.

Four things follow for free, and each would otherwise be its own bug:

- a filtered view is **shareable**
- it **survives a refresh**
- **back works** — press back after opening a listing and you return to the same page of the same
  filtered result, not to an unfiltered page one
- there is exactly **one source of truth**, so nothing can drift out of sync with anything

The one exception is the search box's draft text, which is local state committed on submit.
Otherwise typing six characters is six requests and six history entries — there is a test asserting
no request fires per keystroke.

### 3.2 `total` comes from the same statement as the page

FR-307 asks for `total` to be counted "with the same WHERE as the page". The implementation goes
one step further and takes it from the **same statement**, via `count(*) OVER ()` — a window
function is evaluated after `WHERE` and before `LIMIT`, so it counts every matching row while the
query returns only this page.

**Sharing a clause relies on discipline; sharing a statement makes disagreement impossible.** The
failure this prevents is silent: a `total` computed from even slightly different conditions gives a
pager that offers a page four which renders empty, and nobody can see why.

The cost is the count repeated on every returned row, which is nothing next to that.

**`created_at DESC` is appended to every ordering as a tiebreaker.** Without it two listings at the
same price have no defined relative order, so the same row can appear on both page one and page two.
That is the classic unstable-pagination bug, and it only shows up once there is enough data to
paginate — there is a test that walks three pages and asserts six distinct ids.

### 3.3 Text search is trigram, not full-text

Postgres full-text search (`to_tsvector`) is the more usual answer and would be wrong here. It
matches whole words after stemming, so "camera" finds "cameras" — but **"cam", "puls" and "eos r"
find nothing at all**. On a marketplace the search box takes partial product names and
half-remembered model numbers, typed a few characters at a time.

`pg_trgm` GIN indexes support `ILIKE '%term%'`, which is exactly that, and turn what would otherwise
be a sequential scan into an index scan.

**What is given up, stated so nobody is surprised:** no stemming, no relevance ranking, no
multi-word term logic. If search quality becomes the product's problem rather than its plumbing,
`tsvector` with a ranked `ORDER BY` is the upgrade and can sit alongside these.

**`%` and `_` in a term are escaped.** Unescaped, a user typing "50% off" gets the entire catalogue
back with no indication why — `%` is a LIKE wildcard. There is a test for it, and it discriminates:
unescaped it would return every row rather than none.

### 3.4 A price filter is per rental unit, and excludes listings without that rate

FR-302. `unit` decides which column both the filter and the price sort act on, and it is
**defaulted rather than optional** so that "cheapest first" always has a defined meaning — without
it, sorting by price with no unit chosen would have to guess between three columns.

A listing with no rate for the chosen unit is **excluded** from a price filter. "Under ₹1000 a day"
cannot sensibly include something priced only by the month, and silently keeping it would make the
filter look broken.

When *sorting* rather than filtering, those listings sink to the bottom via `NULLS LAST`. Postgres
sorts NULLs first on `ASC` by default, which would put every unpriced listing at the head of
"cheapest first".

### 3.5 Nothing unpublished ever appears — FR-309

`status = 'PUBLISHED'` is the **first** condition in the where-builder, before any optional filter,
so it cannot be lost among them.

This is the rule where a mistake leaks somebody's unfinished work to the whole internet, so it is
tested through **every filter separately** rather than once through the default view — a filter
added later could reasonably be written in a way that drops the status condition, and only a test
per filter would catch it.

### 3.6 The city list is derived, not stored

`GET /listings/cities` returns the distinct cities that currently have something published. A fixed
list goes stale in both directions: offering places with nothing to rent, and omitting the one
somebody just listed in.

**FR-304 filters by city, not locality**, and that is a limitation rather than an oversight.
Locality is free text an owner types, so "Kothrud" and "Kothrud, Pune" would be different filter
values. City has the same weakness in principle, but a short derived list is usable in a dropdown
where a long one is not. The real fix is a places lookup table, which is not worth it at this size.

## 4. Indexes

Migration 005. Browse without them is a sequential scan pretending to be a feature.

| Index | For |
|---|---|
| `idx_listings_title_trgm`, `idx_listings_description_trgm` | `ILIKE '%term%'` |
| `idx_listings_city` — partial, on `lower(city)` | the city filter |
| `idx_listings_published` (from 004) | the default newest-first ordering |

Two indexes for search rather than one over `title || ' ' || description`, because an expression
index is only usable when a query names that exact expression. Separate ones let Postgres bitmap-OR
them, and use the title index alone when that is all a query touches.

**Sorting by price is deliberately left without an index.** It would need one partial index per
rental unit, and at this catalogue size the planner sorts the filtered set faster than it would
traverse them. The query is already shaped so adding them later changes nothing but the plan.

## 5. What this does NOT do

- **FR-303, filter by available dates.** Needs step 4's blackouts and step 6's bookings.
- **Sort by rating (FR-306) and show a rating (FR-310).** Need `reviews`, step 9. The detail page
  links to the owner's public profile, which is the buildable half of FR-310.
- **No relevance ranking.** Results are ordered by the chosen sort, so a search for "camera"
  returns the newest camera first, not the best match.
- **No faceted counts.** The filters do not say "Cameras (12)" — that needs a second aggregate
  query per facet, and the value at this size is low.
- **No map, no distance, no geocoding.** Location is an area string; "near me" would need
  coordinates the product deliberately does not collect.
- **Offset pagination, not keyset.** Fine to thousands of rows; `OFFSET 10000` makes Postgres walk
  and discard ten thousand rows. Keyset pagination is the fix if a catalogue ever gets there.

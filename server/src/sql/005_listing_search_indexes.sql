-- 005 — indexes for browse and search
--
-- Step 5. No new tables: this file exists entirely to make the browse query's filters
-- something other than a sequential scan.
--
-- Documented in docs/features/05-browse.md §4. Never edit this file once applied — the
-- runner stores a checksum and will refuse to run.


-- TRIGRAM MATCHING, CHOSEN OVER FULL-TEXT SEARCH, and the reason is what people type.
--
-- Postgres full-text search (`to_tsvector`) is the more usual answer and would be
-- wrong here. It matches whole words after stemming, so "camera" finds "cameras" —
-- good — but "cam", "puls" and "eos r" find nothing at all. On a marketplace the
-- search box is used for partial product names and half-remembered model numbers,
-- typed a few characters at a time.
--
-- Trigram indexes support `ILIKE '%term%'`, which is exactly that behaviour, and turn
-- what would otherwise be a full scan into an index scan.
--
-- What we give up, stated so nobody is surprised: no stemming (searching "bikes" will
-- not match a listing titled "bike" unless the substring happens to align), no
-- relevance ranking, and no multi-word term logic. If search quality ever becomes the
-- product's problem rather than its plumbing, `tsvector` with a ranked ORDER BY is the
-- upgrade — and it can sit alongside these rather than replacing them.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Two indexes rather than one over `title || ' ' || description`, because an
-- expression index is only usable when a query names that exact expression. Separate
-- indexes let Postgres bitmap-OR them for `title ILIKE $1 OR description ILIKE $1`,
-- and let it use the title one alone when that is all a query touches.
--
-- gin_trgm_ops rather than gist: GIN is slower to update and faster to search, which
-- is the right trade for listings that are written once and read constantly.
CREATE INDEX IF NOT EXISTS idx_listings_title_trgm
  ON listings USING gin (title gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_listings_description_trgm
  ON listings USING gin (description gin_trgm_ops);


-- PARTIAL, on lower(city), and every word there is doing something.
--
--   partial      browse only ever reads PUBLISHED rows, so drafts are not carried
--   lower()      the filter compares case-insensitively, and an index on the raw
--                column cannot serve `lower(city) = lower($1)`
CREATE INDEX IF NOT EXISTS idx_listings_city
  ON listings (lower(city))
  WHERE status = 'PUBLISHED';


-- The default browse ordering is newest-first, already served by
-- `idx_listings_published (created_at DESC) WHERE status = 'PUBLISHED'` from 004.
--
-- Sorting by PRICE is deliberately left without its own index for now. It would need
-- one partial index per rental unit — three of them, each `WHERE status = 'PUBLISHED'
-- AND <unit>_rate_paise IS NOT NULL` — and at this catalogue size the planner will sort
-- the filtered set faster than it would traverse them. Revisit when a single city's
-- published listings run into the thousands; the query is already shaped so that
-- adding them changes nothing but the plan.

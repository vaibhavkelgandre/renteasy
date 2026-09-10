-- 007 — blackout dates and the notice period
--
-- Step 4, built after step 6 because five of its seven requirements needed a
-- `bookings` table to mean anything. Documented in docs/features/07-availability.md.
-- Never edit this file once applied — the runner stores a checksum and will refuse.


-- FR-200 — the owner's own "not available" periods.
--
-- A separate table rather than fake bookings, which is the obvious shortcut and is
-- wrong: a booking has a renter, a price and a state machine, none of which a blackout
-- has. Modelling one as the other would mean a nullable renter_id and a status nothing
-- can transition out of, and every booking query would need to remember to exclude
-- them.
CREATE TABLE IF NOT EXISTS availability_blocks (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- CASCADE, unlike `bookings.listing_id` which is RESTRICT. The difference is who
  -- else has a stake: a booking is the other party's record and must outlive the
  -- listing, whereas a blackout is the owner's private note about their own item and
  -- means nothing once the item is gone.
  listing_id uuid NOT NULL REFERENCES listings(id) ON DELETE CASCADE,

  starts_at  timestamptz NOT NULL,
  ends_at    timestamptz NOT NULL,
  CONSTRAINT availability_end_after_start CHECK (ends_at > starts_at),

  -- Same shape and the same `[)` bounds as `bookings.period`, deliberately: the two
  -- are compared against each other constantly, and two different notions of "overlap"
  -- in one product is a bug waiting for a boundary case.
  period     tstzrange GENERATED ALWAYS AS (tstzrange(starts_at, ends_at, '[)')) STORED,

  -- "Lending it to my brother", "servicing". For the owner only — never shown to a
  -- renter, who has no business knowing why an item is unavailable.
  reason     text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Two blackouts on one listing may not overlap. Not a correctness requirement so much
-- as a tidiness one — overlapping blackouts are harmless but make the owner's calendar
-- unreadable, and merging them on read would be more code than forbidding them.
ALTER TABLE availability_blocks DROP CONSTRAINT IF EXISTS availability_blocks_no_overlap;
ALTER TABLE availability_blocks ADD CONSTRAINT availability_blocks_no_overlap
  EXCLUDE USING gist (listing_id WITH =, period WITH &&);

CREATE INDEX IF NOT EXISTS idx_availability_listing
  ON availability_blocks (listing_id, starts_at);


-- FR-203 — the earliest a listing can be booked from, measured in hours from now.
--
-- On the LISTING rather than in its own table: it is a property of the item, not an
-- event in time. "I need a day's notice to fetch it from storage" is the same kind of
-- fact as "the minimum rental is two days", which already lives here.
--
-- Nullable, meaning no notice required — the same convention as the rates and the
-- duration bounds, so a draft is never refused for a field its owner has not reached.
ALTER TABLE listings ADD COLUMN IF NOT EXISTS notice_period_hours integer
  CHECK (notice_period_hours IS NULL OR notice_period_hours >= 0);


-- ============================================================================
-- FR-206 — a blackout may not cover a booking the owner already committed to.
-- ============================================================================
--
-- WHY THIS IS A TRIGGER AND NOT AN EXCLUDE CONSTRAINT, which is the interesting part.
--
-- The double-booking guard in migration 006 is an EXCLUDE, and it is airtight: both
-- rows live in `bookings`, so Postgres can settle the question inside one index.
-- This rule spans TWO tables, and no EXCLUDE can express that. A trigger can.
--
-- BUT IT IS NOT THE SAME STRENGTH OF GUARANTEE, and pretending otherwise would be the
-- worse mistake. Under READ COMMITTED this is classic write skew: one transaction
-- inserts a blackout while another accepts a booking for the same dates, neither sees
-- the other's uncommitted row, and both commit. Closing that needs SERIALIZABLE or an
-- explicit lock on the listing.
--
-- That residual window is accepted here, and the reason is the stakes. A double
-- booking promises one stranger's camera to two people — an obligation the platform
-- cannot honour. An overlapping blackout is the owner contradicting their own
-- calendar, visible to them, fixable by them, and harming nobody else. Paying for
-- SERIALIZABLE across the whole booking path to close it would be the wrong trade.
--
-- The trigger still earns its place: it makes the rule impossible to skip from a code
-- path nobody has written yet, which a service-layer check does not.
CREATE OR REPLACE FUNCTION availability_blocks_respect_bookings() RETURNS trigger AS $$
DECLARE
  clash record;
BEGIN
  SELECT b.starts_at, b.ends_at INTO clash
    FROM bookings b
   WHERE b.listing_id = NEW.listing_id
     AND b.status IN ('ACCEPTED', 'ACTIVE')
     AND b.period && NEW.period
   LIMIT 1;

  IF FOUND THEN
    -- The dates are named because the owner can see that booking in their own list,
    -- and a refusal that will not say which one just produces a second attempt.
    RAISE EXCEPTION
      'blackout overlaps a confirmed booking from % to %', clash.starts_at, clash.ends_at
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- AFTER, NOT BEFORE, AND THAT IS NOT A STYLE CHOICE.
--
-- `period` is a STORED GENERATED column, and Postgres computes those AFTER row-level
-- BEFORE triggers have run. In a BEFORE trigger `NEW.period` is therefore NULL, and
-- `b.period && NULL` evaluates to NULL — which is not true, so the guard silently
-- matched nothing and every blackout was allowed.
--
-- It failed open, which is the worst way for a guard to fail: the first version of
-- this shipped looking correct, and only a test that actually attempted the overlap
-- found it.
--
-- An AFTER trigger sees the computed value. The row is inserted first and the
-- exception rolls it back, which for a validation trigger is equivalent — and it
-- avoids re-deriving `tstzrange(starts_at, ends_at, '[)')` in a second place, where
-- it could drift from the column's own definition.
DROP TRIGGER IF EXISTS availability_blocks_vs_bookings ON availability_blocks;
CREATE TRIGGER availability_blocks_vs_bookings
  AFTER INSERT OR UPDATE ON availability_blocks
  FOR EACH ROW EXECUTE FUNCTION availability_blocks_respect_bookings();

-- 006 — bookings, the double-booking guard, and an append-only trail
--
-- Step 6. Documented in docs/features/06-bookings.md §5. Never edit this file once
-- applied — the runner stores a checksum and will refuse to run.


-- Needed so one EXCLUDE constraint can mix an equality test on a uuid with an overlap
-- test on a range. GiST alone has no operator class for uuid `=`; btree_gist adds it.
-- Without this the constraint below fails with "data type uuid has no default operator
-- class for access method gist".
CREATE EXTENSION IF NOT EXISTS btree_gist;


CREATE TABLE IF NOT EXISTS bookings (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- RESTRICT, not CASCADE, and it is doing real work: it makes deleting a listing that
  -- has ever been booked impossible at the database level. See the note at the foot of
  -- this file — it is a deliberate tightening of FR-110.
  listing_id uuid NOT NULL REFERENCES listings(id) ON DELETE RESTRICT,

  -- RESTRICT here too. Account deletion is soft (migration 003), so this will rarely
  -- fire; it exists so a hard delete cannot silently erase the other party's history.
  renter_id  uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,

  starts_at  timestamptz NOT NULL,
  ends_at    timestamptz NOT NULL,
  CONSTRAINT bookings_end_after_start CHECK (ends_at > starts_at),

  -- THE PERIOD AS A RANGE, generated rather than maintained.
  --
  -- A stored generated column, so it can never disagree with the two timestamps it is
  -- derived from — a trigger or application code writing this would eventually let
  -- them drift, and the drift would show up as a booking that overlaps another while
  -- the constraint says otherwise.
  --
  -- `[)` — inclusive start, EXCLUSIVE end — is the load-bearing detail. A booking
  -- ending at 10:00 and another starting at 10:00 do not overlap, which is exactly
  -- what handover means: one renter hands the camera back and the next takes it. With
  -- `[]` every back-to-back rental in the product would be refused as a clash.
  period     tstzrange GENERATED ALWAYS AS (tstzrange(starts_at, ends_at, '[)')) STORED,

  -- FR-505. REQUESTED → ACCEPTED → ACTIVE → RETURNED → COMPLETED, plus three exits.
  -- The legal moves live in ONE place in the application (bookingStateMachine.js); this
  -- CHECK only says which names exist, not which transitions are allowed — a CHECK
  -- cannot see the previous value.
  status     text NOT NULL DEFAULT 'REQUESTED'
               CHECK (status IN ('REQUESTED', 'ACCEPTED', 'ACTIVE', 'RETURNED',
                                 'COMPLETED', 'DECLINED', 'CANCELLED', 'EXPIRED')),

  -- THE PRICE, FROZEN AT REQUEST TIME — this is what makes FR-112 true.
  --
  -- "Changing the rate card never alters an already-confirmed booking" cannot be
  -- enforced by refusing the owner's edit; FR-108 explicitly permits it. It is enforced
  -- by the booking carrying its own copy of every figure, so a later edit to
  -- `listings` has nothing to reach.
  --
  -- Integer paise throughout. A float in a money path is a bug.
  rent_paise            integer NOT NULL CHECK (rent_paise >= 0),
  tax_paise             integer NOT NULL DEFAULT 0 CHECK (tax_paise >= 0),
  deposit_paise         integer NOT NULL DEFAULT 0 CHECK (deposit_paise >= 0),
  commission_paise      integer NOT NULL DEFAULT 0 CHECK (commission_paise >= 0),
  renter_total_paise    integer NOT NULL CHECK (renter_total_paise >= 0),
  owner_payout_paise    integer NOT NULL CHECK (owner_payout_paise >= 0),

  -- The itemised breakdown exactly as quoted — "1 month × ₹15,000, 10 days × ₹800".
  -- Stored rather than recomputed because recomputation would use today's rates, which
  -- is the very thing FR-112 forbids. jsonb because it is a snapshot to display, never
  -- something to query or join on.
  quote_lines           jsonb NOT NULL,

  -- Why the renter wanted it, and what the owner said when accepting or declining.
  renter_message        text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);


-- ============================================================================
-- FR-202 / FR-514 — TWO CONFIRMED BOOKINGS CAN NEVER OVERLAP.
-- ============================================================================
--
-- The single most important line in this schema, and the reason it is a database
-- constraint rather than an application check.
--
-- An application check reads "is there an overlapping booking?" and then inserts. Two
-- requests arriving in the same millisecond both read "no" and both insert, and the
-- camera is promised to two people. No amount of care in the service prevents that;
-- the gap between the read and the write is where the bug lives. Serialising it in the
-- application means a lock, which means remembering to take the lock on every future
-- path that writes a booking.
--
-- An EXCLUDE constraint moves the question into the one place that can answer it
-- atomically. Postgres refuses the second insert itself, whatever order the requests
-- arrive in and however many there are. FR-514's "20 concurrent requests produce
-- exactly one confirmed booking" is not something the application achieves — it is
-- something it cannot prevent.
--
-- WHERE (status IN ('ACCEPTED', 'ACTIVE')) — a PARTIAL constraint, and the choice of
-- statuses is the product decision:
--
--   REQUESTED   does NOT block. Several people may ask for the same dates; the owner
--               picks one. Blocking here would make the first request win by speed
--               rather than the owner choosing, which is not what a request means.
--   ACCEPTED    blocks. The owner has committed.
--   ACTIVE      blocks. The renter physically has the item.
--   RETURNED    does not block — the item is back, even if the booking is not closed.
--   COMPLETED / DECLINED / CANCELLED / EXPIRED
--               do not block. Nothing is held.
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_no_double_booking;
ALTER TABLE bookings ADD CONSTRAINT bookings_no_double_booking
  EXCLUDE USING gist (
    listing_id WITH =,
    period     WITH &&
  ) WHERE (status IN ('ACCEPTED', 'ACTIVE'));


-- FR-513: a renter's own bookings, newest first.
CREATE INDEX IF NOT EXISTS idx_bookings_renter ON bookings (renter_id, created_at DESC);

-- FR-513 from the other side: bookings on a listing. Also serves the overlap PRE-check
-- the service runs to produce a friendly refusal before the constraint fires.
CREATE INDEX IF NOT EXISTS idx_bookings_listing ON bookings (listing_id, starts_at);

-- FR-508's expiry sweep: find REQUESTED bookings older than N hours.
CREATE INDEX IF NOT EXISTS idx_bookings_pending
  ON bookings (created_at)
  WHERE status = 'REQUESTED';


-- ============================================================================
-- FR-511 — every state change, append-only.
-- ============================================================================
CREATE TABLE IF NOT EXISTS booking_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id  uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,

  -- NULLABLE, deliberately: an expiry has no actor. Recording the owner or the renter
  -- as having expired a request would put a false action in a trail whose whole value
  -- is that it is true.
  actor_id    uuid REFERENCES users(id) ON DELETE SET NULL,

  -- NULL on the first event, where there is no previous status.
  from_status text,
  to_status   text NOT NULL,
  comment     text,

  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_booking_events_booking
  ON booking_events (booking_id, created_at);

-- APPEND-ONLY, ENFORCED RATHER THAN ASKED FOR.
--
-- "The trail is append-only and never edited" is worth nothing as a convention: the
-- one time somebody fixes a typo in a comment with an UPDATE, the trail stops being
-- evidence of anything. A trigger makes it a property of the table instead, so the
-- guarantee survives code nobody has written yet.
CREATE OR REPLACE FUNCTION booking_events_are_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'booking_events is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS booking_events_no_update ON booking_events;
CREATE TRIGGER booking_events_no_update
  BEFORE UPDATE OR DELETE ON booking_events
  FOR EACH ROW EXECUTE FUNCTION booking_events_are_append_only();


-- ----------------------------------------------------------------------------
-- A NOTE ON FR-110, because this file changes it.
--
-- FR-110 says a listing may be deleted "only when no active or upcoming booking
-- exists", which implies one with only old, completed bookings could still be deleted.
-- `ON DELETE RESTRICT` above is stricter: a listing that has EVER been booked cannot be
-- deleted at all.
--
-- That is deliberate. A completed booking is the other party's record of what they
-- rented and what they paid, and they are entitled to it — the same reasoning that
-- makes account deletion soft. Deleting the listing out from under it would leave a
-- receipt referring to nothing.
--
-- The owner's remedy is to UNPUBLISH, which already exists and already hides it from
-- browse. The service turns the resulting foreign-key violation into a 409 explaining
-- that, rather than letting a 23503 surface as a 500.
-- ----------------------------------------------------------------------------

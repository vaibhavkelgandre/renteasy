-- 008 — handover, return, and the evidence for both
--
-- Step 8, FR-700 to FR-704 and FR-708. Documented in docs/features/08-handover.md.
-- Never edit this file once applied — the runner stores a checksum and will refuse.


-- ============================================================================
-- FR-700 / FR-701 — a new state, because handover has two sides.
-- ============================================================================
--
-- THE SYMMETRY IS THE DESIGN. Read literally, FR-700 says the owner's action makes a
-- booking ACTIVE, which leaves FR-701's "renter confirms receipt" doing nothing at
-- all. The return side already works the other way round — the renter says it is
-- back (FR-703) and the OWNER's confirmation is what completes it (FR-704) — so
-- handover is modelled the same way round:
--
--   ACCEPTED     --START (owner)-----------> HANDED_OVER
--   HANDED_OVER  --CONFIRM_RECEIPT (renter)-> ACTIVE
--   ACTIVE       --RETURN (renter)---------> RETURNED
--   RETURNED     --COMPLETE (owner)--------> COMPLETED
--
-- In both halves the party RECEIVING the item is the one whose confirmation advances
-- the state, and the party handing it over can only assert. That is what makes
-- "you have my camera" a fact both people agreed to rather than one person's claim,
-- which is the whole value of the record if it later goes wrong.
--
-- HANDED_OVER and RETURNED are therefore the same shape mirrored: asserted by one
-- side, awaiting the other.
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_status_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_status_check
  CHECK (status IN ('REQUESTED', 'ACCEPTED', 'HANDED_OVER', 'ACTIVE', 'RETURNED',
                    'COMPLETED', 'DECLINED', 'CANCELLED', 'EXPIRED'));


-- ============================================================================
-- THE DOUBLE-BOOKING GUARD HAS TO LEARN THE NEW STATE. THIS IS THE DANGEROUS PART.
-- ============================================================================
--
-- Migration 006's exclusion constraint is PARTIAL — `WHERE status IN (...)` — so a
-- status it does not name holds no dates at all. Adding HANDED_OVER to the state
-- machine without adding it here would mean a booking whose item is physically in
-- somebody's hands stops blocking its own dates, and the listing could be accepted
-- for the same weekend by somebody else. The failure is silent: nothing errors, the
-- second booking simply succeeds.
--
-- The list must therefore be re-stated in full, and it is re-stated deliberately
-- rather than patched, so the whole rule is readable here:
--
--   REQUESTED    does NOT block. Several people may ask for the same dates; the
--                owner picks one.
--   ACCEPTED     blocks. The owner has committed.
--   HANDED_OVER  blocks. The owner says it has gone out, even if the renter has not
--                yet confirmed. An unconfirmed handover is not a free item.
--   ACTIVE       blocks. The renter physically has it.
--   RETURNED     does NOT block, and this is a real decision rather than an
--                oversight. The item is back. If a renter returns a camera three days
--                early, those three days are genuinely available and there is no
--                reason to keep refusing them — the booking's own `period` still runs
--                to `ends_at`, so leaving RETURNED in the list would hold dates
--                against an item sitting on the owner's shelf.
--   COMPLETED / DECLINED / CANCELLED / EXPIRED
--                do not block. Nothing is held.
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_no_double_booking;
ALTER TABLE bookings ADD CONSTRAINT bookings_no_double_booking
  EXCLUDE USING gist (
    listing_id WITH =,
    period     WITH &&
  ) WHERE (status IN ('ACCEPTED', 'HANDED_OVER', 'ACTIVE'));


-- FR-708's two sweeps look for bookings sitting in a state waiting on somebody:
-- HANDED_OVER awaiting a renter's confirmation, RETURNED awaiting an owner's. Both
-- ask "which of these is older than N hours", which is this index.
CREATE INDEX IF NOT EXISTS idx_bookings_awaiting_confirmation
  ON bookings (status, updated_at)
  WHERE status IN ('HANDED_OVER', 'RETURNED');


-- ============================================================================
-- FR-702 — condition photos, by both parties, at both ends.
-- ============================================================================
--
-- ONE TABLE FOR BOTH ENDS, with a `phase`, rather than a handover table and a return
-- table. The rows are identical in every respect except which moment they describe,
-- and two tables would mean two upload paths, two proxies and two chances for one of
-- them to be the one that forgets to check who is asking.
--
-- PRIVATE STORAGE, NOT THE LISTING PIPELINE. A listing photo is `type: "upload"` and
-- world-readable — right for a shop window. These are taken wherever an item changes
-- hands, so they show the inside of somebody's home, a number plate, a doorway. They
-- go to `type: "authenticated"` and are served by a proxy that checks the caller is
-- one of the two parties; the signed URL never reaches the browser.
CREATE TABLE IF NOT EXISTS booking_photos (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- CASCADE: a photograph of a handover has no meaning once the booking it evidences
  -- is gone. Note that `bookings` itself is RESTRICT from `listings`, so this cascade
  -- is effectively unreachable — which is the point. Nothing deletes a booking today.
  booking_id uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,

  phase      text NOT NULL CHECK (phase IN ('HANDOVER', 'RETURN')),

  -- WHO TOOK IT, not which role they held. A role is derived from the booking and
  -- would be a second copy of a fact `bookings` already owns; an id survives the
  -- same person being an owner on one booking and a renter on the next.
  --
  -- SET NULL rather than CASCADE, matching booking_events: deleting a user must not
  -- erase the evidence, only the attribution.
  uploaded_by uuid REFERENCES users(id) ON DELETE SET NULL,

  -- The provider's own identifier. NEVER a URL — the same rule as listing_photos, and
  -- more so here: these URLs are signed and expire, so a stored one would be a stored
  -- dead link.
  storage_id text NOT NULL,
  provider   text NOT NULL DEFAULT 'CLOUDINARY',

  width      integer NOT NULL,
  height     integer NOT NULL,
  bytes      integer NOT NULL,
  mime_type  text NOT NULL,

  -- The uploader's own note: "scratch on the lens barrel", "returned with a full
  -- tank". Optional, and the reason the photo alone is not always enough.
  note       text,

  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_booking_photos_booking
  ON booking_photos (booking_id, phase, created_at);


-- APPEND-ONLY, FOR THE SAME REASON booking_events IS.
--
-- This is evidence in a disagreement between two people about the condition of
-- something. Evidence that either of them can quietly delete or replace after the
-- fact is not evidence — and the tempting exception, "let them remove one uploaded by
-- mistake", is exactly the hole: "by mistake" is indistinguishable from "because it
-- showed the scratch".
--
-- The cost is accepted: a genuinely wrong photo stays, and the remedy is to upload
-- another one with a note. A trail you can prune is a trail nobody can rely on.
CREATE OR REPLACE FUNCTION booking_photos_are_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'booking_photos is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS booking_photos_no_update ON booking_photos;
CREATE TRIGGER booking_photos_no_update
  BEFORE UPDATE OR DELETE ON booking_photos
  FOR EACH ROW EXECUTE FUNCTION booking_photos_are_append_only();


-- ============================================================================
-- FR-206's trigger has to learn HANDED_OVER too, and missing it would fail OPEN.
-- ============================================================================
--
-- Migration 007 checks a new blackout against `b.status IN ('ACCEPTED', 'ACTIVE')`.
-- With a third dates-holding status that list is now wrong in the worst direction:
-- an owner could black out dates over a booking whose item is already in somebody's
-- hands, and nothing would object. The guard would not error — it would simply match
-- nothing, which is the same failure mode the BEFORE/AFTER bug in 007 had.
--
-- The function is REPLACED rather than 007 edited: 007 is applied elsewhere and a
-- migration is never edited once that is true. `CREATE OR REPLACE` on the function
-- leaves the existing trigger pointing at the new body, so no trigger change is
-- needed — only the logic it calls.
--
-- THIS LIST AND `DATES_HELD_STATUSES` IN bookingStateMachine.js MUST AGREE. A
-- constraint cannot read application code, so the duplication is unavoidable here —
-- what closes it is a test that reads the exclusion constraint back out of the
-- database and compares it against that array.
CREATE OR REPLACE FUNCTION availability_blocks_respect_bookings() RETURNS trigger AS $$
DECLARE
  clash record;
BEGIN
  SELECT b.starts_at, b.ends_at INTO clash
    FROM bookings b
   WHERE b.listing_id = NEW.listing_id
     AND b.status IN ('ACCEPTED', 'HANDED_OVER', 'ACTIVE')
     AND b.period && NEW.period
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'blackout overlaps a confirmed booking from % to %', clash.starts_at, clash.ends_at
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

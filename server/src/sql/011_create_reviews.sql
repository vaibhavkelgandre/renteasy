-- 011 — two-way reviews
--
-- FR-800 to FR-808. Documented in docs/features/11-reviews.md.
-- Never edit this file once applied — the runner stores a checksum and will refuse.


-- ============================================================================
-- FR-800, FR-801, FR-802 — one review per person per completed booking.
-- ============================================================================
CREATE TABLE IF NOT EXISTS reviews (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- RESTRICT, not CASCADE, unlike messages and photos. A review outlives the
  -- transaction it came from — it is the reputation the other party carries into
  -- their next rental — whereas a chat about pickup times means nothing without its
  -- booking. Nothing deletes a booking today, so this is a statement of intent as
  -- much as a constraint.
  booking_id  uuid NOT NULL REFERENCES bookings(id) ON DELETE RESTRICT,

  -- SET NULL on both, matching booking_events: deleting an account must not erase
  -- what other people said, nor what they were told about somebody.
  author_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  subject_id  uuid REFERENCES users(id) ON DELETE SET NULL,

  -- WHICH HAT THE SUBJECT WAS WEARING. Being reliable to lend to says very little
  -- about being reliable to lend TO, and a single blended number would quietly
  -- average the two — so the aggregates are kept apart and this is what separates
  -- them. Derivable from the booking, but stored because every aggregate query
  -- would otherwise have to join back to `listings` to work out who owned what.
  direction   text NOT NULL CHECK (direction IN ('OF_OWNER', 'OF_RENTER')),

  rating      integer NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body        text CHECK (body IS NULL OR length(body) <= 2000),

  -- ============================================================================
  -- FR-804 — blind until both have written, or the window closes.
  -- ============================================================================
  --
  -- NULL means written but not yet visible to anybody except its author. Without
  -- this, the second review is a REPLY to the first: you read that they called you
  -- difficult, and you mark them down for it. Neither number then measures the
  -- rental.
  --
  -- A timestamp rather than a boolean, because "when did this become public"
  -- is a question the 48-hour edit rule needs answered and a boolean cannot.
  published_at timestamptz,

  -- FR-808 — one public reply, by the subject. Columns rather than a table: there
  -- can only ever be one, and its author is already known by definition, so a
  -- separate table would be a row with a foreign key and nothing else.
  reply_body  text CHECK (reply_body IS NULL OR length(reply_body) <= 2000),
  reply_at    timestamptz,

  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  -- FR-802. One per person per booking — and because each booking has exactly two
  -- parties and each may write about the other once, this IS "one per direction"
  -- without needing to name the direction in the key.
  CONSTRAINT uq_review_per_author_per_booking UNIQUE (booking_id, author_id),

  -- A reply has a body and a time, or neither. Half of one is a row that renders
  -- as an empty reply nobody wrote.
  CONSTRAINT reviews_reply_is_whole
    CHECK ((reply_body IS NULL) = (reply_at IS NULL))
);


-- FR-806 / FR-033: somebody's rating, by direction. Partial on `published_at`
-- because an unpublished review counts towards nothing — it is not yet a fact
-- about anybody.
CREATE INDEX IF NOT EXISTS idx_reviews_subject
  ON reviews (subject_id, direction)
  WHERE published_at IS NOT NULL;

-- FR-806's other half: a listing's rating is the average of what its renters said
-- about its owner, so the aggregate is reached through the booking.
CREATE INDEX IF NOT EXISTS idx_reviews_booking ON reviews (booking_id);

-- The publishing sweep asks "which unpublished reviews are past their window", and
-- a partial index on the rows that are still pending stays permanently small.
CREATE INDEX IF NOT EXISTS idx_reviews_unpublished
  ON reviews (created_at)
  WHERE published_at IS NULL;


-- ============================================================================
-- FR-805 — never deletable by its author.
-- ============================================================================
--
-- NOT the append-only trigger used by booking_events, booking_photos and
-- booking_messages, and the difference is deliberate. A review is EDITABLE for 48
-- hours (FR-805), it gets published later, and it can gain a reply — so UPDATE is
-- part of its normal life in a way it is not for an audit trail.
--
-- What must never happen is deletion. A reputation somebody can erase after the
-- fact by deleting the bad ones is not a reputation, and "let them remove one left
-- by mistake" is indistinguishable from "remove the one that was deserved".
--
-- The 48-hour and blind-period rules are enforced in the service rather than here,
-- because both depend on clock arithmetic against other rows. This trigger covers
-- the one rule that is absolute.
CREATE OR REPLACE FUNCTION reviews_are_never_deleted() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'reviews cannot be deleted';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS reviews_no_delete ON reviews;
CREATE TRIGGER reviews_no_delete
  BEFORE DELETE ON reviews
  FOR EACH ROW EXECUTE FUNCTION reviews_are_never_deleted();


-- ============================================================================
-- Two new notification types.
-- ============================================================================
--
-- THE LIST WAS READ OUT OF THE DATABASE, NOT COPIED FROM 010 — there is no ADD
-- VALUE for a CHECK constraint, so every migration adding a type re-states the
-- whole list, and copying an ancestor silently deletes everything added between.
-- The failure is invisible, because `notify()` swallows its own errors by design.
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN (
    'BOOKING_REQUESTED',
    'BOOKING_ACCEPTED',
    'BOOKING_DECLINED',
    'BOOKING_CANCELLED',
    'BOOKING_CANCELLED_BY_OWNER',
    'BOOKING_EXPIRED',
    'BOOKING_HANDED_OVER',
    'BOOKING_RECEIPT_CONFIRMED',
    'BOOKING_RETURNED',
    'BOOKING_COMPLETED',
    'BOOKING_MESSAGE',
    -- "You can now review each other" — sent when a booking completes.
    'REVIEW_INVITED',
    -- "Your review is now visible, and so is theirs" — sent when the blind period
    -- ends, which is the moment either party can finally read what was written.
    'REVIEW_PUBLISHED'
  ));

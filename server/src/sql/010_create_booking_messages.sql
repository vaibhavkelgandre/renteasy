-- 010 — messages between the two parties to a booking
--
-- Documented in docs/features/10-messaging.md.
-- Never edit this file once applied — the runner stores a checksum and will refuse.


-- ============================================================================
-- NO `conversations` TABLE, AND THAT IS THE DESIGN.
-- ============================================================================
--
-- Chat opens when a booking is REQUESTED, never before — so there is exactly one
-- thread per booking, for its two parties, forever. A `conversations` table would
-- therefore be 1:1 with `bookings`, carrying no fact that `bookings` does not already
-- hold: the listing, the renter, the owner, when it started.
--
-- THE BOOKING IS THE CONVERSATION. Messages reference it directly.
--
-- The authorization comes free with that. `loadBookingForParty` already answers "is
-- this caller one of the two parties, and 404 if not" for every booking endpoint, so
-- messaging inherits the exact rule the rest of the booking surface uses rather than
-- growing a second one that could drift from it.
CREATE TABLE IF NOT EXISTS booking_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  booking_id  uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,

  -- SET NULL rather than CASCADE, matching booking_events and booking_photos:
  -- deleting a user must not erase what was said, only who said it. A NULL sender is
  -- also how a SYSTEM message is written — nobody said it.
  sender_id   uuid REFERENCES users(id) ON DELETE SET NULL,

  kind        text NOT NULL DEFAULT 'TEXT'
                CHECK (kind IN ('TEXT', 'IMAGE', 'DOCUMENT', 'CONTACT_SHARED', 'SYSTEM')),

  body        text,

  -- Attachments reuse the PRIVATE pipeline from migration 008's condition photos.
  -- A photograph sent in a chat is exactly as sensitive as one taken at handover —
  -- the inside of a home, a number plate, a document — so it is `type: authenticated`
  -- and served by the proxy. Never a URL here: these are signed and expire, so a
  -- stored one would be a stored dead link.
  storage_id  text,
  mime_type   text,
  bytes       integer,

  created_at  timestamptz NOT NULL DEFAULT now(),

  -- A message says something or carries something. Both is fine (a photo with a
  -- caption); neither is a bug that would render as an empty bubble.
  CONSTRAINT booking_messages_have_content
    CHECK (body IS NOT NULL OR storage_id IS NOT NULL),

  -- An attachment kind without an attachment is the same bug one level down.
  CONSTRAINT booking_messages_attachments_have_storage
    CHECK (kind NOT IN ('IMAGE', 'DOCUMENT') OR storage_id IS NOT NULL)
);

-- The thread, oldest first, and the `?since=` poll. Both read by this index.
CREATE INDEX IF NOT EXISTS idx_booking_messages_thread
  ON booking_messages (booking_id, created_at);


-- APPEND-ONLY, like booking_events and booking_photos.
--
-- Half the reason to keep a conversation on the platform at all is that it is
-- evidence when the two parties later disagree about what was agreed. A thread
-- either of them can edit or delete after the fact is not evidence.
--
-- THIS IS WHY READ STATE IS A SEPARATE TABLE. The obvious design puts `read_at` on
-- the message and updates it — which means the table cannot be append-only, and the
-- trigger would have to permit UPDATE and then police which columns changed. A
-- per-party watermark avoids the exception entirely, and is O(1) to update rather
-- than one row per message read.
CREATE OR REPLACE FUNCTION booking_messages_are_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'booking_messages is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS booking_messages_no_update ON booking_messages;
CREATE TRIGGER booking_messages_no_update
  BEFORE UPDATE OR DELETE ON booking_messages
  FOR EACH ROW EXECUTE FUNCTION booking_messages_are_append_only();


-- ============================================================================
-- Read state — one watermark per party per thread.
-- ============================================================================
--
-- "Unread" is then everything in the thread after my watermark that I did not send.
-- Two rows per booking at most, updated in place, and the messages stay immutable.
CREATE TABLE IF NOT EXISTS booking_message_reads (
  booking_id   uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (booking_id, user_id)
);


-- ============================================================================
-- Reports — because strangers can now send each other images.
-- ============================================================================
--
-- ⚠️ NOTHING READS THIS YET. There is no admin surface in this application, so a
-- report lands here and waits for a human with database access.
--
-- Built anyway, and deliberately: the alternative to a report button that stores
-- something is no report button at all, on a channel between strangers that carries
-- photographs. A durable row loses nothing when the review screen is eventually
-- built; a missing one cannot be reconstructed.
CREATE TABLE IF NOT EXISTS booking_message_reports (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id  uuid NOT NULL REFERENCES booking_messages(id) ON DELETE CASCADE,
  reported_by uuid REFERENCES users(id) ON DELETE SET NULL,
  reason      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),

  -- One report per person per message. A second press of the button is not a
  -- stronger complaint, and without this it would read as two.
  CONSTRAINT uq_message_report_per_person UNIQUE (message_id, reported_by)
);


-- ============================================================================
-- A new notification type.
-- ============================================================================
--
-- THE LIST BELOW WAS READ OUT OF THE DATABASE, NOT COPIED FROM 009. There is no
-- ADD VALUE for a CHECK constraint, so every migration that adds a type must
-- re-state the whole list — and copying an older ancestor's version silently deletes
-- every value added in between. The failure is invisible: `notify()` swallows its own
-- errors by design (FR-985), so a type the constraint no longer accepts just stops
-- producing notifications while the action it hangs off still answers 200.
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
    'BOOKING_MESSAGE'
  ));

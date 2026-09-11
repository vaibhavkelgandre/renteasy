-- 009 — in-app notifications
--
-- FR-985, FR-986. Documented in docs/features/09-notifications.md.
-- Never edit this file once applied — the runner stores a checksum and will refuse.


-- ============================================================================
-- ONE ROW PER RECIPIENT. NEVER A BROADCAST ROW.
-- ============================================================================
--
-- The tempting shape is one row per event with a join table, or a row carrying a
-- list of recipients. Both break on the same thing: "read" is per-person. A shared
-- row cannot be read by one party and unread by the other, and bolting a
-- `notification_reads` table onto it to fix that is strictly more machinery than
-- just writing two rows in the first place.
--
-- Two rows per event is also the honest model here. This is a two-sided marketplace:
-- the owner and the renter are told DIFFERENT things about the same transition, not
-- the same thing twice.
CREATE TABLE IF NOT EXISTS notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- CASCADE. A notification exists to be read by one person, and has no meaning
  -- without them — unlike a booking, which is the other party's record too. Account
  -- deletion is soft here anyway, so this rarely fires.
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- WHAT HAPPENED, not who is being told. The recipient is `user_id`; encoding the
  -- audience in the type as well would double the list and make "did the right
  -- person get this?" a question about naming rather than about the row.
  type        text NOT NULL CHECK (type IN (
                'BOOKING_REQUESTED',
                'BOOKING_ACCEPTED',
                'BOOKING_DECLINED',
                'BOOKING_CANCELLED',
                'BOOKING_CANCELLED_BY_OWNER',
                'BOOKING_EXPIRED',
                'BOOKING_HANDED_OVER',
                'BOOKING_RECEIPT_CONFIRMED',
                'BOOKING_RETURNED',
                'BOOKING_COMPLETED'
              )),

  -- What to open when it is clicked. `entity_type` rather than a stored path, because
  -- a URL is a client concern and baking one into a database row makes changing a
  -- route a data migration — the same reasoning as `listing_photos.storage_id`.
  entity_type text NOT NULL CHECK (entity_type IN ('BOOKING', 'LISTING')),
  entity_id   uuid NOT NULL,

  -- THE SENTENCE, STORED.
  --
  -- The alternative — store a type plus parameters and compose the text on read —
  -- was considered and rejected for this product. A notification is a record of what
  -- somebody was actually told, and re-rendering an old one through today's wording
  -- can make it describe a state the booking is no longer in.
  --
  -- The cost is real and accepted: fixing a typo does not reach rows already written,
  -- and translating the interface later would need this reconsidered. Both are
  -- better problems than a notification that quietly changes what it said.
  message     text NOT NULL,

  -- NULL means unread. A nullable timestamp rather than a boolean plus a timestamp:
  -- two columns that must agree is one more thing that can disagree, and "when did
  -- they read it" is a question a boolean cannot answer at all.
  read_at     timestamptz,

  created_at  timestamptz NOT NULL DEFAULT now()
);


-- The list, newest first — the only order this is ever read in.
CREATE INDEX IF NOT EXISTS idx_notifications_user
  ON notifications (user_id, created_at DESC);

-- THE UNREAD COUNT, AND IT IS PARTIAL FOR A REASON.
--
-- This count is polled by the header on every page, for every signed-in user, for as
-- long as the tab is open. It is the single most frequently executed query in the
-- product. A partial index contains only the unread rows, so it stays small
-- permanently — a full index on (user_id, read_at) would grow with every
-- notification ever sent, while the thing being counted is almost always a handful.
CREATE INDEX IF NOT EXISTS idx_notifications_unread
  ON notifications (user_id)
  WHERE read_at IS NULL;

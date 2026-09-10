-- 004 — categories, listings and listing photos
--
-- Step 3. Documented in docs/features/04-listings.md §5 and docs/3.db.md. Never edit
-- this file once applied — the runner stores a checksum and will refuse to run.


-- FR-102 — A LOOKUP TABLE, NOT A CHECK CONSTRAINT.
--
-- The project convention, and the reason is mechanical rather than stylistic: there is
-- no `ADD VALUE` for a CHECK. Every change re-declares the whole list, so adding
-- "drone" means retyping twenty categories and the one you forget disappears silently.
-- A category list is exactly the kind that grows with use.
--
-- It also lets a category be RETIRED (`is_active = false`) without breaking the
-- listings that already reference it — a CHECK removal would make those rows invalid.
CREATE TABLE IF NOT EXISTS categories (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The stable identifier: used in URLs and filters, and safe to rely on in code.
  -- `name` is display text and may be reworded at any time.
  slug       text NOT NULL UNIQUE,
  name       text NOT NULL,

  -- Display order is editorial, not alphabetical — the categories people actually
  -- browse should come first.
  sort_order integer NOT NULL DEFAULT 0,
  is_active  boolean NOT NULL DEFAULT true,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO categories (slug, name, sort_order) VALUES
  ('cameras',      'Cameras & photography', 10),
  ('bikes',        'Bikes & scooters',      20),
  ('tools',        'Tools & DIY',           30),
  ('appliances',   'Home appliances',       40),
  ('electronics',  'Electronics',           50),
  ('audio',        'Audio & music',         60),
  ('camping',      'Camping & outdoors',    70),
  ('party',        'Party & events',        80),
  ('sports',       'Sports & fitness',      90),
  ('other',        'Something else',       999)
ON CONFLICT (slug) DO NOTHING;


CREATE TABLE IF NOT EXISTS listings (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- CASCADE, but note it will rarely fire: account deletion is SOFT (migration 003),
  -- so the row survives and so do its listings. That is deliberate — a booking's
  -- counterparty is entitled to see what they rented. This exists for a genuine hard
  -- delete, which today only happens in tests.
  owner_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- RESTRICT, not CASCADE: deleting a category must never silently delete somebody's
  -- listings. Retiring one is `is_active = false`, which leaves these rows alone.
  category_id  uuid NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,

  title        text NOT NULL,
  description  text NOT NULL,

  -- A CHECK here rather than a lookup table, and the distinction from `categories` is
  -- the point: this list is CLOSED. It is tied to wording in the UI and in the product
  -- decision about what "condition" means, and it does not grow with use.
  condition    text NOT NULL CHECK (condition IN ('NEW', 'LIKE_NEW', 'GOOD', 'FAIR')),

  -- FR-100 / FR-109. Three states, not a boolean:
  --   DRAFT       never been visible; still being written
  --   PUBLISHED   visible in browse
  --   UNPUBLISHED was visible, taken down; confirmed bookings survive it
  -- A boolean `is_published` cannot tell the first from the third, and they differ:
  -- an unpublished listing has a history and possibly live bookings, a draft does not.
  status       text NOT NULL DEFAULT 'DRAFT'
                 CHECK (status IN ('DRAFT', 'PUBLISHED', 'UNPUBLISHED')),

  -- FR-103 — THE RATE CARD. Integer paise, always: a float in a money path is a bug,
  -- and 0.1 + 0.2 is the reason.
  --
  -- ALL THREE NULLABLE, and no CHECK requiring one. That looks like a gap and is not:
  -- FR-100 says a listing is created as a DRAFT, and a draft is by definition
  -- half-finished — someone saving a title and coming back tomorrow must not be
  -- refused for having no price yet. "At least one rate" is a PUBLISH condition
  -- (FR-107), enforced in the service where the rest of the publish gate lives.
  --
  -- `> 0` rather than `>= 0`: a rate of zero is not a free rental, it is a missing
  -- price. Free is expressible by not setting that unit at all.
  hourly_rate_paise  integer CHECK (hourly_rate_paise  > 0),
  daily_rate_paise   integer CHECK (daily_rate_paise   > 0),
  monthly_rate_paise integer CHECK (monthly_rate_paise > 0),

  -- FR-104. Zero is legitimate here, unlike a rate: "no deposit" is a real offer.
  deposit_paise integer NOT NULL DEFAULT 0 CHECK (deposit_paise >= 0),

  -- FR-113 — AN AREA, NEVER A STREET ADDRESS.
  --
  -- There is deliberately no `address_line` column, and adding one would be a safety
  -- regression rather than a feature. A published listing is world-readable, so a
  -- street address on it publishes where a valuable object is kept and where its owner
  -- lives. The exact location is something two people exchange once a booking is
  -- confirmed, which is a later step and a different table.
  --
  -- Nullable for the same reason as the rates: required to publish, not to draft.
  locality     text,
  city         text,

  -- FR-114. Hours as the unit throughout, so an hourly and a monthly listing are
  -- comparable without a second "unit" column to keep in sync.
  min_duration_hours integer CHECK (min_duration_hours > 0),
  max_duration_hours integer CHECK (max_duration_hours > 0),
  CONSTRAINT listings_duration_order CHECK (
    min_duration_hours IS NULL
    OR max_duration_hours IS NULL
    OR max_duration_hours >= min_duration_hours
  ),

  -- FR-116.
  fulfilment   text NOT NULL DEFAULT 'PICKUP'
                 CHECK (fulfilment IN ('PICKUP', 'DELIVERY', 'BOTH')),

  -- When it FIRST went live. Not cleared on unpublish: it records a fact about the
  -- listing's history, and "has this ever been visible?" is a different question from
  -- "is it visible now?" — which `status` already answers.
  published_at timestamptz,

  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- FR-115: an owner's own list, drafts included, newest first.
CREATE INDEX IF NOT EXISTS idx_listings_owner ON listings (owner_id, created_at DESC);

-- The browse query (step 5). Partial, because browse only ever reads PUBLISHED rows —
-- so drafts and unpublished listings are not carried in the index at all.
CREATE INDEX IF NOT EXISTS idx_listings_published
  ON listings (created_at DESC)
  WHERE status = 'PUBLISHED';

CREATE INDEX IF NOT EXISTS idx_listings_category ON listings (category_id)
  WHERE status = 'PUBLISHED';


-- Shape and reasoning: docs/6.media-storage.md §6.
CREATE TABLE IF NOT EXISTS listing_photos (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id uuid NOT NULL REFERENCES listings(id) ON DELETE CASCADE,

  -- THE PROVIDER'S OWN IDENTIFIER. NEVER A URL.
  --
  -- The single most important rule on this table. A URL bakes the provider, the
  -- account, the CDN domain, the delivery scheme AND the transformation into a value
  -- stored on thousands of rows — change any one of them and it is a data migration.
  -- An id makes every one of those a change to one function.
  storage_id text NOT NULL,
  provider   text NOT NULL DEFAULT 'CLOUDINARY',

  -- Returned by the upload. Lets the frontend reserve the right space before the image
  -- arrives, which is what stops a grid jumping as photos load.
  width      integer NOT NULL,
  height     integer NOT NULL,
  bytes      integer NOT NULL,
  mime_type  text NOT NULL,

  -- FR-106. Position 0 is the cover shown in the grid. Ordering rather than a separate
  -- `is_cover` flag: with a flag, "exactly one cover" is an invariant to enforce, and a
  -- listing whose cover was deleted has none.
  sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order >= 0),

  created_at timestamptz NOT NULL DEFAULT now(),

  -- DEFERRABLE, AND THAT WORD IS LOAD-BEARING.
  --
  -- Reordering photos permutes these values, and a permutation passes through states
  -- where two rows share a position — swapping 0 and 1 must transiently have two 0s or
  -- two 1s. A normal UNIQUE is checked per row as the statement runs, so it would
  -- refuse every reorder that is not a strict rotation.
  --
  -- INITIALLY DEFERRED moves the check to commit time. A single UPDATE is its own
  -- transaction, so one statement can rewrite the whole order and only the final state
  -- is validated. Without this, reordering needs a temporary out-of-range value and
  -- three statements.
  CONSTRAINT uq_listing_photo_position UNIQUE (listing_id, sort_order)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS idx_listing_photos_listing
  ON listing_photos (listing_id, sort_order);

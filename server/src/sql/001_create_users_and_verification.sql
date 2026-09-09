-- 001 — users and email verification
--
-- The account model for a two-sided marketplace. Note what is ABSENT: there is no
-- `role` column. The same person lists a camera and rents a bike, so "owner" and
-- "renter" are relationships to a listing or a booking, never properties of a person
-- (docs/0.product-overview.md §2). `is_admin` is platform staff, who are not
-- marketplace participants at all.
--
-- Documented in docs/features/01-public-registration.md §5. Never edit this file once
-- it has been applied — the migration runner stores a checksum and will refuse to run.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                   text NOT NULL,
  email                  text NOT NULL,
  password_hash          text NOT NULL,

  -- NULL means unverified. A nullable timestamp rather than a boolean: it answers
  -- both "is it verified" and "since when", and it makes the invalid state
  -- (verified, but nobody knows when) unrepresentable.
  email_verified_at      timestamptz,

  -- Captured at signup, verified later as a higher trust tier that gates high-value
  -- listings. Deliberately NOT unique: a household can share a number.
  phone                  text,
  phone_verified_at      timestamptz,

  status                 text NOT NULL DEFAULT 'ACTIVE'
                           CHECK (status IN ('ACTIVE', 'SUSPENDED', 'DELETED')),

  -- Platform staff only. Never settable from a request body - see authService.
  is_admin               boolean NOT NULL DEFAULT false,

  -- WHICH terms they agreed to, and when. A marketplace moves money and goods between
  -- strangers; "they accepted the terms" is worth nothing without a version, because
  -- nobody can later say what they actually agreed to.
  accepted_terms_version text NOT NULL,
  accepted_terms_at      timestamptz NOT NULL DEFAULT now(),

  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

-- On the EXPRESSION, not the column. A plain unique constraint on `email` treats
-- Priya@x.com and priya@x.com as two accounts — and then whoever registered first
-- cannot sign in with the casing they remember, while the error says "invalid
-- credentials" and sends everyone hunting the wrong problem.
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email_lower ON users (lower(email));

CREATE INDEX IF NOT EXISTS idx_users_status ON users (status);


CREATE TABLE IF NOT EXISTS email_verification_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- SHA-256 of the raw token, never the token itself. A database leak must not hand
  -- over the ability to verify — and therefore activate — every pending account.
  token_hash text NOT NULL UNIQUE,

  -- The address this token was issued FOR. Consuming it verifies the user only if
  -- users.email still equals this. Without it, the sequence "register as a@x.com →
  -- change email to b@y.com → click the old link" marks b@y.com verified having
  -- proved nothing whatsoever about it.
  email      text NOT NULL,

  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_evt_user ON email_verification_tokens (user_id, created_at DESC);

-- AT MOST ONE LIVE TOKEN PER USER, and this partial index is what makes reissuing
-- atomic: `INSERT ... ON CONFLICT (user_id) WHERE used_at IS NULL DO UPDATE` replaces
-- the live token in one statement.
--
-- A select-then-delete-then-insert would let two concurrent resends both pass and mint
-- two working links — and a user who clicks "resend" expects the previous link to stop
-- working, which is exactly what this guarantees.
CREATE UNIQUE INDEX IF NOT EXISTS uq_evt_active_user
  ON email_verification_tokens (user_id)
  WHERE used_at IS NULL;

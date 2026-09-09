-- 002 — password reset tokens
--
-- Deliberately a SEPARATE TABLE from email_verification_tokens rather than a `purpose`
-- column on one shared table. The two differ in every parameter that matters — 1 hour
-- against 24, what consuming one does, and what a leaked row would let an attacker do
-- (take over an account, versus confirm an address) — so a shared table would mean
-- every query carrying a `WHERE purpose = ...` that is a silent account-takeover bug
-- the one time it is forgotten.
--
-- Documented in docs/features/02-password-reset.md §5. Never edit this file once it
-- has been applied — the migration runner stores a checksum and will refuse to run.

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- SHA-256 of the raw token, never the token itself. The stakes are higher here than
  -- for verification: a database leak of raw reset tokens is a leak of live
  -- account-takeover credentials for every pending request.
  token_hash text NOT NULL UNIQUE,

  -- The address this token was emailed TO. Consuming it changes the password only if
  -- users.email still equals this — see docs/features/02-password-reset.md §3.5.
  --
  -- Without it, the sequence "request a reset → change the account's email → click the
  -- old link" would let whoever controls the OLD address set the password on an
  -- account that no longer has anything to do with them. It also gives FR-031
  -- (changing an email invalidates outstanding tokens) for free, with no sweep to
  -- write and nothing to remember to call.
  email      text NOT NULL,

  -- One hour, set by the repository rather than defaulted here, so the TTL is visible
  -- in the code that issues the token instead of hidden in a schema nobody rereads.
  expires_at timestamptz NOT NULL,

  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_prt_user ON password_reset_tokens (user_id, created_at DESC);

-- AT MOST ONE LIVE TOKEN PER USER. This partial index is what makes both reissuing and
-- the resend cooldown a single atomic statement:
--
--   INSERT ... ON CONFLICT (user_id) WHERE used_at IS NULL
--   DO UPDATE SET ... WHERE password_reset_tokens.created_at < now() - cooldown
--
-- Three bugs are unreachable because of that shape, and all three are live problems
-- rather than theory:
--
--   1. Two concurrent requests both minting a working link. A select-then-insert lets
--      both pass the check; the index lets exactly one row exist.
--   2. The cooldown being evaluated against a JS clock. Both sides of the comparison
--      are now the DATABASE's clock, so Node and Postgres running in different
--      timezones cannot silently disable it.
--   3. A 409 that answers only for REGISTERED addresses. Without ON CONFLICT the
--      concurrent case raises 23505, which the error handler maps to 409 — so a real
--      address would answer 409 where an unknown one answers 202, rebuilding the
--      enumeration oracle this whole feature is built to avoid.
CREATE UNIQUE INDEX IF NOT EXISTS uq_prt_active_user
  ON password_reset_tokens (user_id)
  WHERE used_at IS NULL;

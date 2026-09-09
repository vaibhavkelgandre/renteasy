-- 003 — profile: a pending email change, and soft deletion
--
-- Documented in docs/features/03-profile.md §5. Never edit this file once it has been
-- applied — the migration runner stores a checksum and will refuse to run.

-- THE ADDRESS A USER WANTS TO MOVE TO, NOT THE ONE THEY HAVE.
--
-- FR-030 requires the old address to keep working until the new one is confirmed, so a
-- change cannot simply overwrite `email`. Overwriting would mean a typo'd address locks
-- the account out permanently: the new address never receives the link, and the old one
-- is already gone.
--
-- With this column the account is untouched until someone proves control of the new
-- address by clicking a link sent to it. Until then `email` still signs in, still
-- receives password resets, and is still what the unique index protects.
--
-- DELIBERATELY NOT UNIQUE, and not indexed. Two people may both have a pending change
-- to the same address; that is not a conflict, because nothing has happened yet. The
-- winner is decided at confirmation time by `uq_users_email_lower` — the one index that
-- already means "this address belongs to exactly one account". A unique constraint here
-- would instead let the first person to *request* an address reserve it forever without
-- ever proving they own it, which is a denial-of-service on somebody else's real email.
ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_email text;

-- WHEN the account was deleted, paired with the pre-existing status = 'DELETED'.
--
-- A nullable timestamp rather than relying on status alone: it answers both "is it
-- deleted" and "since when", which is what any future retention or purge policy needs.
-- Same reasoning as email_verified_at in 001.
--
-- Deletion is SOFT. A marketplace accumulates bookings, reviews and payments that
-- reference a person, so a hard DELETE either cascades away another party's records or
-- is refused by a foreign key. Neither is acceptable — the counterparty to a completed
-- rental is entitled to their own history.
--
-- The consequence, named because it is user-visible: the row survives, so
-- `uq_users_email_lower` still holds that address and the person cannot re-register
-- with it. Releasing the address needs a scrub step (overwrite email with a tombstone
-- value) that is not built.
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

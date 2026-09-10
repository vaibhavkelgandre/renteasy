/**
 * Test harness setup. Runs before every test file (vitest.config.js).
 *
 * ORDER IN THIS FILE IS LOAD-BEARING. Read the comments before rearranging anything.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { beforeEach, afterAll } from "vitest";

// 1. Load .env.test with override: true.
//
// `override` matters. Without it, a DATABASE_URL already present in the shell wins
// over the file — which is precisely the dangerous case the guard below exists for.
// Overriding neutralises a stray shell value before anything can use it.
//
// Belt and braces: .env.test also sets NODE_ENV=test, so a developer who forgets to
// prefix the command is still safe.
//
// The path is resolved from THIS FILE's location, not from process.cwd(). Relative to
// cwd it would break the moment the suite is invoked from the repository root rather
// than from server/ — and it would break by silently loading nothing, which is the
// worst possible failure for a file whose whole job is safety.
const envTestPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env.test");

// dotenv.config() DOES NOT THROW when the file is missing — it returns `{ error }` and
// carries on. That silent failure is handled below rather than here, because a missing
// file is not always a problem: CI has no .env.test (it is gitignored) and sets the
// DB_* variables directly in the workflow instead.
const loaded = dotenv.config({ path: envTestPath, override: true });

// 2. Assert we are pointed at a _test database — BEFORE importing config/db.js.
//
// This import order is the whole point. Importing config/db.js builds the connection
// pool as a side effect, so a check that runs afterwards is checking a database we
// have already connected to. The guard has to come first or it guards nothing.
const { assertTestDatabase } = await import("../src/utils/testDatabaseGuard.js");

try {
  assertTestDatabase();
} catch (error) {
  // The guard reports the SYMPTOM ("no database is configured"), which is correct but
  // points at the wrong place when the real cause is a file that was never created.
  // So: if the environment is unusable AND the file could not be read, say both — the
  // symptom, then the actual fix. Locally that turns half an hour in the wrong file
  // into one command.
  if (loaded.error) {
    throw new Error(
      `${error.message}\n\n` +
        `  ...and ${envTestPath} could not be read.\n` +
        `  Create it with:\n` +
        `    cp server/.env.test.example server/.env.test\n\n` +
        `  Then set DB_PASSWORD in it. See docs/troubleshooting.md.`
    );
  }
  throw error;
}

// 3. Only now is it safe to touch the database.
const { query, closeDatabase } = await import("../src/config/db.js");

/**
 * Every table the suite writes to.
 *
 * `schema_migrations` MUST NEVER APPEAR HERE. Truncating the migration ledger would
 * make the next run believe the database was unmigrated — and then every test fails
 * with "relation employees does not exist", which looks like a broken schema rather
 * than a broken test harness.
 */
// `categories` is NOT in this list, for the same class of reason. It is SEEDED BY
// MIGRATION 004 rather than created by tests, so truncating it would empty the lookup
// table for the whole run and every later test would fail with "that is not a category
// we have" — which reads as a broken service rather than a broken harness.
//
// `listing_photos` is absent because it CASCADEs from `listings`.
const TABLES = ["users", "email_verification_tokens", "password_reset_tokens", "listings"];

// 4. A clean database before each test.
//
// beforeEach, not afterEach: if a test crashes mid-way, an afterEach cleanup may not
// run, and the NEXT test then starts dirty and fails for a reason that has nothing to
// do with it. Cleaning before means a test can only ever be affected by its own setup.
//
// TRUNCATE ... CASCADE rather than DELETE: it is far faster, and CASCADE follows
// foreign keys so table order in the list above does not matter.
// RESTART IDENTITY resets sequences, so ticket numbers (step 4) start from 1 in every
// test rather than climbing across the whole run and making assertions unrepeatable.
const { clearOutbox } = await import("../src/config/mailer.js");

beforeEach(async () => {
  await query(`TRUNCATE ${TABLES.join(", ")} RESTART IDENTITY CASCADE`);

  // The mail outbox is state too. A message left over from a previous test would let
  // this one read the wrong verification link and pass for entirely the wrong reason.
  clearOutbox();
});

// 5. Release the pool, or vitest hangs after the last test with no explanation —
// Node keeps the process alive while any pooled socket is open.
afterAll(async () => {
  await closeDatabase();
});

/**
 * Migration runner.
 *
 * Applies every pending `.sql` file in src/sql/, in filename order, and records what
 * it applied in a `schema_migrations` ledger so a second run does nothing.
 *
 *   npm run migrate          apply everything pending
 *   npm run migrate:status   report applied / pending / edited, change nothing
 *
 * WHY A LEDGER AT ALL: without one, the only options are "re-run every file on every
 * start" (which breaks the moment a file isn't perfectly replayable) or "remember by
 * hand which ones you've run" (which nobody does correctly across three
 * environments). The ledger makes "what state is this database in?" a query.
 *
 * The ledger table is created by this script rather than by a migration file, and it
 * has to be: a migration that creates the ledger cannot be recorded in the ledger it
 * is creating.
 *
 * Deliberately NOT built yet, because there is one database and one developer:
 *   - an advisory lock (two concurrent deploys applying the same pending list)
 *   - a `baseline` command (recording files as applied without executing them)
 * Both matter once this deploys somewhere. Neither buys anything today.
 */

import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { env } from "../config/env.js";

const SQL_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "sql");

/**
 * Hashes a migration's contents so an edit to an already-applied file is detectable.
 *
 * LF-NORMALISED, NEVER RAW BYTES, and this line is load-bearing on Windows. Git is
 * commonly configured to check files out with CRLF line endings while storing them
 * as LF. Hashing raw bytes would therefore make the identical file hash differently
 * on a Windows laptop than on a Linux CI runner, and EVERY run would fail with a
 * mismatch that means nothing.
 *
 * @param {string} contents Raw file contents.
 * @returns {string} Hex SHA-256 of the LF-normalised text.
 */
function checksum(contents) {
  return createHash("sha256").update(contents.replace(/\r\n/g, "\n"), "utf8").digest("hex");
}

/**
 * Reads every migration file from disk, in filename order.
 *
 * Sorted lexicographically, which is why files are zero-padded (`001_`, not `1_`):
 * unpadded, `10_x.sql` sorts before `2_x.sql` and migration 10 runs first.
 *
 * @returns {Promise<Array<{ filename: string, contents: string, hash: string }>>}
 */
async function loadMigrationFiles() {
  const names = (await readdir(SQL_DIR)).filter((n) => n.endsWith(".sql")).sort();

  return Promise.all(
    names.map(async (filename) => {
      const contents = await readFile(path.join(SQL_DIR, filename), "utf8");
      return { filename, contents, hash: checksum(contents) };
    })
  );
}

/**
 * Creates the ledger if it does not exist.
 *
 * @param {pg.Client} client
 * @returns {Promise<void>}
 */
async function ensureLedger(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    text PRIMARY KEY,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now(),
      duration_ms integer NOT NULL
    )
  `);
}

/**
 * Compares files on disk against the ledger.
 *
 * @param {pg.Client} client
 * @returns {Promise<{ pending: object[], edited: object[], applied: object[], orphaned: string[] }>}
 */
async function resolveState(client) {
  const files = await loadMigrationFiles();
  const { rows } = await client.query("SELECT filename, checksum FROM schema_migrations");
  const recorded = new Map(rows.map((r) => [r.filename, r.checksum]));

  const pending = files.filter((f) => !recorded.has(f.filename));
  const applied = files.filter((f) => recorded.has(f.filename));
  const edited = applied.filter((f) => recorded.get(f.filename) !== f.hash);

  // A ledger row with no file on disk. Usually a deleted or renamed migration, which
  // means this database's schema can no longer be reproduced from the repository.
  const onDisk = new Set(files.map((f) => f.filename));
  const orphaned = [...recorded.keys()].filter((name) => !onDisk.has(name));

  return { pending, edited, applied, orphaned };
}

/**
 * Applies every pending migration, or reports state and exits when `statusOnly`.
 *
 * @param {object} [options]
 * @param {boolean} [options.statusOnly=false] Report and change nothing.
 * @returns {Promise<void>}
 * @throws Never. Calls process.exit with a non-zero code on any failure, so CI and a
 *         deploy script can both branch on it.
 */
async function migrate({ statusOnly = false } = {}) {
  if (!env.databaseUrl) {
    console.error("[migrate] DATABASE_URL is not set. Nothing to migrate against.");
    process.exit(1);
  }

  // Name the target BEFORE connecting, so a failure still tells you which database
  // was aimed at. Without this, a wrong-password error is identical whether you were
  // pointed at the dev database, the test one, or production - and "which one was I
  // even talking to?" is the first thing you need to know.
  //
  // The database name only. Never the whole URL: it contains a password, and this
  // line ends up in terminals, CI logs and screenshots.
  try {
    const parsed = new URL(env.databaseUrl);
    console.log(`[migrate] target: ${parsed.pathname.replace(/^\//, "")} @ ${parsed.hostname}`);
  } catch {
    console.error("[migrate] DATABASE_URL could not be parsed.");
    process.exit(1);
  }

  // A single Client, not a Pool. A Pool can hand each query a different connection,
  // which would matter the moment an advisory lock is added (a session-scoped lock
  // taken on one connection guards nothing on another). Using a Client now means
  // that change stays a one-liner.
  const client = new pg.Client({
    connectionString: env.databaseUrl,
    ssl: env.isProduction ? { rejectUnauthorized: false } : false,
  });

  // Connect inside a try. Without this, an unreachable database, a wrong password or
  // a missing database produces a raw unhandled rejection and a Node stack trace —
  // which buries the one line that actually tells you what is wrong. Found by
  // running this against a database that did not exist.
  try {
    await client.connect();
  } catch (error) {
    // Message only, never the connection string: it contains the password, and this
    // line ends up in terminals, CI logs and screenshots.
    console.error(`[migrate] Could not connect: ${error.message}`);

    // Translate the two failures that are almost always a configuration typo rather
    // than a real problem. pg's own wording for an empty password
    // ("SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string") names
    // an authentication mechanism nobody has heard of and gives no hint that the
    // answer is "you left DB_PASSWORD blank".
    if (/SASL|password must be a string/i.test(error.message)) {
      console.error(`[migrate] DB_PASSWORD looks empty. Set it in server/.env (and .env.test).`);
    } else if (/does not exist/i.test(error.message)) {
      console.error(`[migrate] Create it:  psql -U postgres -c "CREATE DATABASE <name>;"`);
    } else {
      console.error(`[migrate] Check your DB_* values, and that Postgres is running.`);
    }

    process.exit(1);
  }

  // Confirm from the SERVER's own point of view, not just from the string we parsed.
  // A connection string can be overridden by PG* environment variables, so what we
  // asked for and what we got are not guaranteed to match - and `DATABASE_URL` left
  // in a shell is how a migration meant for a laptop lands on production.
  const { rows: [target] } = await client.query("SELECT current_database() AS db");
  console.log(`[migrate] connected to: ${target.db}`);

  try {
    await ensureLedger(client);
    const { pending, edited, applied, orphaned } = await resolveState(client);

    // An edited already-applied file aborts the run BEFORE anything is applied.
    // Fatal on purpose: it means this database and every other one are now running
    // different schemas, and applying more files would paper over the divergence.
    // The fix is a NEW migration, never an edit to an old one.
    if (edited.length > 0) {
      console.error(`[migrate] ABORTING — already-applied migration(s) have been edited:`);
      edited.forEach((f) => console.error(`  ${f.filename}`));
      console.error(`[migrate] Migrations are immutable once applied. Add a new file instead.`);
      process.exit(1);
    }

    if (orphaned.length > 0) {
      console.warn(`[migrate] WARNING — recorded but missing from disk: ${orphaned.join(", ")}`);
    }

    if (statusOnly) {
      console.log(`[migrate] applied: ${applied.length}, pending: ${pending.length}`);
      pending.forEach((f) => console.log(`  pending  ${f.filename}`));
      return;
    }

    if (pending.length === 0) {
      console.log("[migrate] nothing to do — database is up to date");
      return;
    }

    for (const file of pending) {
      const startedAt = Date.now();

      // Each file runs in its OWN transaction, with its ledger row inserted inside
      // it. So a file either fully applies AND is recorded, or neither — the ledger
      // can never claim a migration that half-ran.
      await client.query("BEGIN");
      try {
        await client.query(file.contents);
        await client.query(
          `INSERT INTO schema_migrations (filename, checksum, duration_ms) VALUES ($1, $2, $3)`,
          [file.filename, file.hash, Date.now() - startedAt]
        );
        await client.query("COMMIT");
        console.log(`[migrate] applied  ${file.filename}  (${Date.now() - startedAt}ms)`);
      } catch (error) {
        await client.query("ROLLBACK");
        // Stop rather than skip ahead: migration 003 almost certainly assumes 002
        // landed, so continuing would produce a schema nobody can reason about.
        console.error(`[migrate] FAILED   ${file.filename}: ${error.message}`);
        process.exit(1);
      }
    }
  } finally {
    await client.end();
  }
}

await migrate({ statusOnly: process.argv.includes("--status") });

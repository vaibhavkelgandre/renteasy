/**
 * PostgreSQL connection pool.
 *
 * The pool is OPTIONAL in step 1: with no DATABASE_URL set, `pool` stays null and
 * the server still starts. That is deliberate rather than lazy - it means a fresh
 * clone runs and its tests pass before anyone has installed Postgres, so step 1 can
 * be verified on its own. DATABASE_URL becomes required in step 5 (config/env.js).
 *
 * A pool, not a client: `pg` reuses a small set of connections instead of opening
 * one per query. Opening a TCP connection and authenticating costs more than most
 * queries do, so a per-query client would dominate response time under any load.
 */

import pg from "pg";
import { env } from "./env.js";

/** @type {pg.Pool | null} */
let pool = null;

if (env.databaseUrl) {
  pool = new pg.Pool({
    connectionString: env.databaseUrl,
    // SSL only where it is actually needed. Managed providers require it; a local
    // Postgres does not offer it, and demanding it locally fails the handshake.
    // env.dbSsl verifies the server certificate (rejectUnauthorized: true) — see its
    // own comment in env.js for why `false` there was a silent man-in-the-middle gap.
    ssl: env.dbSsl,
    max: 10,
    idleTimeoutMillis: 30_000,
    // Fail a connection attempt rather than hanging a request forever.
    connectionTimeoutMillis: 5_000,
  });

  // An idle client erroring (network drop, server restart) emits on the pool. With
  // no listener, Node treats it as an unhandled 'error' event and kills the process.
  pool.on("error", (error) => {
    console.error("[db] Idle client error:", error.message);
  });
}

/**
 * Whether a database is configured at all.
 * @returns {boolean}
 */
export function isDatabaseConfigured() {
  return pool !== null;
}

/**
 * Runs a parameterised query.
 *
 * The ONLY way the rest of the app talks to Postgres. Values are always passed as
 * `params` - never interpolated into `text` - which is what makes SQL injection
 * structurally impossible rather than a thing to remember.
 *
 * @param {string} text SQL with $1, $2 ... placeholders.
 * @param {unknown[]} [params] Values for the placeholders.
 * @returns {Promise<pg.QueryResult>}
 * @throws {Error} If no database is configured, or the query fails.
 */
export async function query(text, params = []) {
  if (!pool) {
    throw new Error("No database configured. Set DATABASE_URL.");
  }
  return pool.query(text, params);
}

/**
 * Runs a callback against ONE client wrapped in a transaction — committed on
 * success, rolled back on any error.
 *
 * WHY THIS EXISTS: `query()` above asks the POOL for a connection, and the pool is
 * free to hand two calls to two different physical connections. That is fine for an
 * isolated statement and wrong the moment two writes must succeed or fail together —
 * a booking's status change and the audit event that records it (bookingService.js),
 * for instance. Without this, a crash between the two leaves a status change with no
 * event, and a trail with holes is not evidence.
 *
 * EVERY REPOSITORY FUNCTION CALLED INSIDE `fn` MUST BE PASSED THE `exec` ARGUMENT IT
 * RECEIVES — never the module's own `query()`. `exec` is bound to this transaction's
 * one client; falling back to `query()` would run that statement on a DIFFERENT
 * connection, entirely outside the transaction, and — because Postgres isolates
 * uncommitted writes to the session that made them — a read done that way would not
 * even see the write this same transaction just made.
 *
 * @template T
 * @param {(exec: (text: string, params?: unknown[]) => Promise<pg.QueryResult>) => Promise<T>} fn
 *        Receives a `query()`-shaped function bound to the transaction's client.
 * @returns {Promise<T>} Whatever `fn` returns.
 * @throws {Error} If no database is configured, or `fn` throws — rolled back first,
 *         then the original error is rethrown unchanged, so callers can still branch
 *         on `error.code` exactly as they would around a plain `query()` call.
 */
export async function withTransaction(fn) {
  if (!pool) {
    throw new Error("No database configured. Set DATABASE_URL.");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn((text, params = []) => client.query(text, params));
    await client.query("COMMIT");
    return result;
  } catch (error) {
    // Swallowed deliberately: a ROLLBACK that itself fails (the connection already
    // dropped) must not replace the original error with a less useful one — the
    // caller needs to see and act on what actually went wrong.
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    // ALWAYS, on every path — a client never returned to the pool is a slow leak
    // that eventually exhausts `max` and hangs every future request.
    client.release();
  }
}

/**
 * Reports whether the database is reachable right now.
 *
 * Used only by the health check. Returns a string rather than throwing, because a
 * health endpoint's job is to REPORT a problem, not to become one.
 *
 * @returns {Promise<"connected" | "error" | "not_configured">}
 */
export async function checkDatabaseConnection() {
  if (!pool) return "not_configured";

  try {
    // `SELECT 1` is the cheapest possible round trip: it proves the connection,
    // the authentication and the server's willingness to answer, and touches no table.
    await pool.query("SELECT 1");
    return "connected";
  } catch (error) {
    // Message only, never the connection string - it contains the password.
    console.error("[db] Health check failed:", error.message);
    return "error";
  }
}

/**
 * Closes the pool so the process can exit cleanly.
 *
 * Without this, `server.js`'s graceful shutdown hangs: Node keeps the process alive
 * while any pooled socket is still open.
 *
 * @returns {Promise<void>}
 */
export async function closeDatabase() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

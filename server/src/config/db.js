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
    ssl: env.isProduction ? { rejectUnauthorized: false } : false,
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

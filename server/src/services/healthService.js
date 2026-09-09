/**
 * Health reporting.
 *
 * Business logic for GET /health. Lives in a service rather than the controller so
 * the layering (routes -> controller -> service) is established on the simplest
 * possible endpoint, before there is anything complicated to get wrong.
 *
 * Deliberate layering exception: this service calls config/db.js directly instead of
 * going through a repository. Repositories exist to own DOMAIN queries; "is the pool
 * alive" is not domain data, and inventing a healthRepository to wrap `SELECT 1`
 * would be a layer that carries nothing. Every service that touches real data does
 * go through a repository.
 */

import { env } from "../config/env.js";
import { checkDatabaseConnection } from "../config/db.js";

/**
 * Builds the health report.
 *
 * @returns {Promise<{
 *   status: "ok" | "degraded",
 *   version: string,
 *   uptimeSeconds: number,
 *   database: "connected" | "error" | "not_configured"
 * }>}
 * @throws Never. A health check that can throw is useless - the caller asking
 *         "are you alive?" would get an exception instead of an answer.
 */
export async function getHealth() {
  const database = await checkDatabaseConnection();

  // "degraded" ONLY when a database was configured and is unreachable. An
  // unconfigured database is not a fault - in step 1 it is the expected state, so
  // reporting "degraded" for it would train everyone to ignore the field.
  //
  // This distinction is the entire value of a health check. A boolean up/down tells
  // you nothing you couldn't get from the TCP connection succeeding; naming WHICH
  // dependency is broken is what makes the endpoint worth calling. In step 9 the
  // deploy step polls this, so "degraded" is what will trigger a rollback.
  const status = database === "error" ? "degraded" : "ok";

  return {
    status,
    // Traceability: CI overwrites APP_VERSION with the commit SHA, so a running
    // instance can be tied back to the code that built it.
    version: env.appVersion,
    uptimeSeconds: Math.floor(process.uptime()),
    database,
  };
}

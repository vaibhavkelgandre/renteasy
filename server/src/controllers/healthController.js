/**
 * Health endpoint controller.
 *
 * A controller's whole job, everywhere in this codebase: receive the request, call
 * ONE service, send the response. No business logic, no SQL, no branching on domain
 * rules. If a controller starts making decisions, that decision belongs in a service
 * where it can be unit-tested without an HTTP request.
 */

import { getHealth } from "../services/healthService.js";
import { sendSuccess } from "../utils/response.js";

/**
 * GET /api/health
 *
 * Public and unauthenticated - a health check that needs a credential can't be used
 * by the thing that most needs it (a deploy script, a load balancer, an uptime monitor).
 *
 * Returns 200 even when `status` is "degraded". That looks wrong and isn't: the
 * process IS responding, and the body says what's broken. A non-2xx here would make
 * a load balancer pull a server that can still serve every read - and it would hide
 * the detail in the body, which is the only useful part.
 *
 * @param {import("express").Request} _req Unused - no params, no body, no auth.
 * @param {import("express").Response} res
 * @returns {Promise<void>}
 * @throws Never. getHealth() does not throw.
 */
export async function getHealthStatus(_req, res) {
  const health = await getHealth();
  sendSuccess(res, { message: "Service is running", data: health });
}

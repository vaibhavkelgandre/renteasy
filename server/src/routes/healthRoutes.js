/**
 * Health routes.
 *
 * A routes file declares endpoints and nothing else - no logic, no validation, no
 * response building. Read top to bottom it should answer "what URLs exist and who
 * may call them?" and nothing more.
 *
 * From step 2 onward, route files are also where middleware is attached, e.g.
 *   router.post("/", requireRole("STAFF"), validate(createTicketSchema), createTicket);
 * which is what keeps every route's auth requirement visible in one glance rather
 * than buried inside a controller.
 */

import { Router } from "express";
import { getHealthStatus } from "../controllers/healthController.js";

const router = Router();

// Public. No auth middleware, deliberately - see the controller's comment.
router.get("/", getHealthStatus);

export { router as healthRoutes };

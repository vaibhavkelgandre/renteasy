/**
 * /api/notifications — FR-986.
 */

import { Router } from "express";
import { requireAuth } from "../middlewares/authMiddleware.js";
import { validateQuery, validateParams } from "../validators/validate.js";
import {
  getNotifications,
  getUnreadNotificationCount,
  postNotificationRead,
  postAllNotificationsRead,
} from "../controllers/notificationController.js";
import {
  notificationQuerySchema,
  notificationParamsSchema,
} from "../validators/notificationValidator.js";

const router = Router();

// EVERY route, without exception. A notification is addressed to one person and
// there is no public view of one — so the guard belongs on the router rather than
// being repeated per route, where the next one added would be the one that forgets.
router.use(requireAuth);

router.get("/", validateQuery(notificationQuerySchema), getNotifications);

// BEFORE `/:id`-shaped routes would be added — there are none today, but "unread-count"
// is a literal segment and a future `/:id` would swallow it.
router.get("/unread-count", getUnreadNotificationCount);

router.post("/read-all", postAllNotificationsRead);

router.post(
  "/:id/read",
  validateParams(notificationParamsSchema, "Notification not found"),
  postNotificationRead
);

export { router as notificationRoutes };

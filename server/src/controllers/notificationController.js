/**
 * HTTP for notifications — FR-986.
 *
 * Every endpoint is scoped to the caller by the service, which takes `req.user` and
 * never an id from the request. There is no way to ask for somebody else's.
 */

import {
  listNotifications,
  getUnreadCount,
  readNotification,
  readAllNotifications,
} from "../services/notificationService.js";
import { sendSuccess } from "../utils/response.js";

/** GET /api/notifications */
export async function getNotifications(req, res, next) {
  try {
    const page = await listNotifications(req.user, req.validatedQuery);
    sendSuccess(res, { message: "OK", data: page });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/notifications/unread-count
 *
 * ITS OWN ENDPOINT, deliberately. The header polls this for every signed-in user for
 * as long as a tab is open, and deriving it from `GET /notifications` would make the
 * most frequent request in the product also one of the most expensive — the rule this
 * codebase already applies to every count.
 */
export async function getUnreadNotificationCount(req, res, next) {
  try {
    sendSuccess(res, { message: "OK", data: await getUnreadCount(req.user) });
  } catch (error) {
    next(error);
  }
}

/** POST /api/notifications/:id/read */
export async function postNotificationRead(req, res, next) {
  try {
    const notification = await readNotification(req.user, req.validatedParams.id);
    sendSuccess(res, { message: "Marked as read", data: { notification } });
  } catch (error) {
    next(error);
  }
}

/** POST /api/notifications/read-all */
export async function postAllNotificationsRead(req, res, next) {
  try {
    sendSuccess(res, { message: "All marked as read", data: await readAllNotifications(req.user) });
  } catch (error) {
    next(error);
  }
}

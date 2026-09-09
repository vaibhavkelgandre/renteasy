/**
 * Profile endpoint controllers.
 *
 * Receive the request, call one service, send the response. Every one of these takes
 * the actor from `req.user` — the session — and never from the body or a route param.
 * There is no "edit user X" path here at all, which is why none of them make an
 * authorization decision.
 */

import {
  getOwnProfile,
  updateProfile,
  requestEmailChange,
  cancelEmailChange,
  changePassword,
  deleteOwnAccount,
  getPublicProfile,
} from "../services/profileService.js";
import { clearAuthCookie } from "../utils/cookies.js";
import { sendSuccess } from "../utils/response.js";

/**
 * GET /api/profile
 *
 * @param {import("express").Request} req Requires `requireAuth`.
 * @param {import("express").Response} res
 * @param {import("express").NextFunction} next
 * @returns {Promise<void>}
 */
export async function getMyProfile(req, res, next) {
  try {
    const user = await getOwnProfile(req.user);
    sendSuccess(res, { message: "OK", data: { user } });
  } catch (error) {
    next(error);
  }
}

/**
 * PATCH /api/profile
 *
 * @param {import("express").Request} req Requires `requireAuth`.
 * @param {import("express").Response} res
 * @param {import("express").NextFunction} next
 * @returns {Promise<void>}
 */
export async function patchMyProfile(req, res, next) {
  try {
    const user = await updateProfile(req.user, req.body);
    sendSuccess(res, { message: "Profile updated", data: { user } });
  } catch (error) {
    next(error);
  }
}

/**
 * PATCH /api/profile/email
 *
 * ALWAYS 202, ALWAYS THE SAME BODY, once the password checks out — whether the address
 * is free, already belongs to somebody else, or is the caller's own.
 *
 * 202 rather than 200 for the same reason registration uses it: nothing has changed
 * yet. The account keeps its current address until a link sent to the new one is
 * clicked, so "Accepted" is the only honest answer — and it happens to be the one that
 * discloses nothing.
 *
 * @param {import("express").Request} req Requires `requireAuth`.
 * @param {import("express").Response} res
 * @param {import("express").NextFunction} next
 * @returns {Promise<void>}
 */
export async function patchMyEmail(req, res, next) {
  try {
    await requestEmailChange(req.user, req.body);
    sendSuccess(res, {
      status: 202,
      // Says what happens IF the address is available, without asserting that it is.
      message: "Check the new address for a confirmation link. Your current email still works until then.",
      data: null,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * DELETE /api/profile/email
 *
 * Abandons a pending change. Named as a DELETE of the pending resource rather than
 * another PATCH, because it removes something rather than setting it.
 *
 * @param {import("express").Request} req Requires `requireAuth`.
 * @param {import("express").Response} res
 * @param {import("express").NextFunction} next
 * @returns {Promise<void>}
 */
export async function deleteMyPendingEmail(req, res, next) {
  try {
    const user = await cancelEmailChange(req.user);
    sendSuccess(res, { message: "Email change cancelled", data: { user } });
  } catch (error) {
    next(error);
  }
}

/**
 * PATCH /api/profile/password
 *
 * Returns no user and sets no cookie. The session survives deliberately — this is the
 * caller changing their OWN password on purpose, and signing them out of the tab they
 * are looking at would read as a failure.
 *
 * Note it does not sign out OTHER sessions either, which is a genuine gap rather than a
 * decision: a JWT here is signed over the user id, not the password hash. See
 * docs/features/02-password-reset.md §7.
 *
 * @param {import("express").Request} req Requires `requireAuth`.
 * @param {import("express").Response} res
 * @param {import("express").NextFunction} next
 * @returns {Promise<void>}
 */
export async function patchMyPassword(req, res, next) {
  try {
    await changePassword(req.user, req.body);
    sendSuccess(res, { message: "Password updated", data: null });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/profile/deletion
 *
 * Clears the session cookie on the way out — the account is gone, so leaving a cookie
 * that will 401 on the next request would strand the browser in a signed-in-looking
 * state with nothing behind it.
 *
 * @param {import("express").Request} req Requires `requireAuth`.
 * @param {import("express").Response} res
 * @param {import("express").NextFunction} next
 * @returns {Promise<void>}
 */
export async function postAccountDeletion(req, res, next) {
  try {
    await deleteOwnAccount(req.user, req.body);
    clearAuthCookie(res);
    sendSuccess(res, { message: "Your account has been deleted.", data: null });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/users/:id/public
 *
 * Public: a listing has to be able to say who is offering it, to someone with no
 * account.
 *
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 * @param {import("express").NextFunction} next
 * @returns {Promise<void>}
 */
export async function getPublicUserProfile(req, res, next) {
  try {
    const profile = await getPublicProfile(req.validatedParams.id);
    sendSuccess(res, { message: "OK", data: { profile } });
  } catch (error) {
    next(error);
  }
}

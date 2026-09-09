/**
 * Auth endpoint controllers.
 *
 * Receive the request, call one service, send the response. Cookie handling lives here
 * rather than in the service, because a service that touches `res` can only be called
 * from an Express handler and cannot be unit-tested without faking one.
 */

import {
  register,
  verifyEmail,
  resendVerification,
  login,
  requestPasswordReset,
  resetPassword,
} from "../services/authService.js";
import { setAuthCookie, clearAuthCookie } from "../utils/cookies.js";
import { sendSuccess } from "../utils/response.js";
import { env } from "../config/env.js";

/**
 * POST /api/auth/register
 *
 * ALWAYS 202, ALWAYS THE SAME BODY — whether the email was new, already registered but
 * unverified, or already verified. See docs/features/01-public-registration.md §3.1.
 *
 * 202 rather than 201: "Created" asserts that a resource now exists, which is exactly
 * the fact this endpoint declines to disclose. "Accepted" says we have taken the
 * request and will act on it — true in all three cases, and revealing nothing.
 *
 * It sets NO COOKIE. At this moment we do not know the address belongs to whoever
 * typed it, so signing them in would hand a working session to anyone who can spell
 * someone else's email.
 *
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 * @param {import("express").NextFunction} next
 * @returns {Promise<void>}
 */
export async function postRegister(req, res, next) {
  try {
    await register(req.body);
    sendSuccess(res, {
      status: 202,
      message: "Check your email to finish creating your account.",
      data: null,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/auth/verify
 *
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 * @param {import("express").NextFunction} next
 * @returns {Promise<void>}
 */
export async function postVerify(req, res, next) {
  try {
    const { alreadyVerified, emailChanged } = await verifyEmail(req.body.token);

    // `emailChanged` MUST be forwarded, not just computed. The service distinguishes
    // confirming a brand-new address from completing a change (FR-030) and the client
    // needs to say different things about them - "Email confirmed" is misleading for
    // someone who just moved their account to a new address and now has to sign in
    // with it.
    sendSuccess(res, {
      // A second click is a 200, not an error: mail clients prefetch links, and the
      // user did nothing wrong.
      message: alreadyVerified
        ? "This email is already confirmed."
        : emailChanged
          ? "Email address updated."
          : "Email confirmed.",
      data: { alreadyVerified, emailChanged: Boolean(emailChanged) },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/auth/verify/resend
 *
 * @param {import("express").Request} req Requires `requireAuth`.
 * @param {import("express").Response} res
 * @param {import("express").NextFunction} next
 * @returns {Promise<void>}
 */
export async function postResendVerification(req, res, next) {
  try {
    await resendVerification(req.user);
    // 202 and the same message whether it sent, was already verified, or was inside
    // the cooldown. The client needs no special case, and nothing leaks.
    sendSuccess(res, { status: 202, message: "Check your email.", data: null });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/auth/login
 *
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 * @param {import("express").NextFunction} next
 * @returns {Promise<void>}
 */
export async function postLogin(req, res, next) {
  try {
    const { user, token } = await login(req.body);
    setAuthCookie(res, token);
    // The user object is in the body so the frontend can render immediately; the token
    // never is, because that would defeat httpOnly — JavaScript could read and store it.
    sendSuccess(res, { message: "Signed in", data: { user } });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/auth/logout
 *
 * Always succeeds, even with no session. "Log me out" and "I was already logged out"
 * are the same outcome, so answering 401 to someone trying to leave would be hostile.
 *
 * @param {import("express").Request} _req
 * @param {import("express").Response} res
 * @returns {void}
 */
export function postLogout(_req, res) {
  clearAuthCookie(res);
  sendSuccess(res, { message: "Signed out" });
}

/**
 * GET /api/auth/me
 *
 * @param {import("express").Request} req Requires `requireAuth`.
 * @param {import("express").Response} res
 * @returns {void}
 */
export function getMe(req, res) {
  sendSuccess(res, { message: "OK", data: { user: req.user } });
}

/**
 * GET /api/auth/terms/current
 *
 * Public. The registration form reads this so the version it submits is the one the
 * user was actually shown.
 *
 * @param {import("express").Request} _req
 * @param {import("express").Response} res
 * @returns {void}
 */
export function getCurrentTerms(_req, res) {
  sendSuccess(res, {
    message: "OK",
    data: { version: env.termsVersion, url: `${env.appUrl}/terms` },
  });
}

/**
 * POST /api/auth/forgot-password
 *
 * ALWAYS 202, ALWAYS THE SAME BODY — live account, suspended account, unknown address,
 * or inside the resend cooldown. See docs/features/02-password-reset.md §3.1.
 *
 * 202 rather than 200 for the same reason registration uses it: "Accepted" says we have
 * taken the request and will act on it, which is true in all four cases and asserts
 * nothing about what exists.
 *
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 * @param {import("express").NextFunction} next
 * @returns {Promise<void>}
 */
export async function postForgotPassword(req, res, next) {
  try {
    await requestPasswordReset(req.body);
    sendSuccess(res, {
      status: 202,
      // Says what will happen IF the address has an account, without asserting that it
      // does. "We've sent you a link" would be false for an unknown address and is the
      // easiest way to reintroduce the oracle.
      message: "If that address has an account, we've emailed a reset link.",
      data: null,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/auth/reset-password
 *
 * SETS NO COOKIE (FR-025). The response deliberately carries no user either — there is
 * nothing the client needs, and returning the account would confirm whose it was to
 * whoever held the link.
 *
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 * @param {import("express").NextFunction} next
 * @returns {Promise<void>}
 */
export async function postResetPassword(req, res, next) {
  try {
    await resetPassword(req.body.token, req.body.password);
    sendSuccess(res, { message: "Password updated. You can now sign in.", data: null });
  } catch (error) {
    next(error);
  }
}

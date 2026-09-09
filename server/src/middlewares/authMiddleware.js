/**
 * Authentication and the verification gate.
 *
 * NOTE WHAT IS NOT HERE: a role gate. This is a marketplace - the same person lists a
 * camera and rents a bike - so "may I do this?" is almost always a question about a
 * RELATIONSHIP to a record ("am I this listing's owner?"), answered in the service
 * layer next to the data. A `requireRole` here would answer the wrong question.
 *
 * The one exception is `requireAdmin`, for platform staff, who are not marketplace
 * participants at all.
 */

import { AUTH_COOKIE } from "../utils/cookies.js";
import { verifyAuthToken } from "../utils/jwt.js";
import { findUserById } from "../repositories/userRepository.js";
import { forbidden, unauthorized } from "../utils/errors.js";

/**
 * Requires a valid session and attaches the user to `req.user`.
 *
 * @param {import("express").Request} req
 * @param {import("express").Response} _res
 * @param {import("express").NextFunction} next
 * @returns {Promise<void>}
 */
export async function requireAuth(req, _res, next) {
  try {
    const token = req.cookies?.[AUTH_COOKIE];
    if (!token) throw unauthorized();

    const userId = verifyAuthToken(token);
    if (!userId) throw unauthorized();

    // A DATABASE LOOKUP ON EVERY REQUEST, deliberately.
    //
    // The obvious optimisation is to trust the token. But a JWT is frozen at signing
    // time, so trusting it means a user who confirms their email stays "unverified"
    // for up to 12 hours - unable to list anything, with no explanation, until they
    // sign out and back in. Suspension would take just as long to bite.
    const user = await findUserById(userId);
    if (!user) throw unauthorized();
    if (user.status !== "ACTIVE") throw unauthorized();

    req.user = user;
    next();
  } catch (error) {
    next(error);
  }
}

/**
 * Requires a CONFIRMED email address.
 *
 * The gate that makes registration's design work: an unverified user can sign in and
 * browse, but this stands in front of every action that puts money or goods at stake -
 * creating a listing, booking, negotiating, reviewing.
 *
 * Must be used after `requireAuth`.
 *
 * @param {import("express").Request} req
 * @param {import("express").Response} _res
 * @param {import("express").NextFunction} next
 * @returns {void}
 */
export function requireVerifiedEmail(req, _res, next) {
  if (!req.user) return next(unauthorized());

  if (!req.user.email_verified_at) {
    // 403 with a SPECIFIC message, and a machine-readable marker.
    //
    // This is one refusal that must be explicit rather than vague: the user is signed
    // in, has done nothing wrong, and there is exactly one thing they need to do. A
    // generic "not allowed" would be a dead end - and the client needs to distinguish
    // this from every other 403 so it can show a "resend" button rather than an error.
    const error = forbidden("Confirm your email address before doing this.");
    error.errors = { reason: "EMAIL_NOT_VERIFIED" };
    return next(error);
  }

  next();
}

/**
 * Requires platform staff.
 *
 * @param {import("express").Request} req
 * @param {import("express").Response} _res
 * @param {import("express").NextFunction} next
 * @returns {void}
 */
export function requireAdmin(req, _res, next) {
  if (!req.user) return next(unauthorized());
  if (!req.user.is_admin) return next(forbidden());
  next();
}

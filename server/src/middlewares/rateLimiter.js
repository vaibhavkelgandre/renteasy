/**
 * Rate limits.
 *
 * Mostly on the unauthenticated endpoints. Deliberately NOT applied globally - a
 * limiter over the whole authenticated API would throttle ordinary use (a browse page
 * firing several requests, a search-as-you-type box), and the pre-auth routes are
 * where a high rate is never legitimate.
 *
 * Two limiters below (emailChangeLimiter, passwordRecheckLimiter) are the deliberate
 * exception - they sit behind requireAuth and are keyed on the SESSION USER, not the
 * IP, because the thing being capped is what one signed-in account can do to itself
 * or to third parties, not how many requests one IP sends. A per-IP key would be both
 * wrong (an office behind one NAT sharing a budget across unrelated accounts) and
 * useless (an attacker who already holds a session picks their own IP).
 */

// `MemoryStore` is a NAMED export in express-rate-limit v7, not a property of the
// default export. `rateLimit.MemoryStore` throws "is not a constructor".
import rateLimit, { MemoryStore } from "express-rate-limit";
import { sendError } from "../utils/response.js";
import { env } from "../config/env.js";

const stores = [];

/**
 * Builds a limiter.
 *
 * @param {object} options
 * @param {number} options.windowMs
 * @param {number} options.max
 * @param {boolean} [options.skipSuccessfulRequests=false]
 * @param {string} options.message
 * @param {(req: import("express").Request) => string} [options.keyGenerator] Defaults
 *   to express-rate-limit's own IP-based key. Pass one for a route behind requireAuth
 *   that should be capped per ACCOUNT instead (see the two user-keyed limiters below).
 * @returns {import("express").RequestHandler}
 */
function limiter({ windowMs, max, skipSuccessfulRequests = false, message, keyGenerator }) {
  const store = new MemoryStore();
  stores.push(store);

  return rateLimit({
    windowMs,
    max,
    store,
    skipSuccessfulRequests,
    standardHeaders: true,
    legacyHeaders: false,
    ...(keyGenerator ? { keyGenerator } : {}),

    // Off under test unless explicitly enabled, and the flag is read PER REQUEST
    // rather than captured at import: the suite makes hundreds of calls from one
    // loopback address, and a limiter counting them would fail tests that have
    // nothing to do with limiting.
    skip: () => env.isTest && process.env.RATE_LIMIT_ENABLED !== "true",

    // Through sendError, never next(err) - so a 429 uses the same envelope as
    // everything else and the client needs no special case.
    handler: (_req, res) => sendError(res, { status: 429, message }),
  });
}

/**
 * Key generator for the two user-keyed limiters below.
 *
 * These sit behind requireAuth, so req.user is always set by the time this runs -
 * there is no IP fallback here on purpose. A limiter that silently fell back to
 * grouping-by-IP the moment req.user was missing would fail open in exactly the
 * shape that is easy to not notice in review: it would still return 200 from every
 * test, just without actually capping anything per-account.
 *
 * @param {import("express").Request} req
 * @returns {string}
 */
function byUserId(req) {
  return req.user.id;
}

/**
 * Clears every limiter's counts. For tests only - a limiter is stateful, and a leaked
 * count is a failure in a later, unrelated test.
 *
 * @returns {void}
 */
export function resetRateLimiters() {
  stores.forEach((store) => store.resetAll?.());
}

/**
 * Registration.
 *
 * COUNTS SUCCESSES TOO, unlike sign-in. Here a SUCCESS is what sends an email, so the
 * abuse being capped is mail-quota burn and using our sender to spam third parties -
 * both triggered by success, not by failure.
 */
export const registerLimiter = limiter({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: "Too many sign-up attempts. Try again later.",
});

/**
 * Sign-in.
 *
 * COUNTS FAILED ATTEMPTS ONLY. The key is an IP, and a household or an office behind
 * one NAT is a single IP - counting successes would throttle everybody signing in at
 * once. Brute force is all failures, so the ceiling only ever binds on the attack.
 */
export const loginLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
  skipSuccessfulRequests: true,
  message: "Too many sign-in attempts. Try again in a few minutes.",
});

/** Token guessing is the threat here, so every request counts. */
export const verifyLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: "Too many attempts. Try again in a few minutes.",
});

/**
 * Requesting a password reset.
 *
 * COUNTS SUCCESSES TOO, like registration and for the same reason: a success here is
 * what sends an email, so the abuse being capped is mail-quota burn and using our
 * verified sender to spam third parties.
 *
 * Keyed on the IP, NEVER on the submitted address, and that is not a shortcut. A
 * per-address limit would answer differently for an address that had recently been
 * used — which is precisely the enumeration oracle the identical 202 exists to remove.
 * The per-account cooldown lives in the repository, where it is invisible from outside.
 *
 * Tighter than registration's 10/hour because there is no legitimate reason to ask
 * five times: the previous link stays valid for the full hour.
 */
export const passwordResetLimiter = limiter({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: "Too many password reset requests. Try again later.",
});

/**
 * Completing a password reset.
 *
 * Token guessing is the threat, so every request counts — a failure is the whole point
 * of the attack. Separate from `verifyLimiter` rather than shared: a shared budget
 * would mean someone who had just exhausted verification attempts could not reset their
 * password, which is a lockout produced by two unrelated actions.
 */
export const passwordResetConfirmLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: "Too many attempts. Try again in a few minutes.",
});

/**
 * Requesting an email change — PATCH /profile/email.
 *
 * COUNTS SUCCESSES TOO, same reasoning as registerLimiter and passwordResetLimiter: a
 * success here is what sends mail to a THIRD PARTY (the new address, which the caller
 * fully controls the text of via their own name), so the abuse being capped is mail-
 * quota burn and using our verified sender to spam arbitrary inboxes - not credential
 * guessing. profileService.requestEmailChange has no cooldown of its own (unlike
 * password reset, which has one keyed on the account being reset), so this is the
 * only thing standing between one signed-in account and unlimited sends.
 *
 * Keyed on the caller's user id, not IP - see the file header. 5/hour matches
 * registration's own budget for "how many verification emails does one identity
 * legitimately need".
 */
export const emailChangeLimiter = limiter({
  windowMs: 60 * 60 * 1000,
  max: 5,
  keyGenerator: byUserId,
  message: "Too many email change requests. Try again later.",
});

/**
 * Re-checking the caller's own password — profileService.assertPassword, called by
 * PATCH /profile/email, PATCH /profile/password and POST /profile/deletion.
 *
 * ONE shared limiter across all three routes, not three separate ones: they all guard
 * the same secret (the account's current password), so a budget that reset by simply
 * switching endpoints would not actually cap anything. Every consumer below passes
 * this exact instance for that reason - do not build three limiter({...}) calls that
 * happen to look alike.
 *
 * COUNTS FAILED ATTEMPTS ONLY, same reasoning as loginLimiter: with a stolen or
 * hijacked session already in hand, an attacker can otherwise guess the password
 * without limit (one bcrypt compare each) and then change the email or delete the
 * account - exactly what the re-check exists to stop.
 */
export const passwordRecheckLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  keyGenerator: byUserId,
  message: "Too many attempts. Try again in a few minutes.",
});

/**
 * Uploading a photo — POST /listings/:id/photos, /bookings/:id/photos, and the
 * attachment on /bookings/:id/messages.
 *
 * ONE shared limiter across all three, same reasoning as passwordRecheckLimiter: what
 * is being capped is how much memory-buffering and Cloudinary-storage cost one signed-
 * in ACCOUNT can make the server spend, not any one route's quota — an attacker who
 * exhausted the budget on listing photos must not get a fresh one by switching to
 * booking photos.
 *
 * COUNTS EVERY REQUEST, successes included: unlike a credential guess, a rejected
 * upload (wrong type, too big, wrong party — see requireBookingParty/
 * requireListingOwner in resourceAccessMiddleware.js) has ALREADY spent the memory
 * and, for `requireBookingParty`/`requireListingOwner` failures specifically, cost a
 * database round trip too. Only skipping successes would leave the exact abuse this
 * exists to cap — many bad requests in a row — uncounted.
 *
 * 30/hour is generous for genuine use (nobody uploads thirty photos across three
 * different endpoints in an hour by hand) and tight enough to bound the memory and
 * Cloudinary-quota cost of one compromised or malicious account.
 */
export const uploadLimiter = limiter({
  windowMs: 60 * 60 * 1000,
  max: 30,
  keyGenerator: byUserId,
  message: "Too many uploads. Try again later.",
});

/**
 * `uploadLimiter`, but only when the request actually carries a file.
 *
 * FOR /bookings/:id/messages ONLY — that route serves both a plain-text message and
 * one with a photo attached, so `uploadLimiter` cannot sit on it unconditionally the
 * way it does on the two photo-only routes: every text message would then compete
 * for the same 30/hour budget as a genuine photo upload, throttling ordinary chat.
 * Mount this AFTER the multer parser (`acceptMessageAttachment`), so `req.file` is
 * already populated by the time this checks it.
 *
 * @type {import("express").RequestHandler}
 */
export function limitUploadsOnlyIfAttached(req, res, next) {
  if (!req.file) return next();
  return uploadLimiter(req, res, next);
}

/**
 * Rate limits, on the unauthenticated endpoints only.
 *
 * Deliberately NOT applied globally. A limiter over the authenticated API would
 * throttle ordinary use - a browse page firing several requests, a search-as-you-type
 * box - and the pre-auth routes are the only ones where a high rate is never
 * legitimate.
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
 * @returns {import("express").RequestHandler}
 */
function limiter({ windowMs, max, skipSuccessfulRequests = false, message }) {
  const store = new MemoryStore();
  stores.push(store);

  return rateLimit({
    windowMs,
    max,
    store,
    skipSuccessfulRequests,
    standardHeaders: true,
    legacyHeaders: false,

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

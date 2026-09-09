/**
 * Auth routes.
 *
 * Read top to bottom, this file answers "what URLs exist and who may call them?".
 * Middleware order in each line is execution order.
 */

import { Router } from "express";
import {
  postRegister,
  postVerify,
  postResendVerification,
  postLogin,
  postLogout,
  getMe,
  getCurrentTerms,
  postForgotPassword,
  postResetPassword,
} from "../controllers/authController.js";
import {
  registerSchema,
  verifySchema,
  loginSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
} from "../validators/authValidator.js";
import { validateBody } from "../validators/validate.js";
import { requireAuth } from "../middlewares/authMiddleware.js";
import {
  registerLimiter,
  loginLimiter,
  verifyLimiter,
  passwordResetLimiter,
  passwordResetConfirmLimiter,
} from "../middlewares/rateLimiter.js";

const router = Router();

// Public. Rate limited counting SUCCESSES too — a success here sends an email, so the
// abuse being capped is mail-quota burn and spamming third parties.
router.post("/register", registerLimiter, validateBody(registerSchema), postRegister);

// Public: the person clicking the link has no session yet, by definition.
router.post("/verify", verifyLimiter, validateBody(verifySchema), postVerify);

// Requires a session — the caller is signed in but unverified, so there is no address
// for a stranger to guess and no oracle to protect.
router.post("/verify/resend", requireAuth, postResendVerification);

// Rate limited on FAILED attempts only: a household or an office behind one NAT is a
// single IP, and counting successes would throttle everyone signing in at once.
router.post("/login", loginLimiter, validateBody(loginSchema), postLogin);

// Public, and rate limited counting SUCCESSES: a success sends an email. Answers 202
// identically for a live account, a suspended one, an unknown address and a request
// inside the cooldown - the caller learns nothing about who has an account.
router.post(
  "/forgot-password",
  passwordResetLimiter,
  validateBody(forgotPasswordSchema),
  postForgotPassword
);

// Public: whoever clicked the emailed link has no session, and deliberately does not
// get one from this either (FR-025). Every token failure answers an identical 410.
router.post(
  "/reset-password",
  passwordResetConfirmLimiter,
  validateBody(resetPasswordSchema),
  postResetPassword
);

// Public deliberately: logging out must work whether or not a session exists.
router.post("/logout", postLogout);

router.get("/me", requireAuth, getMe);

// Public — the registration form needs it before anyone has an account.
router.get("/terms/current", getCurrentTerms);

export { router as authRoutes };

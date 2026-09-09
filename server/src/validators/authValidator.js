/**
 * Request validation for the auth routes.
 *
 * Nothing checks a request body at build time in a JavaScript codebase, so these
 * schemas are the only thing between a malformed payload and a service function.
 */

import { z } from "zod";

/** Length beats complexity rules, which measurably push people toward "Password1!". */
const MIN_PASSWORD_LENGTH = 10;

/**
 * POST /api/auth/register
 *
 * Note what is ABSENT: `role`, `isAdmin`, `status`, `emailVerified`. Zod strips unknown
 * keys, so a body carrying any of them is discarded rather than reaching a service —
 * which is the difference between "we don't read that field" and "that field cannot be
 * set from outside".
 */
export const registerSchema = z.object({
  // Shown to the person handing over a camera worth tens of thousands of rupees.
  name: z.string().trim().min(1, "Name is required").max(120),

  // Lowercased at the boundary so everything downstream — the unique index, the
  // token's stored address, the mail recipient — agrees on one form.
  email: z
    .string()
    .trim()
    .toLowerCase()
    .min(1, "Email is required")
    .email("Must be a valid email")
    // 254 is the RFC 5321 maximum for a full address.
    .max(254),

  // No maximum, deliberately. bcrypt hashes to a fixed size, so a long passphrase costs
  // nothing to store, and a cap only ever weakens the strongest passwords people pick.
  password: z
    .string()
    .min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`),

  // Optional at signup. Verified later as a higher trust tier gating high-value
  // listings — asking for it now with no way to check it would be theatre.
  phone: z.string().trim().min(6).max(20).optional(),

  // Must be present, and must MATCH the current version — the match is checked in the
  // service, which knows what current is. A stale value means the page was open when
  // the terms changed, and recording agreement to terms nobody saw is exactly what
  // this field exists to prevent.
  acceptedTermsVersion: z.string().min(1, "You must accept the terms to continue"),
});

/**
 * POST /api/auth/verify
 *
 * The token arrives in the BODY, never a query string: a token in a URL lands in
 * browser history, server access logs, and any `Referer` header sent to a third-party
 * asset on the confirmation page.
 */
export const verifySchema = z.object({
  token: z.string().min(1),
});

/** POST /api/auth/login */
export const loginSchema = z.object({
  email: z.string().trim().min(1, "Email is required").email("Must be a valid email"),

  // No length rule on sign-in. Rejecting a short password here would tell an attacker
  // their guess failed a POLICY check rather than a comparison — and would lock out
  // anyone whose password predates a policy change.
  password: z.string().min(1, "Password is required"),
});

/**
 * POST /api/auth/forgot-password
 *
 * Validates the SHAPE of the address and nothing else. A malformed email is a genuine
 * client error and safe to report — it says nothing about which addresses are
 * registered, because it is refused before any lookup happens.
 */
export const forgotPasswordSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .min(1, "Email is required")
    .email("Must be a valid email")
    .max(254),
});

/**
 * POST /api/auth/reset-password
 *
 * The token arrives in the BODY, never a query string — same reasoning as verification,
 * and it matters more here: this token sets a password, so a copy of it in an access log
 * or a `Referer` header is a copy of an account-takeover credential.
 *
 * The password rule is the SAME `MIN_PASSWORD_LENGTH` as registration, deliberately. A
 * reset that accepted a weaker password than signup would make this endpoint the way to
 * get around the policy — and one that demanded a stronger one would refuse a password
 * the account could legitimately already have.
 */
export const resetPasswordSchema = z.object({
  token: z.string().min(1),
  password: z
    .string()
    .min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`),
});

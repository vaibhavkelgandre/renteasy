/**
 * Request validation for the profile routes.
 *
 * Note what is ABSENT from every schema here: `email`, `status`, `isAdmin`,
 * `emailVerified`, `id`. Zod strips unknown keys, so a body carrying any of them is
 * discarded rather than reaching a service — the difference between "we don't read
 * that field" and "that field cannot be set from outside". Changing an email has its
 * own endpoint precisely because it needs proof, and it must not be reachable by
 * smuggling a key into a name update.
 */

import { z } from "zod";

/** Kept identical to the registration and reset rule. See below. */
const MIN_PASSWORD_LENGTH = 10;

const nameField = z.string().trim().min(1, "Name is required").max(120);

/**
 * PATCH /api/profile
 *
 * Every field optional, with a whole-object refinement requiring at least one — a body
 * of `{}` is a request that means nothing, and answering 200 to it would suggest
 * something was saved.
 *
 * `phone` accepts `null` as well as a string, and the difference is deliberate:
 * `undefined` (absent) means "leave it alone", `null` means "clear it". Without that
 * distinction there is no way to remove a phone number once entered.
 *
 * Phone editing is a small step beyond FR-029's literal "edit name". It is included
 * because the field is captured at signup and was otherwise uncorrectable — a typo'd
 * number could never be fixed by anyone. It grants nothing: the number is unverified
 * either way, and FR-036 gates high-value listings on a VERIFIED phone, which is a
 * separate flow (FR-035) that does not exist yet.
 */
export const updateProfileSchema = z
  .object({
    name: nameField.optional(),
    phone: z.string().trim().min(6).max(20).nullable().optional(),
  })
  .refine((body) => body.name !== undefined || body.phone !== undefined, {
    message: "Nothing to update",
  });

/**
 * PATCH /api/profile/email
 *
 * The password is required here, not decoration: a session cookie proves the browser
 * was signed in at some point, not that the person at the keyboard owns the account.
 * Moving the address is the single most account-takeover-adjacent action available, so
 * it costs a password.
 */
export const changeEmailSchema = z.object({
  // Lowercased at the boundary so everything downstream — the uniqueness check, the
  // stored pending address, the token's recorded address, the mail recipient — agrees
  // on one form.
  newEmail: z
    .string()
    .trim()
    .toLowerCase()
    .min(1, "Email is required")
    .email("Must be a valid email")
    .max(254),

  currentPassword: z.string().min(1, "Enter your current password"),
});

/**
 * PATCH /api/profile/password
 *
 * `newPassword` carries the SAME minimum as registration and password reset. All three
 * must agree: a weaker rule anywhere is the way around the policy, and a stronger one
 * would refuse a password the account could legitimately already have.
 *
 * `currentPassword` has no length rule, deliberately — rejecting a short one would tell
 * a caller their guess failed a POLICY check rather than a comparison, and would lock
 * out anyone whose password predates a policy change.
 */
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Enter your current password"),
  newPassword: z
    .string()
    .min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`),
});

/** POST /api/profile/deletion */
export const deleteAccountSchema = z.object({
  currentPassword: z.string().min(1, "Enter your current password"),
});

/**
 * GET /api/users/:id/public
 *
 * Shape-checked before it reaches SQL. A non-UUID passed to `WHERE id = $1` arrives at
 * Postgres as an invalid uuid literal and raises 22P02, which no error branch handles —
 * so `/users/banana/public` would answer 500 with a stack trace instead of a clean 404.
 */
export const publicProfileParamsSchema = z.object({
  id: z.string().uuid(),
});

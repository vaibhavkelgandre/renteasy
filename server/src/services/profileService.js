/**
 * A user's own account: view, edit, change email, change password, delete.
 *
 * Spec: docs/features/03-profile.md. Every function here acts on the CALLER's own
 * record and takes the actor's id from the session — never from the request body.
 * There is no "edit user X" path, so there is no authorization decision to get wrong.
 *
 * The one function worth reading before changing anything is `requestEmailChange`: it
 * carries the same non-disclosure rule as registration, for the same reason.
 */

import { hashPassword, verifyPassword } from "../utils/password.js";
import { issueToken } from "../utils/secureToken.js";
import { badRequest, notFound, unauthorized } from "../utils/errors.js";
import {
  findUserById,
  findUserByEmail,
  findUserByEmailWithHash,
  updateProfileFields,
  updatePasswordHash,
  setPendingEmail,
  clearPendingEmail,
  softDeleteUser,
  findPublicProfileById,
} from "../repositories/userRepository.js";
import { issueVerificationToken } from "../repositories/verificationTokenRepository.js";
import { invalidateResetTokensForUser } from "../repositories/passwordResetTokenRepository.js";
import { sendVerificationEmail } from "./mailService.js";

/**
 * Re-checks the caller's password before a sensitive change.
 *
 * WHY EVERY SENSITIVE ACTION RE-ASKS: a session cookie proves the browser was signed in
 * at some point, not that the person at the keyboard is the account's owner. An
 * unlocked laptop, a shared machine, or a stolen session are all cases where the cookie
 * is valid and the human is not. Changing the email or deleting the account are both
 * irreversible from the real owner's side, so they cost a password.
 *
 * Reads the hash by EMAIL rather than by id because `findUserByEmailWithHash` is the
 * single deliberate exception that returns a hash at all — named that way so reaching
 * for it by mistake is hard.
 *
 * @param {object} user The session user.
 * @param {string} currentPassword
 * @returns {Promise<void>}
 * @throws {AppError} 401 if it does not match, with a field-keyed message so the form
 *         can put it under the right box.
 */
async function assertPassword(user, currentPassword) {
  const withHash = await findUserByEmailWithHash(user.email);
  if (!withHash || !(await verifyPassword(currentPassword, withHash.password_hash))) {
    const error = unauthorized("That password is not correct.");
    error.errors = { currentPassword: "That password is not correct." };
    throw error;
  }
}

/**
 * Updates the caller's own editable fields — FR-029.
 *
 * @param {object} user The session user.
 * @param {object} input
 * @param {string} [input.name]
 * @param {string|null} [input.phone]
 * @returns {Promise<object>} The updated user.
 * @throws {AppError} 404 if the account is no longer active.
 */
export async function updateProfile(user, { name, phone }) {
  const updated = await updateProfileFields(user.id, { name, phone });
  if (!updated) throw notFound("Account not found");
  return updated;
}

/**
 * Starts an email change — FR-030, FR-031.
 *
 * NOTHING ABOUT THE ACCOUNT CHANGES HERE. The current address keeps signing in and keeps
 * receiving password resets until someone proves control of the new one by clicking a
 * link sent to it. A typo therefore costs nothing; overwriting the address immediately
 * would lock the account out permanently, because the new address never receives the
 * link and the old one is already gone.
 *
 * THE NON-DISCLOSURE RULE, WHICH IS THE WHOLE REASON THIS RETURNS NOTHING: the response
 * is identical whether the address is free, already belongs to somebody else, or is the
 * caller's own. Refusing with "that email is taken" would hand any signed-in user an
 * enumeration oracle over the entire platform — register one account, then probe
 * addresses one at a time. That would defeat the property registration goes to such
 * lengths to protect (features/01 §3.1), just from inside instead of outside.
 *
 * FR-031 comes free rather than by a sweep: `issueVerificationToken` replaces any live
 * token via the `uq_evt_active_user` partial index, so requesting a change kills the
 * previous link in the same statement that mints the new one.
 *
 * @param {object} user The session user.
 * @param {object} input
 * @param {string} input.newEmail Already lowercased by the validator.
 * @param {string} input.currentPassword
 * @returns {Promise<void>} Nothing, deliberately — see above.
 * @throws {AppError} 401 for a wrong password. That is safe to disclose: it is a fact
 *         about the caller's own credential, not about anyone else's address.
 */
export async function requestEmailChange(user, { newEmail, currentPassword }) {
  await assertPassword(user, currentPassword);

  // Their own current address. Nothing to do, and nothing to say — answering
  // differently here would confirm which address the account uses to someone reading
  // over a shoulder.
  if (newEmail.toLowerCase() === user.email.toLowerCase()) return;

  const existing = await findUserByEmail(newEmail);

  // Taken by someone else. Silent: no token, no email, no error. The address's real
  // owner is deliberately NOT notified either — that would let a caller use this
  // endpoint to send mail to any address they can type, which is the abuse the
  // registration flow's rate limit and identical response exist to prevent together.
  if (existing) return;

  const pending = await setPendingEmail(user.id, newEmail);
  if (!pending) return;

  const { raw, hash } = issueToken();
  await issueVerificationToken({ userId: user.id, tokenHash: hash, email: newEmail });

  // Fire and forget, for the same two reasons as registration: a mail outage must not
  // fail a change that is already recorded, and an awaited send would add a timing
  // signal on top of the one the identical response exists to remove.
  void sendVerificationEmail({ to: newEmail, name: user.name, rawToken: raw }).catch((error) => {
    // The ADDRESS and the failure, never the link.
    console.error(`[mail] email-change send failed for ${newEmail}: ${error.message}`);
  });
}

/**
 * Abandons a pending email change.
 *
 * Needed because the alternative is a profile page stuck showing "pending confirmation"
 * forever after a typo — the token expires in 24 hours but `pending_email` would not.
 *
 * Deliberately does NOT require a password: it removes a capability rather than
 * granting one, and the worst an attacker achieves is cancelling a change the real
 * owner can simply request again.
 *
 * @param {object} user The session user.
 * @returns {Promise<object>} The updated user.
 * @throws {AppError} 404 if the account is no longer active.
 */
export async function cancelEmailChange(user) {
  const updated = await clearPendingEmail(user.id);
  if (!updated) throw notFound("Account not found");
  return updated;
}

/**
 * Changes the caller's password — FR-032.
 *
 * @param {object} user The session user.
 * @param {object} input
 * @param {string} input.currentPassword
 * @param {string} input.newPassword
 * @returns {Promise<void>}
 * @throws {AppError} 401 for a wrong current password, 400 if the new one matches it.
 */
export async function changePassword(user, { currentPassword, newPassword }) {
  await assertPassword(user, currentPassword);

  if (currentPassword === newPassword) {
    throw badRequest("Choose a password different from your current one.", {
      newPassword: "Choose a password different from your current one.",
    });
  }

  const passwordHash = await hashPassword(newPassword);
  const updated = await updatePasswordHash(user.id, passwordHash);
  if (!updated) throw notFound("Account not found");

  // Any reset link already in an inbox is now a way back into an account whose owner
  // has just deliberately changed its password. Kill it: the most likely reason
  // somebody changes a password is that they think someone else has it.
  await invalidateResetTokensForUser(user.id);
}

/**
 * Deletes the caller's own account — FR-034.
 *
 * SOFT, and the consequences are real enough to be worth stating at the call site as
 * well as in the schema: the row survives, so the address stays claimed by
 * `uq_users_email_lower` and cannot be reused to register again. There is no
 * self-service undo and no admin restore screen.
 *
 * @param {object} user The session user.
 * @param {object} input
 * @param {string} input.currentPassword
 * @returns {Promise<void>}
 * @throws {AppError} 401 for a wrong password.
 */
export async function deleteOwnAccount(user, { currentPassword }) {
  await assertPassword(user, currentPassword);

  await softDeleteUser(user.id);

  // Whatever is outstanding must not survive the account. A reset link would otherwise
  // still be sitting in an inbox pointing at a deleted account.
  await invalidateResetTokensForUser(user.id);
}

/**
 * The public view of somebody's profile — FR-033.
 *
 * @param {string} id
 * @returns {Promise<object>} Name, member-since, and whether the email is confirmed.
 * @throws {AppError} 404 if absent, suspended or deleted — the same answer for all
 *         three, because a stranger has no more reason to learn that an account was
 *         suspended than to learn it never existed.
 */
export async function getPublicProfile(id) {
  const profile = await findPublicProfileById(id);
  if (!profile) throw notFound("Profile not found");

  return {
    id: profile.id,
    name: profile.name,
    memberSince: profile.created_at,
    emailVerified: profile.email_verified,

    // Placeholders with an honest shape rather than invented numbers. FR-033 asks for a
    // rating and a listing count; neither has a table yet (steps 3 and 9), and a
    // hardcoded 0 would read as "this person has no listings" rather than "listings do
    // not exist". null says "unknown", which is true.
    rating: null,
    listingCount: null,
  };
}

/**
 * Re-reads the caller's own record — FR-028.
 *
 * `/auth/me` already returns this, so this exists only for the profile page to refresh
 * after a change without re-deriving what a session is.
 *
 * @param {object} user The session user.
 * @returns {Promise<object>}
 * @throws {AppError} 404 if the account is gone.
 */
export async function getOwnProfile(user) {
  const fresh = await findUserById(user.id);
  if (!fresh) throw notFound("Account not found");
  return fresh;
}

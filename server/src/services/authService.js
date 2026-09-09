/**
 * Registration, verification and sign-in.
 *
 * Spec: docs/features/01-public-registration.md. The two decisions worth reading
 * before changing anything here are §3.1 (a duplicate email must not produce a
 * different answer) and §3.4 (a token verifies an address, not a user).
 */

import { hashPassword, verifyPassword } from "../utils/password.js";
import { issueToken, hashToken } from "../utils/secureToken.js";
import { signAuthToken } from "../utils/jwt.js";
import { conflict, gone, unauthorized } from "../utils/errors.js";
import { env } from "../config/env.js";
import {
  findUserById,
  findUserByEmail,
  findUserByEmailWithHash,
  insertUser,
  markEmailVerified,
  confirmEmailChange,
} from "../repositories/userRepository.js";
import {
  issueVerificationToken,
  findTokenByHash,
  consumeToken,
  lastIssuedAt,
} from "../repositories/verificationTokenRepository.js";
import {
  issuePasswordResetToken,
  findResetTokenByHash,
  consumeTokenAndSetPassword,
  resetTokenPolicy,
  invalidateResetTokensForUser,
} from "../repositories/passwordResetTokenRepository.js";
import {
  sendVerificationEmail,
  sendAlreadyRegisteredEmail,
  sendPasswordResetEmail,
} from "./mailService.js";

/** How long before a resend is allowed again. */
const RESEND_COOLDOWN_MINUTES = 2;

/**
 * Issues a token and emails it. Shared by registration and resend so the two cannot
 * drift into sending different things.
 *
 * @param {object} user
 * @returns {Promise<void>}
 */
async function issueAndSendVerification(user) {
  const { raw, hash } = issueToken();

  // The hash is stored; `raw` goes into the email and is then unreachable. There is no
  // way to recover it from the database — which is the point, and is also why the test
  // suite reads it from the mail outbox.
  await issueVerificationToken({ userId: user.id, tokenHash: hash, email: user.email });

  // Fire and forget. A mail outage must not fail registration: the user row and the
  // token are already committed, so the account exists and "resend" will work. An
  // awaited send would also add a second timing signal on top of the one §3.1 goes to
  // such lengths to remove.
  void sendVerificationEmail({ to: user.email, name: user.name, rawToken: raw }).catch((error) => {
    // The ADDRESS and the failure, never the link. That log line would otherwise
    // publish a working single-use credential to anyone who can read the logs.
    console.error(`[mail] verification send failed for ${user.email}: ${error.message}`);
  });
}

/**
 * Registers an account — or deliberately does not, without saying which.
 *
 * THE CENTRAL RULE (§3.1): this function returns the same thing for a new email, an
 * existing unverified email and an existing verified email. The difference is in which
 * email gets sent, never in what the caller learns.
 *
 * @param {object} input
 * @param {string} input.name
 * @param {string} input.email
 * @param {string} input.password Plain. Never logged, never stored.
 * @param {string} [input.phone]
 * @param {string} input.acceptedTermsVersion
 * @returns {Promise<void>} Nothing, on purpose. There is no user object to return
 *          without disclosing whether one was created.
 * @throws {AppError} 409 only if the accepted terms version is stale — which is about
 *         the request, not about the account, and so is safe to disclose.
 */
export async function register({ name, email, password, phone, acceptedTermsVersion }) {
  if (acceptedTermsVersion !== env.termsVersion) {
    // Safe to be specific: it says nothing about whether the email is registered, and
    // the client genuinely needs to reload to show the current terms.
    throw conflict("The terms have been updated. Please review and accept the current version.");
  }

  // HASHED FIRST, BEFORE THE LOOKUP, ON EVERY PATH — even when the result is thrown
  // away moments later.
  //
  // bcrypt costs ~60ms. If it only ran when the email was new, a caller could time two
  // requests and learn which addresses exist, rebuilding exactly the oracle the
  // identical response exists to remove. Doing the expensive thing unconditionally is
  // what makes the three paths indistinguishable from outside.
  const passwordHash = await hashPassword(password);

  const existing = await findUserByEmail(email);

  if (!existing) {
    try {
      const user = await insertUser({
        name,
        email,
        passwordHash,
        phone: phone ?? null,
        acceptedTermsVersion,
      });
      await issueAndSendVerification(user);
    } catch (error) {
      // 23505 = the unique index fired, meaning a concurrent request created this
      // email between our lookup and our insert. Swallowed on purpose: surfacing it
      // would be the enumeration oracle arriving by another route, and from the
      // caller's point of view the outcome is the same as any other duplicate.
      if (error.code !== "23505") throw error;
    }
    return;
  }

  // A suspended account must not be able to self-restore, and must not be told it is
  // suspended by a stranger probing the address. Nothing happens, silently.
  if (existing.status !== "ACTIVE") return;

  if (existing.email_verified_at) {
    // The address belongs to a real, verified account. Tell its OWNER — in the inbox,
    // where only they can read it — rather than telling the caller.
    void sendAlreadyRegisteredEmail({ to: existing.email, name: existing.name }).catch((error) => {
      console.error(`[mail] already-registered send failed for ${existing.email}: ${error.message}`);
    });
    return;
  }

  // Registered but never confirmed. Almost always the same person trying again because
  // the first email did not arrive — so reissue rather than refuse. The old link dies,
  // which is what `uq_evt_active_user` guarantees.
  await issueAndSendVerification(existing);
}

/**
 * Reports whether a token's address is already confirmed.
 *
 * Only ever reached for a token that has been used, so the holder demonstrably
 * received the email at that address — telling them it is confirmed discloses nothing
 * they do not already know.
 *
 * @param {object} token
 * @returns {Promise<boolean>}
 */
async function addressAlreadyConfirmed(token) {
  const user = await findUserById(token.user_id);
  return Boolean(
    user &&
      user.email_verified_at &&
      user.email.toLowerCase() === token.email.toLowerCase()
  );
}

/**
 * Consumes a verification token.
 *
 * Branches on the token's ACTUAL state rather than filtering states out in the query,
 * because "already confirmed" and "no" are different answers and only one of them is
 * an error.
 *
 * @param {string} rawToken
 * @returns {Promise<{ alreadyVerified: boolean }>}
 * @throws {AppError} 410 for unknown, expired, replayed-after-an-email-change, or
 *         malformed. Several causes, ONE message — any difference tells someone
 *         guessing tokens which guesses were closer.
 */
export async function verifyEmail(rawToken) {
  const token = await findTokenByHash(hashToken(rawToken));
  if (!token) throw gone();

  // Expiry is checked before anything else, and it applies to the already-confirmed
  // path too. Otherwise a used token would remain a permanent "yes, this address is
  // confirmed" oracle; bounding it to the original 24 hours costs nothing.
  if (new Date(token.expires_at) <= new Date()) throw gone();

  if (token.used_at) {
    // A second click. Mail clients prefetch links, and a user clicking twice has done
    // nothing wrong — so this is a 200, not an error.
    if (await addressAlreadyConfirmed(token)) return { alreadyVerified: true };

    // Used, but the address is NOT confirmed: the user changed their email after the
    // token was issued. The token proves control of the old address and nothing about
    // the new one.
    throw gone();
  }

  // Claim it atomically. If a prefetch and a real click race, exactly one wins here.
  const claimed = await consumeToken(token.id);
  if (!claimed) {
    // Lost the race. The winner did the work a moment ago, so report what they
    // achieved rather than an error for a click that was perfectly valid.
    if (await addressAlreadyConfirmed(token)) return { alreadyVerified: true };
    throw gone();
  }

  // WHICH ADDRESS DOES THIS TOKEN PROVE? Two legitimate answers, and they need
  // different writes — this is the one place the initial signup flow and the profile's
  // email change (FR-030) meet.
  const account = await findUserById(token.user_id);
  if (!account) throw gone();

  const provenAddress = token.email.toLowerCase();

  // (a) The account's CURRENT address. Ordinary first-time verification.
  if (account.email.toLowerCase() === provenAddress) {
    const user = await markEmailVerified(token.user_id, token.email);
    if (!user) throw gone();
    return { alreadyVerified: false, emailChanged: false };
  }

  // (b) The account's PENDING address. Confirming an email change: only now does the
  // new address become the real one, which is what lets the old address keep working
  // right up until this moment.
  if (account.pending_email && account.pending_email.toLowerCase() === provenAddress) {
    let user;
    try {
      user = await confirmEmailChange(token.user_id, token.email);
    } catch (error) {
      // 23505 = somebody else registered this address while the link sat in an inbox.
      // The index arbitrates rather than a check-then-write, so this is the ordinary
      // outcome of a race, not a server fault. 410 like every other token failure:
      // distinguishing "taken" here would disclose that the address is now in use.
      if (error.code === "23505") throw gone();
      throw error;
    }
    if (!user) throw gone();

    // The address that can recover this account has just changed. Any reset link
    // already sitting in the OLD inbox must die now rather than merely fail to match
    // later.
    await invalidateResetTokensForUser(token.user_id);

    return { alreadyVerified: false, emailChanged: true };
  }

  // The token proves control of an address this account no longer has anything to do
  // with — it was issued, then the change was cancelled or superseded. It proves
  // nothing about the current address, so nothing is confirmed.
  throw gone();
}

/**
 * Reissues a verification email for a signed-in, unverified user.
 *
 * @param {object} user The authenticated user.
 * @returns {Promise<void>}
 * @throws Never. Every outcome — already verified, too soon, sent — is silent, because
 *         the caller is told the same thing regardless (§3.1's rule applied to a
 *         second endpoint).
 */
export async function resendVerification(user) {
  if (user.email_verified_at) return;

  const last = await lastIssuedAt(user.id);
  if (last) {
    const minutesSince = (Date.now() - new Date(last).getTime()) / 60000;
    // Returns silently rather than reporting "too soon". Even here the caller is
    // authenticated, so there is no oracle — but keeping every path identical means
    // the client needs no special case and cannot accidentally reveal timing.
    if (minutesSince < RESEND_COOLDOWN_MINUTES) return;
  }

  await issueAndSendVerification(user);
}

/**
 * Authenticates a user.
 *
 * An UNVERIFIED user may sign in (§3.3). Blocking them would strand anyone whose email
 * was slow, filtered or mistyped, with nothing to click. The gate is on the actions —
 * listing, booking, negotiating — not on the door.
 *
 * @param {object} credentials
 * @param {string} credentials.email
 * @param {string} credentials.password
 * @returns {Promise<{ user: object, token: string }>}
 * @throws {AppError} 401 for a wrong email, a wrong password, or a suspended account —
 *         all with the identical message.
 */
export async function login({ email, password }) {
  const user = await findUserByEmailWithHash(email);
  const message = "Invalid email or password";

  if (!user) {
    // Compare against a dummy hash so a missing account costs the same ~60ms as a real
    // one. Without it, a missing user returns in ~1ms — measurable over a handful of
    // requests, and it rebuilds the enumeration oracle from the sign-in side.
    await verifyPassword(password, "$2b$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin");
    throw unauthorized(message);
  }

  if (!(await verifyPassword(password, user.password_hash))) throw unauthorized(message);

  // Checked AFTER the password. Checking first would let anyone discover which
  // accounts are suspended without knowing a password.
  if (user.status !== "ACTIVE") throw unauthorized(message);

  const { password_hash: _hash, ...safeUser } = user;
  return { user: safeUser, token: signAuthToken(user.id) };
}

/**
 * Starts a password reset — or deliberately does not, without saying which.
 *
 * SAME CENTRAL RULE AS REGISTRATION (§3.1, and FR-021): this function returns the same
 * thing for a live account, a suspended one, an unknown address and an address inside
 * its cooldown. The difference is only ever in whether an email is sent.
 *
 * THREE PROPERTIES BELOW EXIST SOLELY TO PROTECT THAT, and all three are easy to undo
 * without noticing:
 *
 *   1. The send is fire-and-forget, NEVER awaited. An awaited provider round trip is
 *      hundreds of milliseconds for a real account against a couple for an unknown
 *      one — a single-request-pair timing oracle that hands back exactly what the
 *      identical response withholds. This is a security decision, not a performance
 *      one.
 *   2. A delivery failure must never become a 5xx. Same leak by another route: 500 for
 *      real accounts and 202 for unknown ones, throughout any mail outage. Do not
 *      "fix" the .catch into a throw.
 *   3. The cooldown returns silently, byte-identically to a normal response.
 *
 * @param {object} input
 * @param {string} input.email
 * @returns {Promise<void>} Nothing, on purpose. There is nothing to hand back that
 *          would not disclose whether the address is registered.
 * @throws Never, other than an unexpected database failure.
 */
export async function requestPasswordReset({ email }) {
  const user = await findUserByEmail(email);

  // Unknown address. Nothing to do, and nothing said. Note we do NOT email the address
  // to say "you have no account here" — that would turn this endpoint into a way to
  // send mail to any address a caller can type, which is the abuse the rate limit and
  // this silence exist to prevent together.
  if (!user) return;

  // A suspended or deleted account must not be recoverable by whoever can read that
  // inbox. Silent, so a stranger probing the address cannot learn the status either.
  if (user.status !== "ACTIVE") return;

  // An UNVERIFIED account can still reset. They have a password and may well have
  // forgotten it, and the link goes to the address on the account either way.
  //
  // Deliberately NOT also marking the address verified on a successful reset, even
  // though clicking the link does demonstrate control of it. Keeping the two flows
  // separate means neither can be changed into the other by accident — and "reset your
  // password" quietly conferring a verified status is exactly the kind of coupling
  // nobody remembers a year later.
  const { raw, hash } = issueToken();

  const issued = await issuePasswordResetToken({
    userId: user.id,
    tokenHash: hash,
    email: user.email,
  });

  // Null means the cooldown blocked it. Return silently: the link from a few minutes
  // ago is still valid for the rest of the hour, so the user has already got what they
  // asked for.
  if (!issued) return;

  void sendPasswordResetEmail({
    to: user.email,
    name: user.name,
    rawToken: raw,
    ttlHours: resetTokenPolicy.ttlHours,
  }).catch((error) => {
    // THE ADDRESS AND THE FAILURE, NEVER THE LINK. That log line would otherwise
    // publish a live account-takeover credential to anyone who can read the logs —
    // which is the single worst thing this file could do.
    console.error(`[mail] password reset send failed for ${user.email}: ${error.message}`);
  });
}

/**
 * Completes a password reset.
 *
 * Every failure answers identically (FR-024), and the causes are: unknown token,
 * expired, already used, the account's address changed since it was issued, and the
 * account is no longer active. Distinguishing any of them would tell someone guessing
 * tokens which guesses were closer, and would turn a valid-token-wrong-state answer
 * into a probe.
 *
 * DOES NOT SIGN ANYONE IN (FR-025), and sets no cookie. The person holding the link
 * has proved control of an inbox, which is a good reason to let them set a password and
 * a poor one to hand them a live session — if a reset email is read by someone who
 * should not have it, a session means immediate access while a password change is at
 * least visible to the real owner the next time they sign in.
 *
 * @param {string} rawToken
 * @param {string} password The new password, plain. Never logged.
 * @returns {Promise<void>}
 * @throws {AppError} 410 for every token failure, with one message.
 */
export async function resetPassword(rawToken, password) {
  const token = await findResetTokenByHash(hashToken(rawToken));
  if (!token) throw gone();

  if (new Date(token.expires_at) <= new Date()) throw gone();

  // Checked here as well as in the claim below. Not redundant defence for its own
  // sake: this branch is what keeps the expensive hash off the path for a token that
  // is already spent, so replaying a used token cannot be used to make the server do
  // bcrypt work on demand.
  if (token.used_at) throw gone();

  const passwordHash = await hashPassword(password);

  // One statement: claims the token and sets the password, or does neither. See the
  // repository — the two-statement version is wrong in both possible orders, and one
  // of those orders leaves a live replayable link after the password has changed.
  const user = await consumeTokenAndSetPassword({ tokenId: token.id, passwordHash });

  // Lost the race, or the address changed, or the account is no longer active. One
  // answer for all three.
  if (!user) throw gone();
}

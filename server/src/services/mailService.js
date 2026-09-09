/**
 * What each message says. Templates only — this file knows nothing about transports.
 *
 * It never catches. A delivery failure is the caller's to decide about, and in this
 * application the answer is always "log it and carry on" (see authService §register).
 */

import { sendMail } from "../config/mailer.js";
import { env } from "../config/env.js";

/**
 * Builds the link a recipient clicks.
 *
 * Points at a FRONTEND route, which reads the token and POSTs it. The token never
 * appears in a URL the API handles, because a token in a query string lands in browser
 * history, server access logs, and any `Referer` header sent to a third-party asset on
 * the page.
 *
 * @param {string} rawToken
 * @returns {string}
 */
function verificationLink(rawToken) {
  return `${env.appUrl}/verify/${rawToken}`;
}

/**
 * "Confirm your email" — sent to a genuinely new registration, and on every resend.
 *
 * @param {object} input
 * @param {string} input.to
 * @param {string} input.name
 * @param {string} input.rawToken
 * @returns {Promise<boolean>}
 * @throws {Error} If the transport throws. Deliberately not caught here.
 */
export function sendVerificationEmail({ to, name, rawToken }) {
  return sendMail({
    to,
    subject: "Confirm your email for RentEasy",
    text: [
      `Hi ${name},`,
      ``,
      `Confirm this address to finish setting up your RentEasy account:`,
      ``,
      verificationLink(rawToken),
      ``,
      `The link works once and expires in 24 hours.`,
      ``,
      `You can browse listings without confirming, but you will need to confirm`,
      `before you can list something or book anything.`,
      ``,
      `If you did not sign up, you can ignore this email — no account is active`,
      `until this link is used.`,
    ].join("\n"),
  });
}

/**
 * "Someone tried to register with your email" — sent when the address is ALREADY a
 * verified account.
 *
 * THIS EMAIL IS WHY REGISTRATION CAN ANSWER IDENTICALLY IN EVERY CASE. The API refuses
 * to disclose whether an address is registered (an enumeration oracle), so the person
 * who genuinely owns the address is told here instead — where only they can read it.
 *
 * It deliberately does NOT include a sign-in token or a reset link with a credential in
 * it. Anyone can trigger this email for any address, so it must never carry anything
 * that grants access — only instructions and plain URLs.
 *
 * @param {object} input
 * @param {string} input.to
 * @param {string} input.name
 * @returns {Promise<boolean>}
 * @throws {Error} If the transport throws.
 */
export function sendAlreadyRegisteredEmail({ to, name }) {
  return sendMail({
    to,
    subject: "Someone tried to create a RentEasy account with your email",
    text: [
      `Hi ${name},`,
      ``,
      `Someone just tried to sign up for RentEasy using this email address, but you`,
      `already have an account.`,
      ``,
      `If that was you: sign in instead at ${env.appUrl}/login`,
      `Forgotten your password? Reset it at ${env.appUrl}/forgot-password`,
      ``,
      `If it was not you, no action is needed. Nothing has changed and no new account`,
      `was created.`,
    ].join("\n"),
  });
}

/**
 * Builds the link a reset recipient clicks.
 *
 * Points at a FRONTEND route which renders a form. The token is not POSTed on page
 * load — and that difference from verification is load-bearing, not incidental: mail
 * clients and security scanners PREFETCH links, and a reset page that consumed its
 * token on mount would be burned before the recipient ever typed a password.
 *
 * @param {string} rawToken
 * @returns {string}
 */
function resetLink(rawToken) {
  return `${env.appUrl}/reset-password/${rawToken}`;
}

/**
 * "Reset your password" — the only email in this flow, sent only to an address that
 * genuinely has an active account.
 *
 * WHAT THIS EMAIL MUST NEVER CONTAIN, because anyone can trigger it for any address
 * they can type:
 *   - a session, or anything that signs the recipient in
 *   - the account's phone number, or any other stored detail the recipient might not
 *     already know
 *   - a second credential of any kind (FR-026)
 *
 * The body says "Someone asked to reset" rather than "you asked", because the person
 * reading it may not be the person who asked.
 *
 * The subject IS plainly specific, and that is a deliberate trade rather than an
 * oversight. It does tell a shoulder-surfer reading a lock screen that this address has
 * a RentEasy account — but a deliberately vague subject on a security email reads as
 * phishing, which costs more than the leak is worth. Note the leak is bounded either
 * way: this email only ever reaches an address that really does have an account, so its
 * mere arrival carries the same fact.
 *
 * @param {object} input
 * @param {string} input.to
 * @param {string} input.name Used in the greeting only. The recipient already knows
 *        their own name, so this discloses nothing they do not have.
 * @param {string} input.rawToken
 * @param {number} input.ttlHours
 * @returns {Promise<boolean>}
 * @throws {Error} If the transport throws. Deliberately not caught here.
 */
export function sendPasswordResetEmail({ to, name, rawToken, ttlHours }) {
  return sendMail({
    to,
    subject: "Reset your RentEasy password",
    text: [
      `Hi ${name},`,
      ``,
      `Someone asked to reset the password for this RentEasy account. If it was you,`,
      `set a new password here:`,
      ``,
      resetLink(rawToken),
      ``,
      `The link works once and expires in ${ttlHours === 1 ? "1 hour" : `${ttlHours} hours`}.`,
      ``,
      `You will need to sign in afterwards — this link sets a password, it does not`,
      `sign anyone in.`,
      ``,
      `If it was not you, ignore this email. Your password has not changed, and`,
      `nobody can reset it without this link.`,
    ].join("\n"),
  });
}

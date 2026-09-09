/**
 * Test fixtures.
 *
 * Registration goes through the real HTTP endpoint rather than a direct insert,
 * because the whole feature is about what that endpoint does and does not disclose —
 * a fixture that bypassed it would test a different system.
 */

import request from "supertest";
import { lastMailTo } from "../../src/config/mailer.js";
import { env } from "../../src/config/env.js";

export const TEST_PASSWORD = "a-good-password";

let counter = 0;

/** A unique address per call. A counter cannot collide within a run; random can. */
export const nextEmail = () => `renter${++counter}@example.test`;

/**
 * Registers an account through the API.
 *
 * @param {import("express").Express} app
 * @param {object} [overrides]
 * @returns {Promise<{ email: string, password: string, name: string, response: object }>}
 */
export async function registerUser(app, overrides = {}) {
  const body = {
    name: "Test Renter",
    email: nextEmail(),
    password: TEST_PASSWORD,
    acceptedTermsVersion: env.termsVersion,
    ...overrides,
  };

  const response = await request(app).post("/api/auth/register").send(body);
  return { ...body, response };
}

/**
 * Extracts the raw verification token from the email that was "sent".
 *
 * THE ONLY WAY TO GET ONE. The database stores a SHA-256 hash, so the raw token exists
 * in exactly one place after registration: the message body. Reading it here is the
 * same mechanism as nodemailer's test transport, not a hole cut for the suite — and it
 * doubles as proof that the email actually carries a usable link.
 *
 * @param {string} email
 * @returns {string}
 * @throws {Error} If no message was sent, or it carries no link — a loud failure in
 *         setup beats a misleading assertion later.
 */
export function verificationTokenFor(email) {
  const mail = lastMailTo(email);
  if (!mail) throw new Error(`No email was sent to ${email}`);

  const match = mail.text.match(/\/verify\/([A-Za-z0-9_-]+)/);
  if (!match) throw new Error(`No verification link in the email to ${email}`);

  return match[1];
}

/**
 * Registers, verifies and signs in — the common starting point for anything that needs
 * a usable account.
 *
 * @param {import("express").Express} app
 * @param {object} [overrides]
 * @returns {Promise<{ agent: import("supertest").SuperAgentTest, email: string, user: object }>}
 */
export async function verifiedUser(app, overrides = {}) {
  const { email, password } = await registerUser(app, overrides);

  await request(app).post("/api/auth/verify").send({ token: verificationTokenFor(email) });

  // `request.agent`, not `request` — an agent keeps a cookie jar across calls, so the
  // session cookie is sent automatically. With a bare `request(app)` every
  // authenticated call would 401 despite a sign-in that clearly succeeded.
  const agent = request.agent(app);
  const signIn = await agent.post("/api/auth/login").send({ email, password });
  if (signIn.status !== 200) {
    throw new Error(`Fixture sign-in failed (${signIn.status}): ${signIn.body?.message}`);
  }

  return { agent, email, user: signIn.body.data.user };
}

/**
 * Registers and signs in WITHOUT verifying.
 *
 * @param {import("express").Express} app
 * @param {object} [overrides]
 * @returns {Promise<{ agent: import("supertest").SuperAgentTest, email: string }>}
 */
export async function unverifiedUser(app, overrides = {}) {
  const { email, password } = await registerUser(app, overrides);
  const agent = request.agent(app);
  await agent.post("/api/auth/login").send({ email, password });
  return { agent, email };
}

/**
 * Extracts the raw password reset token from the email that was "sent".
 *
 * Same mechanism as `verificationTokenFor`, and the same reason it is the only way:
 * the database stores a SHA-256 hash. Kept as a separate function rather than a
 * parameterised one, so a test asking for a reset token can never silently be handed a
 * verification token — the two grant very different things.
 *
 * @param {string} email
 * @returns {string}
 * @throws {Error} If no message was sent, or it carries no reset link.
 */
export function resetTokenFor(email) {
  const mail = lastMailTo(email);
  if (!mail) throw new Error(`No email was sent to ${email}`);

  const match = mail.text.match(/\/reset-password\/([A-Za-z0-9_-]+)/);
  if (!match) throw new Error(`No reset link in the email to ${email}`);

  return match[1];
}

/**
 * Registers an account and requests a password reset for it.
 *
 * @param {import("express").Express} app
 * @param {object} [overrides]
 * @returns {Promise<{ email: string, password: string, token: string }>}
 */
export async function userWithResetToken(app, overrides = {}) {
  const { email, password } = await registerUser(app, overrides);
  await request(app).post("/api/auth/forgot-password").send({ email });
  return { email, password, token: resetTokenFor(email) };
}

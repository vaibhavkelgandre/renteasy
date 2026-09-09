/**
 * Email verification, resend, and the gate that makes them matter.
 */

import { describe, it, expect } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { query } from "../src/config/db.js";
import { getOutbox } from "../src/config/mailer.js";
import {
  registerUser,
  verificationTokenFor,
  verifiedUser,
  unverifiedUser,
  TEST_PASSWORD,
  nextEmail,
} from "./helpers/factories.js";

describe("POST /api/auth/verify", () => {
  it("confirms an address with a valid token", async () => {
    const { email } = await registerUser(app);

    const response = await request(app)
      .post("/api/auth/verify")
      .send({ token: verificationTokenFor(email) });

    expect(response.status).toBe(200);
    expect(response.body.data.alreadyVerified).toBe(false);

    const { rows } = await query(`SELECT email_verified_at FROM users WHERE lower(email) = $1`, [
      email.toLowerCase(),
    ]);
    expect(rows[0].email_verified_at).not.toBeNull();
  });

  it("answers 200 with alreadyVerified on a second click", async () => {
    const { email } = await registerUser(app);
    const token = verificationTokenFor(email);

    await request(app).post("/api/auth/verify").send({ token });
    const second = await request(app).post("/api/auth/verify").send({ token });

    // NOT an error. Mail clients prefetch links, and a user who clicks twice has done
    // nothing wrong — telling them something failed would be actively misleading.
    expect(second.status).toBe(200);
    expect(second.body.data.alreadyVerified).toBe(true);
  });

  it("answers a byte-identical 410 for expired, used, unknown and malformed tokens", async () => {
    // 1. Used
    const { email: usedEmail } = await registerUser(app);
    const usedToken = verificationTokenFor(usedEmail);
    await request(app).post("/api/auth/verify").send({ token: usedToken });
    // Consumed, and the account is verified — so this path returns "already verified",
    // not 410. Age it out instead to get a genuinely dead token.
    await query(`UPDATE email_verification_tokens SET used_at = now(), email = 'gone@example.test'`);

    // 2. Expired
    const { email: expiredEmail } = await registerUser(app);
    const expiredToken = verificationTokenFor(expiredEmail);
    await query(`UPDATE email_verification_tokens SET expires_at = now() - interval '1 hour'
                  WHERE user_id = (SELECT id FROM users WHERE lower(email) = $1)`, [
      expiredEmail.toLowerCase(),
    ]);

    const [expired, unknown, malformed] = await Promise.all([
      request(app).post("/api/auth/verify").send({ token: expiredToken }),
      request(app).post("/api/auth/verify").send({ token: "not-a-real-token-at-all" }),
      request(app).post("/api/auth/verify").send({ token: "!!!" }),
    ]);

    // FOUR causes, ONE answer. Any difference tells someone guessing tokens which
    // guesses were closer.
    for (const response of [expired, unknown, malformed]) {
      expect(response.status).toBe(410);
      expect(response.body).toEqual(expired.body);
    }
  });

  it("refuses a token issued for an address the user has since changed", async () => {
    const { email } = await registerUser(app);
    const token = verificationTokenFor(email);

    // The user changes their email before clicking the link.
    await query(`UPDATE users SET email = $2 WHERE lower(email) = $1`, [
      email.toLowerCase(),
      "moved@example.test",
    ]);

    const response = await request(app).post("/api/auth/verify").send({ token });

    // The token proves control of the ORIGINAL address. It proves nothing whatsoever
    // about the new one, so it must not verify it.
    expect(response.status).toBe(410);

    const { rows } = await query(
      `SELECT email_verified_at FROM users WHERE email = 'moved@example.test'`
    );
    expect(rows[0].email_verified_at).toBeNull();
  });

  it("cannot be replayed after the token is consumed", async () => {
    const { email } = await registerUser(app);
    const token = verificationTokenFor(email);

    await request(app).post("/api/auth/verify").send({ token });

    const { rows } = await query(`SELECT used_at FROM email_verification_tokens`);
    expect(rows[0].used_at).not.toBeNull();
  });
});

describe("POST /api/auth/verify/resend", () => {
  it("requires a session", async () => {
    const response = await request(app).post("/api/auth/verify/resend");
    expect(response.status).toBe(401);
  });

  it("issues a fresh token and kills the old one", async () => {
    const { agent, email } = await unverifiedUser(app);
    const first = verificationTokenFor(email);

    // Age the existing token past the resend cooldown. Registration issued one seconds
    // ago, so without this the resend is correctly refused as too soon and the "new"
    // token is the old one - which is what this test originally caught.
    await query(`UPDATE email_verification_tokens SET created_at = now() - interval '5 minutes'`);

    const response = await agent.post("/api/auth/verify/resend");
    expect(response.status).toBe(202);

    const second = verificationTokenFor(email);
    expect(second).not.toBe(first);

    expect((await request(app).post("/api/auth/verify").send({ token: first })).status).toBe(410);
    expect((await request(app).post("/api/auth/verify").send({ token: second })).status).toBe(200);
  });

  it("answers 202 inside the cooldown, and sends nothing", async () => {
    const { agent } = await unverifiedUser(app);
    await agent.post("/api/auth/verify/resend");
    const countAfterFirst = getOutbox().length;

    const response = await agent.post("/api/auth/verify/resend");

    // Silent, not "too soon". Every path answers the same so the client needs no
    // special case — and there is nothing for a caller to time.
    expect(response.status).toBe(202);
    expect(getOutbox().length).toBe(countAfterFirst);
  });

  it("answers 202 and sends nothing for an already-verified user", async () => {
    const { agent } = await verifiedUser(app);
    const before = getOutbox().length;

    const response = await agent.post("/api/auth/verify/resend");

    expect(response.status).toBe(202);
    expect(getOutbox().length).toBe(before);
  });
});

describe("the verification gate", () => {
  it("lets an UNVERIFIED user sign in", async () => {
    const { email, password } = await registerUser(app);

    const response = await request(app).post("/api/auth/login").send({ email, password });

    // Blocking sign-in until verification would strand anyone whose email was slow,
    // filtered or mistyped — with nowhere to go and nothing to click. The gate is on
    // the actions, not the door.
    expect(response.status).toBe(200);
    expect(response.body.data.user.email_verified_at).toBeNull();
  });

  it("exposes verification state on /auth/me so the client can prompt", async () => {
    const { agent } = await unverifiedUser(app);
    const response = await agent.get("/api/auth/me");

    expect(response.status).toBe(200);
    expect(response.body.data.user.email_verified_at).toBeNull();
  });

  it("reflects verification immediately, without signing out and back in", async () => {
    const { agent, email } = await unverifiedUser(app);
    expect((await agent.get("/api/auth/me")).body.data.user.email_verified_at).toBeNull();

    await request(app).post("/api/auth/verify").send({ token: verificationTokenFor(email) });

    // THE REASON the JWT carries no verification state. Baked into the token, this
    // would keep saying "unverified" for the token's full 12-hour life — so someone
    // who just confirmed their email could not list anything, with no explanation,
    // until they signed out and back in.
    expect((await agent.get("/api/auth/me")).body.data.user.email_verified_at).not.toBeNull();
  });
});

describe("POST /api/auth/login", () => {
  it("gives the same answer for a wrong password, an unknown email and a suspended account", async () => {
    const { email } = await verifiedUser(app);

    const wrongPassword = await request(app)
      .post("/api/auth/login")
      .send({ email, password: "definitely-not-it" });

    const unknownEmail = await request(app)
      .post("/api/auth/login")
      .send({ email: nextEmail(), password: TEST_PASSWORD });

    expect(wrongPassword.status).toBe(401);
    // Any difference is an enumeration oracle from the sign-in side, which would undo
    // everything registration goes to such lengths to protect.
    expect(wrongPassword.body).toEqual(unknownEmail.body);
  });

  it("refuses a suspended account with that same message", async () => {
    const { email } = await verifiedUser(app);
    await query(`UPDATE users SET status = 'SUSPENDED' WHERE lower(email) = $1`, [
      email.toLowerCase(),
    ]);

    const response = await request(app)
      .post("/api/auth/login")
      .send({ email, password: TEST_PASSWORD });

    expect(response.status).toBe(401);
    expect(response.body.message).toMatch(/invalid email or password/i);
  });

  it("never returns the password hash or the token in the body", async () => {
    const { email } = await verifiedUser(app);
    const response = await request(app)
      .post("/api/auth/login")
      .send({ email, password: TEST_PASSWORD });

    const body = JSON.stringify(response.body);
    expect(body).not.toContain("password_hash");
    expect(body).not.toContain("$2b$");
    // A token in the body defeats httpOnly entirely — JavaScript could read it from
    // the response and store it somewhere an XSS payload can reach.
    expect(body).not.toContain("eyJ");
  });
});

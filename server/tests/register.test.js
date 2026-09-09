/**
 * Public registration.
 *
 * The first block is the point of the whole feature: registration must not reveal
 * whether an email is already in use. Everything else is ordinary behaviour.
 */

import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { query } from "../src/config/db.js";
import { env } from "../src/config/env.js";
import { getOutbox, lastMailTo } from "../src/config/mailer.js";
import { hashToken } from "../src/utils/secureToken.js";
import { AUTH_COOKIE } from "../src/utils/cookies.js";
import {
  registerUser,
  verificationTokenFor,
  verifiedUser,
  TEST_PASSWORD,
  nextEmail,
} from "./helpers/factories.js";

const validBody = (overrides = {}) => ({
  name: "Asha Patil",
  email: nextEmail(),
  password: TEST_PASSWORD,
  acceptedTermsVersion: env.termsVersion,
  ...overrides,
});

describe("POST /api/auth/register — the enumeration guarantee", () => {
  it("answers identically for a new email, an unverified one, and a verified one", async () => {
    const newEmail = nextEmail();
    const unverifiedEmail = nextEmail();
    const { email: verifiedEmail } = await verifiedUser(app);

    // Registered but never confirmed.
    await request(app).post("/api/auth/register").send(validBody({ email: unverifiedEmail }));

    const responses = await Promise.all(
      [newEmail, unverifiedEmail, verifiedEmail].map((email) =>
        request(app).post("/api/auth/register").send(validBody({ email }))
      )
    );

    // THE CENTRAL ASSERTION OF THIS FEATURE. Any difference — status, message, shape —
    // tells a caller whether an address is registered, which on a marketplace
    // discloses who owns things and who is worth targeting. And it is trivially
    // automatable against a list of addresses.
    for (const response of responses) {
      expect(response.status).toBe(202);
      expect(response.body).toEqual(responses[0].body);
    }
  });

  it("answers 202, not 201 — 'Created' would assert the very fact we withhold", async () => {
    const response = await request(app).post("/api/auth/register").send(validBody());
    expect(response.status).toBe(202);
  });

  it("sends a DIFFERENT email to an already-verified address", async () => {
    const { email } = await verifiedUser(app);

    await request(app).post("/api/auth/register").send(validBody({ email }));

    // The disclosure happens in the inbox, where only the owner can read it — never in
    // the response, where anyone can.
    const mail = lastMailTo(email);
    expect(mail.subject).toMatch(/someone tried/i);
    expect(mail.text).toMatch(/already have an account/i);
  });

  it("never puts a credential in the already-registered email", async () => {
    const { email } = await verifiedUser(app);
    await request(app).post("/api/auth/register").send(validBody({ email }));

    // Anyone can trigger this email for any address, so it must carry nothing that
    // grants access — only instructions and plain URLs.
    const mail = lastMailTo(email);
    expect(mail.text).not.toMatch(/\/verify\//);
    expect(mail.text).not.toMatch(/token/i);
  });

  it("reissues verification for an existing UNVERIFIED email, without creating a second account", async () => {
    const { email } = await registerUser(app);
    const first = verificationTokenFor(email);

    await request(app).post("/api/auth/register").send(validBody({ email }));
    const second = verificationTokenFor(email);

    expect(second).not.toBe(first);

    const { rows } = await query(`SELECT COUNT(*)::int AS n FROM users WHERE lower(email) = $1`, [
      email.toLowerCase(),
    ]);
    expect(rows[0].n).toBe(1);

    // The old link must stop working — that is what a user expects from a resend, and
    // what the partial unique index on live tokens guarantees.
    const old = await request(app).post("/api/auth/verify").send({ token: first });
    expect(old.status).toBe(410);
  });

  it("sends NOTHING to a suspended account, and still answers 202", async () => {
    const { email } = await verifiedUser(app);
    await query(`UPDATE users SET status = 'SUSPENDED' WHERE lower(email) = $1`, [
      email.toLowerCase(),
    ]);
    const before = getOutbox().length;

    const response = await request(app).post("/api/auth/register").send(validBody({ email }));

    // A suspended user must not be able to self-restore, and must not learn they are
    // suspended from a stranger probing the address.
    expect(response.status).toBe(202);
    expect(getOutbox().length).toBe(before);
  });

  it("creates exactly one account when two identical registrations race", async () => {
    const email = nextEmail();

    const [a, b] = await Promise.all([
      request(app).post("/api/auth/register").send(validBody({ email })),
      request(app).post("/api/auth/register").send(validBody({ email })),
    ]);

    // The unique index arbitrates. A check-then-insert would let both pass — and the
    // loser must still answer 202, because an error there would be the enumeration
    // oracle arriving by another route.
    expect(a.status).toBe(202);
    expect(b.status).toBe(202);

    const { rows } = await query(`SELECT COUNT(*)::int AS n FROM users WHERE lower(email) = $1`, [
      email.toLowerCase(),
    ]);
    expect(rows[0].n).toBe(1);
  });
});

describe("POST /api/auth/register — what it must never do", () => {
  it("sets no session cookie", async () => {
    const response = await request(app).post("/api/auth/register").send(validBody());

    // At this moment we do not know the address belongs to whoever typed it. Signing
    // them in would hand a working session to anyone who can spell someone else's email.
    const cookies = response.headers["set-cookie"] ?? [];
    expect(cookies.some((c) => c.startsWith(`${AUTH_COOKIE}=`))).toBe(false);
  });

  it("stores only a HASH of the verification token", async () => {
    const { email } = await registerUser(app);
    const raw = verificationTokenFor(email);

    const { rows } = await query(`SELECT token_hash FROM email_verification_tokens`);
    expect(rows).toHaveLength(1);

    // A database leak must not hand over the ability to verify — and therefore
    // activate — every pending account.
    expect(rows[0].token_hash).not.toBe(raw);
    expect(rows[0].token_hash).toBe(hashToken(raw));
  });

  it("ignores is_admin and status in the request body", async () => {
    const email = nextEmail();
    await request(app)
      .post("/api/auth/register")
      .send({ ...validBody({ email }), isAdmin: true, is_admin: true, status: "SUSPENDED" });

    // Zod strips unknown keys, so these never reach a service at all. The difference
    // between "we don't read that field" and "that field cannot be set from outside".
    const { rows } = await query(
      `SELECT is_admin, status FROM users WHERE lower(email) = $1`,
      [email.toLowerCase()]
    );
    expect(rows[0].is_admin).toBe(false);
    expect(rows[0].status).toBe("ACTIVE");
  });

  it("starts every account unverified", async () => {
    const { email } = await registerUser(app);
    const { rows } = await query(`SELECT email_verified_at FROM users WHERE lower(email) = $1`, [
      email.toLowerCase(),
    ]);
    expect(rows[0].email_verified_at).toBeNull();
  });
});

describe("POST /api/auth/register — validation", () => {
  it("requires name, email, password and terms acceptance", async () => {
    const response = await request(app).post("/api/auth/register").send({});
    expect(response.status).toBe(400);
    expect(response.body.errors).toMatchObject({
      name: expect.any(String),
      email: expect.any(String),
      password: expect.any(String),
      acceptedTermsVersion: expect.any(String),
    });
  });

  it("rejects a stale terms version with 409", async () => {
    const response = await request(app)
      .post("/api/auth/register")
      .send(validBody({ acceptedTermsVersion: "1999-01-01" }));

    // Safe to be specific here: it says nothing about whether the email is registered,
    // and the client genuinely needs to reload to show the current terms.
    expect(response.status).toBe(409);
    expect(response.body.message).toMatch(/terms/i);
  });

  it("rejects a short password", async () => {
    const response = await request(app).post("/api/auth/register").send(validBody({ password: "short" }));
    expect(response.status).toBe(400);
    expect(response.body.errors.password).toMatch(/at least/i);
  });

  it("treats email case-insensitively", async () => {
    const upper = "Asha.Patil@Example.Test";
    await request(app).post("/api/auth/register").send(validBody({ email: upper }));

    const { rows } = await query(`SELECT email FROM users WHERE lower(email) = $1`, [
      upper.toLowerCase(),
    ]);
    // Lowercased at the validator boundary, so the unique index, the token's stored
    // address and the mail recipient all agree on one form.
    expect(rows[0].email).toBe(upper.toLowerCase());
  });

  it("trims a whitespace-only name to nothing and rejects it", async () => {
    const response = await request(app).post("/api/auth/register").send(validBody({ name: "   " }));
    expect(response.status).toBe(400);
  });
});

describe("POST /api/auth/register — resilience", () => {
  it("still answers 202 when the mail transport throws", async () => {
    const mailer = await import("../src/config/mailer.js");
    const original = mailer.sendMail;
    const email = nextEmail();

    // Replace the transport with one that always fails.
    const spy = vi.spyOn(mailer, "sendMail").mockRejectedValue(new Error("SMTP down"));

    try {
      const response = await request(app).post("/api/auth/register").send(validBody({ email }));

      // THE MOST VALUABLE TEST HERE — it pins a design decision, not a behaviour. The
      // user row and the token are committed BEFORE anything is sent, and the send is
      // fired after the response and never awaited. A mail outage must not make a
      // signup look like the user's fault.
      expect(response.status).toBe(202);

      const { rows } = await query(
        `SELECT u.id, t.id AS token_id
           FROM users u LEFT JOIN email_verification_tokens t ON t.user_id = u.id
          WHERE lower(u.email) = $1`,
        [email.toLowerCase()]
      );
      expect(rows[0].id).toBeTruthy();
      expect(rows[0].token_id).toBeTruthy();
    } finally {
      spy.mockRestore();
      expect(mailer.sendMail).toBe(original);
    }
  });
});

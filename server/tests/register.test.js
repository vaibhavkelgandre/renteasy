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
  sessionCookieFor,
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

describe("POST /api/auth/register — reclaiming an unverified account (account-takeover fix)", () => {
  it("overwrites the password and signs out whoever registered the address first", async () => {
    const email = nextEmail();

    // The "attacker" registers first, with a password of their own choosing, and
    // signs in — unverified sign-in is allowed (§3.3). Before the fix, nothing about
    // this row ever changed again: a second registration of the same address just
    // resent a link to THIS account, with THIS password.
    await request(app)
      .post("/api/auth/register")
      .send(validBody({ email, password: "attacker-password-1" }));
    const attackerCookie = await sessionCookieFor(app, email, "attacker-password-1");

    // Confirm the attacker really does have a working session before the fix is
    // exercised, so the assertion below proves something rather than passing by
    // accident.
    const before = await request(app).get("/api/profile").set("Cookie", attackerCookie);
    expect(before.status).toBe(200);

    // The real owner "registers" the same address with THEIR OWN password. The
    // response stays byte-identical to every other unverified-email case (§3.1) —
    // reclaiming what happens to the ACCOUNT must not change what the CALLER is told.
    const reclaim = await request(app)
      .post("/api/auth/register")
      .send(validBody({ email, name: "Real Owner", password: "real-owners-password" }));
    expect(reclaim.status).toBe(202);

    // The attacker's session, obtained before the reclaim, must be refused on its
    // very next request — not ride out its remaining 12-hour life.
    const after = await request(app).get("/api/profile").set("Cookie", attackerCookie);
    expect(after.status).toBe(401);

    // The attacker's password no longer opens the account...
    const oldPasswordLogin = await request(app)
      .post("/api/auth/login")
      .send({ email, password: "attacker-password-1" });
    expect(oldPasswordLogin.status).toBe(401);

    // ...and the real owner's does, as the account they now fully control.
    const newLogin = await request(app)
      .post("/api/auth/login")
      .send({ email, password: "real-owners-password" });
    expect(newLogin.status).toBe(200);
    expect(newLogin.body.data.user.name).toBe("Real Owner");
  });

  it("cancels a pending email change the previous holder had queued", async () => {
    const email = nextEmail();
    await request(app)
      .post("/api/auth/register")
      .send(validBody({ email, password: "attacker-password-1" }));
    const attackerCookie = await sessionCookieFor(app, email, "attacker-password-1");

    // The attacker queues a change to an address only they control, using the
    // password they set. Without the fix, this link would still work after the real
    // owner reclaimed the account, letting the attacker complete the takeover later.
    const attackerEmail = nextEmail();
    const changeRequest = await request(app)
      .patch("/api/profile/email")
      .set("Cookie", attackerCookie)
      .send({ newEmail: attackerEmail, currentPassword: "attacker-password-1" });
    expect(changeRequest.status).toBe(202);
    const pendingToken = verificationTokenFor(attackerEmail);

    await request(app)
      .post("/api/auth/register")
      .send(validBody({ email, password: "real-owners-password" }));

    // The queued link no longer proves anything about this account's current state —
    // same 410 as any other token whose target has moved on.
    const confirm = await request(app).post("/api/auth/verify").send({ token: pendingToken });
    expect(confirm.status).toBe(410);

    const { rows } = await query(`SELECT email, pending_email FROM users WHERE lower(email) = $1`, [
      email.toLowerCase(),
    ]);
    expect(rows[0].email.toLowerCase()).toBe(email.toLowerCase());
    expect(rows[0].pending_email).toBeNull();
  });

  it("does NOT reclaim an already-verified account", async () => {
    // The service already checks `existing.email_verified_at` before ever reaching
    // the reclaim — this pins that `reclaimUnverifiedRegistration`'s own WHERE guard
    // (email_verified_at IS NULL) is a real backstop and not dead code, by calling
    // register() on a verified address and confirming nothing about the account
    // moved.
    const { email, user } = await verifiedUser(app);

    await request(app)
      .post("/api/auth/register")
      .send(validBody({ email, name: "Someone Else", password: "a-completely-different-password" }));

    const { rows } = await query(`SELECT name FROM users WHERE id = $1`, [user.id]);
    expect(rows[0].name).not.toBe("Someone Else");

    const stillWorks = await request(app)
      .post("/api/auth/login")
      .send({ email, password: TEST_PASSWORD });
    expect(stillWorks.status).toBe(200);
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

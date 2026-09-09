/**
 * Password reset.
 *
 * The first block is the point of the whole feature: asking for a reset must not reveal
 * whether an address has an account. The second is that a token is a single-use,
 * short-lived, hash-stored credential that grants exactly one thing and no session.
 * Everything after that is ordinary behaviour.
 */

import { describe, it, expect } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { query } from "../src/config/db.js";
import { getOutbox, lastMailTo } from "../src/config/mailer.js";
import { hashToken } from "../src/utils/secureToken.js";
import { AUTH_COOKIE } from "../src/utils/cookies.js";
import { resetTokenPolicy } from "../src/repositories/passwordResetTokenRepository.js";
import {
  registerUser,
  userWithResetToken,
  resetTokenFor,
  nextEmail,
  TEST_PASSWORD,
} from "./helpers/factories.js";

const NEW_PASSWORD = "a-different-good-password";

/** Ages a user's live reset token, so the cooldown no longer applies. */
async function ageResetToken(email, minutes) {
  await query(
    `UPDATE password_reset_tokens
        SET created_at = created_at - ($2 || ' minutes')::interval
      WHERE user_id = (SELECT id FROM users WHERE lower(email) = lower($1))`,
    [email, String(minutes)]
  );
}

describe("POST /api/auth/forgot-password — the enumeration guarantee", () => {
  it("answers identically for a live account, an unknown address and a suspended one", async () => {
    const { email: live } = await registerUser(app);

    const { email: suspended } = await registerUser(app);
    await query(`UPDATE users SET status = 'SUSPENDED' WHERE lower(email) = lower($1)`, [
      suspended,
    ]);

    const unknown = nextEmail();

    const responses = await Promise.all(
      [live, unknown, suspended].map((email) =>
        request(app).post("/api/auth/forgot-password").send({ email })
      )
    );

    // toEqual on the whole body, not a status check. A difference in wording is just
    // as much of an oracle as a difference in status, and is far easier to introduce
    // by accident while "improving" a message.
    for (const response of responses) {
      expect(response.status).toBe(202);
      expect(response.body).toEqual(responses[0].body);
    }
  });

  it("sends mail ONLY to the live account", async () => {
    const { email: live } = await registerUser(app);
    const { email: suspended } = await registerUser(app);
    await query(`UPDATE users SET status = 'SUSPENDED' WHERE lower(email) = lower($1)`, [
      suspended,
    ]);
    const unknown = nextEmail();

    getOutbox().length = 0;

    for (const email of [live, unknown, suspended]) {
      await request(app).post("/api/auth/forgot-password").send({ email });
    }

    // The branch happens in the mail, never in the response. An unknown address is
    // deliberately NOT emailed "you have no account here" — that would turn this into
    // a way to send mail to any address a caller can type.
    expect(getOutbox()).toHaveLength(1);
    expect(lastMailTo(live)).toBeDefined();
    expect(lastMailTo(unknown)).toBeUndefined();
    expect(lastMailTo(suspended)).toBeUndefined();
  });

  it("answers 202 with the same body inside the resend cooldown, and sends nothing", async () => {
    const { email } = await registerUser(app);

    const first = await request(app).post("/api/auth/forgot-password").send({ email });
    getOutbox().length = 0;
    const second = await request(app).post("/api/auth/forgot-password").send({ email });

    expect(second.status).toBe(202);
    expect(second.body).toEqual(first.body);
    // Silent, byte-identical. Telling the caller "wait 15 minutes" would confirm the
    // address has an account.
    expect(getOutbox()).toHaveLength(0);
  });

  it("issues a fresh token once the cooldown has passed, killing the old one", async () => {
    const { email, token: first } = await userWithResetToken(app);

    await ageResetToken(email, resetTokenPolicy.resendCooldownMinutes + 1);
    await request(app).post("/api/auth/forgot-password").send({ email });
    const second = resetTokenFor(email);

    expect(second).not.toBe(first);

    // The old link must stop working the moment a new one is issued — that is what a
    // user expects from asking again, and it is what the partial unique index
    // guarantees by replacing the row rather than adding one.
    const replayOld = await request(app)
      .post("/api/auth/reset-password")
      .send({ token: first, password: NEW_PASSWORD });
    expect(replayOld.status).toBe(410);

    const useNew = await request(app)
      .post("/api/auth/reset-password")
      .send({ token: second, password: NEW_PASSWORD });
    expect(useNew.status).toBe(200);
  });

  it("never answers 409 for concurrent requests", async () => {
    const { email } = await registerUser(app);

    // A check-then-insert version collided on uq_prt_active_user, and the error
    // handler maps 23505 to 409 — so a REGISTERED address answered 409 where an
    // unknown one answered 202. That is the oracle rebuilt by accident, which is why
    // issuing is one ON CONFLICT statement.
    const responses = await Promise.all(
      Array.from({ length: 4 }, () =>
        request(app).post("/api/auth/forgot-password").send({ email })
      )
    );

    for (const response of responses) expect(response.status).toBe(202);
  });

  it("stores only the token hash, never the token", async () => {
    const { email, token } = await userWithResetToken(app);

    const { rows } = await query(
      `SELECT token_hash, email, expires_at FROM password_reset_tokens
        WHERE user_id = (SELECT id FROM users WHERE lower(email) = lower($1))`,
      [email]
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).toBe(hashToken(token));
    // The raw token must appear nowhere in the row. A leak of this table must not be a
    // leak of live account-takeover credentials.
    expect(JSON.stringify(rows[0])).not.toContain(token);
  });

  it("expires the token in about an hour, not a day", async () => {
    const { email } = await userWithResetToken(app);

    const { rows } = await query(
      `SELECT EXTRACT(EPOCH FROM (expires_at - created_at)) / 3600 AS hours
         FROM password_reset_tokens
        WHERE user_id = (SELECT id FROM users WHERE lower(email) = lower($1))`,
      [email]
    );

    // A reset link is a live takeover credential sitting in an inbox; a verification
    // link's worst case is a confirmed address. If these two TTLs ever converge,
    // somebody has copied the wrong constant.
    expect(Number(rows[0].hours)).toBeCloseTo(resetTokenPolicy.ttlHours, 1);
    expect(resetTokenPolicy.ttlHours).toBeLessThan(24);
  });

  it("refuses a malformed address with 400, before any lookup", async () => {
    const response = await request(app)
      .post("/api/auth/forgot-password")
      .send({ email: "not-an-email" });

    // Safe to be specific: it is refused on shape alone, so it says nothing about
    // which addresses exist.
    expect(response.status).toBe(400);
    expect(response.body.errors.email).toMatch(/valid email/i);
  });
});

describe("POST /api/auth/reset-password", () => {
  it("sets the new password and invalidates the old one", async () => {
    const { email, token } = await userWithResetToken(app);

    const response = await request(app)
      .post("/api/auth/reset-password")
      .send({ token, password: NEW_PASSWORD });

    expect(response.status).toBe(200);

    const withNew = await request(app)
      .post("/api/auth/login")
      .send({ email, password: NEW_PASSWORD });
    expect(withNew.status).toBe(200);

    const withOld = await request(app)
      .post("/api/auth/login")
      .send({ email, password: TEST_PASSWORD });
    expect(withOld.status).toBe(401);
  });

  it("DOES NOT sign anyone in", async () => {
    const { token } = await userWithResetToken(app);

    const response = await request(app)
      .post("/api/auth/reset-password")
      .send({ token, password: NEW_PASSWORD });

    // FR-025. Whoever holds the link has proved control of an inbox, which is a good
    // reason to let them set a password and a poor one to hand them a live session: a
    // password change is at least visible to the real owner next time they sign in,
    // whereas a session is immediate silent access.
    const cookies = response.headers["set-cookie"] ?? [];
    expect(cookies.some((cookie) => cookie.startsWith(`${AUTH_COOKIE}=`))).toBe(false);
    expect(response.body.data).toBeNull();
  });

  it("answers a byte-identical 410 for unknown, expired, used and malformed tokens", async () => {
    // Unknown: well-formed but never issued.
    const unknown = "Zm9vYmFyLXRoaXMtd2FzLW5ldmVyLWlzc3VlZC1hdC1hbGw";

    const { email: expiredEmail, token: expiredToken } = await userWithResetToken(app);
    await query(
      `UPDATE password_reset_tokens SET expires_at = now() - interval '1 minute'
        WHERE user_id = (SELECT id FROM users WHERE lower(email) = lower($1))`,
      [expiredEmail]
    );

    const { token: usedToken } = await userWithResetToken(app);
    await request(app)
      .post("/api/auth/reset-password")
      .send({ token: usedToken, password: NEW_PASSWORD });

    const responses = await Promise.all(
      [unknown, expiredToken, usedToken, "!!!not-base64url!!!"].map((token) =>
        request(app).post("/api/auth/reset-password").send({ token, password: NEW_PASSWORD })
      )
    );

    // FIVE causes, ONE answer. Anything that distinguishes them tells someone guessing
    // tokens which guesses were closer — and tells someone holding a spent link
    // whether the address still has an account.
    for (const response of responses) {
      expect(response.status).toBe(410);
      expect(response.body).toEqual(responses[0].body);
    }
  });

  it("cannot be replayed after a successful reset", async () => {
    const { email, token } = await userWithResetToken(app);

    await request(app).post("/api/auth/reset-password").send({ token, password: NEW_PASSWORD });

    const replay = await request(app)
      .post("/api/auth/reset-password")
      .send({ token, password: "yet-another-password" });
    expect(replay.status).toBe(410);

    // And the replay changed nothing.
    const signIn = await request(app)
      .post("/api/auth/login")
      .send({ email, password: NEW_PASSWORD });
    expect(signIn.status).toBe(200);
  });

  it("consumes the token exactly once under concurrency", async () => {
    const { token } = await userWithResetToken(app);

    // The claim is `UPDATE ... WHERE used_at IS NULL` inside a CTE, so exactly one
    // request may win. Without that, two simultaneous submissions would both set a
    // password and both report success — and the second would silently overwrite the
    // first, which is a very confusing way to lose an account.
    const responses = await Promise.all(
      Array.from({ length: 4 }, () =>
        request(app).post("/api/auth/reset-password").send({ token, password: NEW_PASSWORD })
      )
    );

    expect(responses.filter((r) => r.status === 200)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 410)).toHaveLength(3);
  });

  it("refuses once the account's email has changed, even with a live token", async () => {
    const { email, token } = await userWithResetToken(app);

    // The token proves control of the address it was MAILED TO. Once the account moves
    // to a different address, it proves nothing about the new one — so whoever still
    // reads the old inbox must not be able to set the password.
    await query(`UPDATE users SET email = $2 WHERE lower(email) = lower($1)`, [
      email,
      nextEmail(),
    ]);

    const response = await request(app)
      .post("/api/auth/reset-password")
      .send({ token, password: NEW_PASSWORD });
    expect(response.status).toBe(410);
  });

  it("refuses once the account has been suspended, even with a live token", async () => {
    const { email, token } = await userWithResetToken(app);

    // Request and use can be an hour apart, so the status check at request time is not
    // enough on its own — an account suspended in between must not be recoverable by
    // whoever holds the email.
    await query(`UPDATE users SET status = 'SUSPENDED' WHERE lower(email) = lower($1)`, [email]);

    const response = await request(app)
      .post("/api/auth/reset-password")
      .send({ token, password: NEW_PASSWORD });
    expect(response.status).toBe(410);
  });

  it("enforces the same minimum length as registration", async () => {
    const { token } = await userWithResetToken(app);

    const response = await request(app)
      .post("/api/auth/reset-password")
      .send({ token, password: "short" });

    // A reset that accepted a weaker password than signup would make this endpoint the
    // way around the policy.
    expect(response.status).toBe(400);
    expect(response.body.errors.password).toMatch(/at least/i);

    // And it must not have burned the token on a request that never got as far as
    // touching a password — otherwise one typo costs the user another email.
    const retry = await request(app)
      .post("/api/auth/reset-password")
      .send({ token, password: NEW_PASSWORD });
    expect(retry.status).toBe(200);
  });

  it("works for an unverified account", async () => {
    // Someone who never confirmed their email can still forget their password, and the
    // link goes to the address on the account either way. Refusing them would strand
    // an account with no recovery at all.
    const { email, token } = await userWithResetToken(app);

    const { rows } = await query(
      `SELECT email_verified_at FROM users WHERE lower(email) = lower($1)`,
      [email]
    );
    expect(rows[0].email_verified_at).toBeNull();

    const response = await request(app)
      .post("/api/auth/reset-password")
      .send({ token, password: NEW_PASSWORD });
    expect(response.status).toBe(200);
  });

  it("does not mark the email verified as a side effect", async () => {
    const { email, token } = await userWithResetToken(app);

    await request(app).post("/api/auth/reset-password").send({ token, password: NEW_PASSWORD });

    // Clicking the link DOES demonstrate control of the address, so verifying it here
    // would be defensible — and is deliberately not done. Keeping the two flows
    // separate means neither can turn into the other by accident. If this ever becomes
    // desirable it should be a decision with its own FR, not a surprise.
    const { rows } = await query(
      `SELECT email_verified_at FROM users WHERE lower(email) = lower($1)`,
      [email]
    );
    expect(rows[0].email_verified_at).toBeNull();
  });

  it("puts no credential and no link-bearing detail in the reset email beyond the link", async () => {
    const { email, password } = await registerUser(app);
    await request(app).post("/api/auth/forgot-password").send({ email });

    const mail = lastMailTo(email);

    // FR-026. Anyone can trigger this email for any address they can type, so it must
    // carry nothing that grants access on its own.
    expect(mail.text).not.toContain(password);
    expect(mail.text).toMatch(/\/reset-password\//);
    // Exactly one link, and it is the reset link. A stray sign-in-with-one-click or a
    // verification link would each be a second credential in the same message.
    const links = mail.text.match(/https?:\/\/\S+/g) ?? [];
    expect(links).toHaveLength(1);
  });
});

/**
 * Profile — view, edit, change email, change password, delete.
 *
 * The block that matters most is the email change. It carries the same non-disclosure
 * rule as registration, from the inside: a signed-in user must not be able to discover
 * which addresses have accounts by probing this endpoint. Everything else is ordinary
 * behaviour plus one rule worth pinning — a change touches nothing until the new
 * address is proved.
 */

import { describe, it, expect } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { query } from "../src/config/db.js";
import { getOutbox, lastMailTo } from "../src/config/mailer.js";
import {
  registerUser,
  verifiedUser,
  unverifiedUser,
  verificationTokenFor,
  nextEmail,
  TEST_PASSWORD,
} from "./helpers/factories.js";

const NEW_PASSWORD = "a-completely-different-password";

/** Reads a user row straight from the database. */
async function readUser(email) {
  const { rows } = await query(
    `SELECT id, name, email, phone, pending_email, status, deleted_at,
            email_verified_at IS NOT NULL AS verified
       FROM users WHERE lower(email) = lower($1)`,
    [email]
  );
  return rows[0] ?? null;
}

describe("GET /api/profile", () => {
  it("returns the caller's own record", async () => {
    const { agent, email } = await verifiedUser(app);

    const response = await agent.get("/api/profile");

    expect(response.status).toBe(200);
    expect(response.body.data.user).toMatchObject({ email, status: "ACTIVE" });
  });

  it("never returns the password hash", async () => {
    const { agent } = await verifiedUser(app);

    const response = await agent.get("/api/profile");

    // The projection omits it, so this cannot regress by someone spreading a row into
    // a response — but the assertion is cheap and the consequence of losing it is not.
    expect(JSON.stringify(response.body)).not.toContain("password_hash");
  });

  it("refuses without a session", async () => {
    const response = await request(app).get("/api/profile");
    expect(response.status).toBe(401);
  });
});

describe("PATCH /api/profile", () => {
  it("updates the name", async () => {
    const { agent, email } = await verifiedUser(app);

    const response = await agent.patch("/api/profile").send({ name: "Asha Patil" });

    expect(response.status).toBe(200);
    expect(response.body.data.user.name).toBe("Asha Patil");
    expect((await readUser(email)).name).toBe("Asha Patil");
  });

  it("clears a phone number with null, and leaves it alone when absent", async () => {
    const { agent, email } = await verifiedUser(app, { phone: "9876543210" });

    await agent.patch("/api/profile").send({ name: "Only The Name" });
    expect((await readUser(email)).phone).toBe("9876543210");

    // `undefined` means "leave alone" and `null` means "clear". Without that
    // distinction a phone number could never be removed once entered.
    await agent.patch("/api/profile").send({ phone: null });
    expect((await readUser(email)).phone).toBeNull();
  });

  it("CANNOT change the email, status or admin flag however the body is shaped", async () => {
    const { agent, email } = await verifiedUser(app);
    const intruder = nextEmail();

    const response = await agent.patch("/api/profile").send({
      name: "Still Fine",
      email: intruder,
      status: "SUSPENDED",
      is_admin: true,
      isAdmin: true,
      email_verified_at: null,
    });

    expect(response.status).toBe(200);

    // Zod strips unknown keys, so none of these ever reached a service. This is the
    // difference between "we don't read that field" and "that field cannot be set from
    // outside" — and email in particular has its own endpoint precisely because it
    // needs proof of the new address.
    const row = await readUser(email);
    expect(row.email).toBe(email);
    expect(row.status).toBe("ACTIVE");
    expect(row.verified).toBe(true);
    expect(await readUser(intruder)).toBeNull();
  });

  it("refuses an empty body rather than reporting a save that did nothing", async () => {
    const { agent } = await verifiedUser(app);
    const response = await agent.patch("/api/profile").send({});
    expect(response.status).toBe(400);
  });
});

describe("PATCH /api/profile/email — the non-disclosure rule", () => {
  it("answers identically for a free address, one that is taken, and the caller's own", async () => {
    const { email: takenByAnother } = await registerUser(app);
    const { agent, email: mine } = await verifiedUser(app);

    const responses = [];
    for (const newEmail of [nextEmail(), takenByAnother, mine]) {
      responses.push(
        await agent.patch("/api/profile/email").send({ newEmail, currentPassword: TEST_PASSWORD })
      );
    }

    // toEqual on the whole body. Refusing with "that email is taken" would hand any
    // signed-in user an enumeration oracle over the entire platform — register once,
    // then probe addresses one at a time. That defeats the property registration goes
    // to such lengths to protect, just from inside instead of outside.
    for (const response of responses) {
      expect(response.status).toBe(202);
      expect(response.body).toEqual(responses[0].body);
    }
  });

  it("only records a pending change, and only mails, for an address that is actually free", async () => {
    const { email: takenByAnother } = await registerUser(app);
    const { agent, email: mine } = await verifiedUser(app);

    getOutbox().length = 0;

    await agent
      .patch("/api/profile/email")
      .send({ newEmail: takenByAnother, currentPassword: TEST_PASSWORD });

    // No token, no email, and the address's real owner is NOT notified either — that
    // would turn this endpoint into a way to send mail to any address a caller types.
    expect(getOutbox()).toHaveLength(0);
    expect((await readUser(mine)).pending_email).toBeNull();

    const free = nextEmail();
    await agent.patch("/api/profile/email").send({ newEmail: free, currentPassword: TEST_PASSWORD });

    expect(lastMailTo(free)).toBeDefined();
    expect((await readUser(mine)).pending_email).toBe(free);
  });

  it("requires the current password", async () => {
    const { agent, email } = await verifiedUser(app);

    const response = await agent
      .patch("/api/profile/email")
      .send({ newEmail: nextEmail(), currentPassword: "not-the-password" });

    // A session cookie proves the browser was signed in at some point, not that the
    // person at the keyboard owns the account. Moving the address is the most
    // takeover-adjacent action available, so it costs a password.
    expect(response.status).toBe(401);
    expect(response.body.errors.currentPassword).toMatch(/not correct/i);
    expect((await readUser(email)).pending_email).toBeNull();
  });
});

describe("PATCH /api/profile/email — nothing moves until the new address is proved", () => {
  it("leaves the old address fully working while a change is pending", async () => {
    const { agent, email: original } = await verifiedUser(app);
    const wanted = nextEmail();

    await agent.patch("/api/profile/email").send({ newEmail: wanted, currentPassword: TEST_PASSWORD });

    // THE POINT OF FR-030. A typo must cost nothing: overwriting the address
    // immediately would lock the account out permanently, because the new address
    // never receives the link and the old one is already gone.
    const row = await readUser(original);
    expect(row.email).toBe(original);
    expect(row.pending_email).toBe(wanted);
    expect(row.verified).toBe(true);

    const signIn = await request(app)
      .post("/api/auth/login")
      .send({ email: original, password: TEST_PASSWORD });
    expect(signIn.status).toBe(200);
  });

  it("moves the address only when the emailed link is used", async () => {
    const { agent, email: original } = await verifiedUser(app);
    const wanted = nextEmail();

    await agent.patch("/api/profile/email").send({ newEmail: wanted, currentPassword: TEST_PASSWORD });
    const token = verificationTokenFor(wanted);

    const confirm = await request(app).post("/api/auth/verify").send({ token });
    expect(confirm.status).toBe(200);
    expect(confirm.body.data.emailChanged).toBe(true);

    const row = await readUser(wanted);
    expect(row.pending_email).toBeNull();
    expect(row.verified).toBe(true);

    // The old address stops working the moment the new one takes over.
    const oldSignIn = await request(app)
      .post("/api/auth/login")
      .send({ email: original, password: TEST_PASSWORD });
    expect(oldSignIn.status).toBe(401);

    const newSignIn = await request(app)
      .post("/api/auth/login")
      .send({ email: wanted, password: TEST_PASSWORD });
    expect(newSignIn.status).toBe(200);
  });

  it("kills the previous link when a change is requested again", async () => {
    const { agent } = await verifiedUser(app);

    const firstWanted = nextEmail();
    await agent
      .patch("/api/profile/email")
      .send({ newEmail: firstWanted, currentPassword: TEST_PASSWORD });
    const firstToken = verificationTokenFor(firstWanted);

    const secondWanted = nextEmail();
    await agent
      .patch("/api/profile/email")
      .send({ newEmail: secondWanted, currentPassword: TEST_PASSWORD });

    // FR-031, and it comes free rather than by a sweep: issueVerificationToken
    // replaces any live token via the uq_evt_active_user partial index, so the old
    // link dies in the same statement that mints the new one.
    const stale = await request(app).post("/api/auth/verify").send({ token: firstToken });
    expect(stale.status).toBe(410);

    const fresh = await request(app)
      .post("/api/auth/verify")
      .send({ token: verificationTokenFor(secondWanted) });
    expect(fresh.status).toBe(200);
  });

  it("refuses a link for a change that was cancelled", async () => {
    const { agent, email: original } = await verifiedUser(app);
    const wanted = nextEmail();

    await agent.patch("/api/profile/email").send({ newEmail: wanted, currentPassword: TEST_PASSWORD });
    const token = verificationTokenFor(wanted);

    const cancel = await agent.delete("/api/profile/email");
    expect(cancel.status).toBe(200);
    expect((await readUser(original)).pending_email).toBeNull();

    // The token proves control of an address the account no longer has anything to do
    // with, so it proves nothing about the current one.
    const response = await request(app).post("/api/auth/verify").send({ token });
    expect(response.status).toBe(410);
    expect((await readUser(original)).email).toBe(original);
  });

  it("answers 410, not 500, when someone else registers the address first", async () => {
    const { agent } = await verifiedUser(app);
    const contested = nextEmail();

    await agent
      .patch("/api/profile/email")
      .send({ newEmail: contested, currentPassword: TEST_PASSWORD });
    const token = verificationTokenFor(contested);

    // Somebody registers it while the link sits in an inbox. The unique index
    // arbitrates rather than a check-then-write, so a 23505 here is the ordinary
    // outcome of a race — it must not surface as a server fault, and it must not say
    // "that address is now taken" either.
    await registerUser(app, { email: contested });

    const response = await request(app).post("/api/auth/verify").send({ token });
    expect(response.status).toBe(410);
  });

  it("works for an UNVERIFIED account, which is who needs it most", async () => {
    // Someone whose address was mistyped at signup can never confirm it. Gating this
    // on a verified email would trap them permanently: unable to confirm the wrong
    // address, unable to change it.
    const { agent, email: wrong } = await unverifiedUser(app);
    const right = nextEmail();

    const response = await agent
      .patch("/api/profile/email")
      .send({ newEmail: right, currentPassword: TEST_PASSWORD });
    expect(response.status).toBe(202);

    await request(app).post("/api/auth/verify").send({ token: verificationTokenFor(right) });

    const row = await readUser(right);
    expect(row.verified).toBe(true);
    expect(await readUser(wrong)).toBeNull();
  });
});

describe("PATCH /api/profile/password", () => {
  it("changes the password when the current one is given", async () => {
    const { agent, email } = await verifiedUser(app);

    const response = await agent
      .patch("/api/profile/password")
      .send({ currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD });
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

  it("refuses a wrong current password and changes nothing", async () => {
    const { agent, email } = await verifiedUser(app);

    const response = await agent
      .patch("/api/profile/password")
      .send({ currentPassword: "not-the-password", newPassword: NEW_PASSWORD });
    expect(response.status).toBe(401);

    const stillWorks = await request(app)
      .post("/api/auth/login")
      .send({ email, password: TEST_PASSWORD });
    expect(stillWorks.status).toBe(200);
  });

  it("refuses reusing the current password", async () => {
    const { agent } = await verifiedUser(app);

    const response = await agent
      .patch("/api/profile/password")
      .send({ currentPassword: TEST_PASSWORD, newPassword: TEST_PASSWORD });
    expect(response.status).toBe(400);
  });

  it("enforces the same minimum length as registration and reset", async () => {
    const { agent } = await verifiedUser(app);

    // All three must agree. A weaker rule anywhere is the way around the policy.
    const response = await agent
      .patch("/api/profile/password")
      .send({ currentPassword: TEST_PASSWORD, newPassword: "short" });
    expect(response.status).toBe(400);
    expect(response.body.errors.newPassword).toMatch(/at least/i);
  });

  it("kills an outstanding reset link", async () => {
    const { agent, email } = await verifiedUser(app);

    await request(app).post("/api/auth/forgot-password").send({ email });
    const resetMail = lastMailTo(email);
    const resetToken = resetMail.text.match(/\/reset-password\/([A-Za-z0-9_-]+)/)[1];

    await agent
      .patch("/api/profile/password")
      .send({ currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD });

    // The most likely reason somebody changes their password is that they think
    // someone else has it. A reset link still sitting in an inbox would be a way
    // straight back in.
    const replay = await request(app)
      .post("/api/auth/reset-password")
      .send({ token: resetToken, password: "yet-another-password-here" });
    expect(replay.status).toBe(410);
  });

  it("keeps the caller signed in", async () => {
    const { agent } = await verifiedUser(app);

    await agent
      .patch("/api/profile/password")
      .send({ currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD });

    // This is the caller changing their OWN password on purpose. Signing them out of
    // the tab they are looking at would read as a failure.
    const stillIn = await agent.get("/api/profile");
    expect(stillIn.status).toBe(200);
  });
});

describe("POST /api/profile/deletion", () => {
  it("soft-deletes the account, signs the caller out, and blocks sign-in", async () => {
    const { agent, email } = await verifiedUser(app);

    const response = await agent
      .post("/api/profile/deletion")
      .send({ currentPassword: TEST_PASSWORD });
    expect(response.status).toBe(200);

    const row = await readUser(email);
    // SOFT: the row survives, because a marketplace's bookings and reviews reference a
    // person and the counterparty is entitled to their own history.
    expect(row).not.toBeNull();
    expect(row.status).toBe("DELETED");
    expect(row.deleted_at).not.toBeNull();

    const signIn = await request(app)
      .post("/api/auth/login")
      .send({ email, password: TEST_PASSWORD });
    expect(signIn.status).toBe(401);

    const stillAuthed = await agent.get("/api/profile");
    expect(stillAuthed.status).toBe(401);
  });

  it("requires the current password", async () => {
    const { agent, email } = await verifiedUser(app);

    const response = await agent
      .post("/api/profile/deletion")
      .send({ currentPassword: "not-the-password" });
    expect(response.status).toBe(401);
    expect((await readUser(email)).status).toBe("ACTIVE");
  });

  it("does NOT free the address for re-registration", async () => {
    const { agent, email } = await verifiedUser(app);
    await agent.post("/api/profile/deletion").send({ currentPassword: TEST_PASSWORD });

    getOutbox().length = 0;
    const again = await request(app).post("/api/auth/register").send({
      name: "Back Again",
      email,
      password: TEST_PASSWORD,
      acceptedTermsVersion: (await import("../src/config/env.js")).env.termsVersion,
    });

    // Pins a real, user-visible limitation rather than asserting it is desirable. The
    // row survives, so uq_users_email_lower still holds the address. Registration
    // answers its usual 202 and sends nothing, because a non-ACTIVE account is
    // deliberately silent — so the person gets no explanation at all. Releasing the
    // address needs a scrub step that is not built.
    expect(again.status).toBe(202);
    expect(getOutbox()).toHaveLength(0);
    expect((await readUser(email)).status).toBe("DELETED");
  });
});

describe("GET /api/users/:id/public", () => {
  it("returns a tiny public projection, with NO email and NO phone", async () => {
    const { user } = await verifiedUser(app, { name: "Asha Patil", phone: "9876543210" });

    const response = await request(app).get(`/api/users/${user.id}/public`);

    expect(response.status).toBe(200);
    expect(response.body.data.profile).toMatchObject({
      id: user.id,
      name: "Asha Patil",
      emailVerified: true,
    });

    // FR-033's hard rule. The projection omits them at the SQL level rather than
    // filtering afterwards, so a column added to `users` later cannot leak here by
    // default — but this asserts the outcome, which is what actually matters.
    const body = JSON.stringify(response.body);
    expect(body).not.toContain("@");
    expect(body).not.toContain("9876543210");
  });

  it("reports rating and listing count as unknown rather than zero", async () => {
    const { user } = await verifiedUser(app);

    const response = await request(app).get(`/api/users/${user.id}/public`);

    // Neither has a table yet (steps 3 and 9). A hardcoded 0 would read as "this
    // person has no listings" rather than "listings do not exist"; null says unknown,
    // which is true.
    expect(response.body.data.profile.rating).toBeNull();
    expect(response.body.data.profile.listingCount).toBeNull();
  });

  it("needs no session", async () => {
    const { user } = await verifiedUser(app);
    const response = await request(app).get(`/api/users/${user.id}/public`);
    expect(response.status).toBe(200);
  });

  it("answers an identical 404 for an unknown id, a malformed one, and a deleted account", async () => {
    const { agent, user } = await verifiedUser(app);
    await agent.post("/api/profile/deletion").send({ currentPassword: TEST_PASSWORD });

    const responses = await Promise.all(
      [
        "11111111-1111-4111-8111-111111111111", // well-formed, nobody
        "banana", // not a UUID at all
        user.id, // real, but deleted
      ].map((id) => request(app).get(`/api/users/${id}/public`))
    );

    // Three causes, one answer. A malformed id answering 400 would tell a caller that
    // ids are UUIDs; a deleted account answering 410 would disclose that somebody was
    // once there. Neither buys anything.
    for (const response of responses) {
      expect(response.status).toBe(404);
      expect(response.body).toEqual(responses[0].body);
    }
  });
});

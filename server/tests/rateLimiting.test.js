/**
 * The two user-keyed rate limiters on the profile routes — middlewares/rateLimiter.js.
 *
 * Off by default under test (see rateLimiter.js's `skip`), so every test here flips
 * RATE_LIMIT_ENABLED on for the duration and resets every limiter's counts in
 * afterEach. Without that reset, a leaked count from one test is a failure in a later,
 * unrelated one — the suite makes many calls from the same in-process app, and these
 * limiters are stateful across the whole run otherwise.
 */

import { describe, it, expect, afterEach } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { resetRateLimiters } from "../src/middlewares/rateLimiter.js";
import { verifiedUser, nextEmail, TEST_PASSWORD } from "./helpers/factories.js";

afterEach(() => {
  delete process.env.RATE_LIMIT_ENABLED;
  resetRateLimiters();
});

describe("PATCH /api/profile/email — emailChangeLimiter", () => {
  it("answers 429 after 5 requests from the same account within the window", async () => {
    process.env.RATE_LIMIT_ENABLED = "true";
    const { agent } = await verifiedUser(app);

    let last;
    for (let i = 0; i < 6; i += 1) {
      last = await agent
        .patch("/api/profile/email")
        .send({ newEmail: nextEmail(), currentPassword: TEST_PASSWORD });
    }

    expect(last.status).toBe(429);
    expect(last.body.success).toBe(false);
  });

  it("is scoped per account, not shared across users", async () => {
    process.env.RATE_LIMIT_ENABLED = "true";
    const { agent: agentA } = await verifiedUser(app);
    const { agent: agentB } = await verifiedUser(app);

    for (let i = 0; i < 5; i += 1) {
      await agentA
        .patch("/api/profile/email")
        .send({ newEmail: nextEmail(), currentPassword: TEST_PASSWORD });
    }

    // A now exhausted; B, a different account, must be unaffected.
    const stillWorksForB = await agentB
      .patch("/api/profile/email")
      .send({ newEmail: nextEmail(), currentPassword: TEST_PASSWORD });

    expect(stillWorksForB.status).not.toBe(429);
  });

  it("does nothing when the flag is left off — the ordinary test-suite state", async () => {
    const { agent } = await verifiedUser(app);

    let last;
    for (let i = 0; i < 6; i += 1) {
      last = await agent
        .patch("/api/profile/email")
        .send({ newEmail: nextEmail(), currentPassword: TEST_PASSWORD });
    }

    expect(last.status).not.toBe(429);
  });
});

describe("passwordRecheckLimiter — shared across /email, /password and /deletion", () => {
  it("answers 429 after repeated WRONG passwords on one route", async () => {
    process.env.RATE_LIMIT_ENABLED = "true";
    const { agent } = await verifiedUser(app);

    let last;
    for (let i = 0; i < 11; i += 1) {
      last = await agent
        .patch("/api/profile/password")
        .send({ currentPassword: "definitely-wrong", newPassword: "a-different-password" });
    }

    expect(last.status).toBe(429);
  });

  it("does NOT count a correct password towards the limit", async () => {
    process.env.RATE_LIMIT_ENABLED = "true";
    const { agent, email } = await verifiedUser(app);

    // Ten genuine, correct re-checks in a row (each changes the password back and
    // forth so the "new password must differ" rule never blocks a repeat) — none of
    // these are failures, so skipSuccessfulRequests must leave the budget untouched.
    let current = TEST_PASSWORD;
    for (let i = 0; i < 10; i += 1) {
      const next = i % 2 === 0 ? "another-good-password" : TEST_PASSWORD;
      const response = await agent
        .patch("/api/profile/password")
        .send({ currentPassword: current, newPassword: next });
      expect(response.status).toBe(200);
      current = next;
    }

    // The 11th call is a fresh, correct attempt — still allowed.
    const eleventh = await agent
      .patch("/api/profile/password")
      .send({ currentPassword: current, newPassword: "yet-another-password" });

    expect(eleventh.status).not.toBe(429);
    void email;
  });

  it("shares its budget across /email, /password and /deletion for the same account", async () => {
    process.env.RATE_LIMIT_ENABLED = "true";
    const { agent } = await verifiedUser(app);

    // 5 wrong attempts on /email, then 5 more on /password — the 10th of THIS mixed
    // sequence (the 11th overall) must already be blocked, proving the three routes
    // count against one shared budget rather than three independent ones.
    for (let i = 0; i < 5; i += 1) {
      await agent
        .patch("/api/profile/email")
        .send({ newEmail: nextEmail(), currentPassword: "definitely-wrong" });
    }
    let last;
    for (let i = 0; i < 6; i += 1) {
      last = await agent
        .patch("/api/profile/password")
        .send({ currentPassword: "definitely-wrong", newPassword: "a-different-password" });
    }

    expect(last.status).toBe(429);
  });
});

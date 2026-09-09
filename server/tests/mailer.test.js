/**
 * The mail transport's decisions — not its delivery.
 *
 * Nothing here talks to Brevo. What is worth pinning is the three things that decide
 * whether a send happens at all and who it claims to be from, because every one of
 * them has a failure mode that looks like something else: a test run that emails real
 * people, a half-filled environment that 4xxs on every send, and a quoted env var that
 * works locally and breaks in production.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { env } from "../src/config/env.js";
import {
  sendMail,
  getOutbox,
  clearOutbox,
  lastMailTo,
  parseMailFrom,
  isMailConfigured,
  describeMailMode,
} from "../src/config/mailer.js";

/** Sets mail config for one test and restores it afterwards. */
function withMailConfig({ apiKey = "", mailFrom = "" }) {
  const original = { apiKey: env.brevoApiKey, mailFrom: env.mailFrom };
  env.brevoApiKey = apiKey;
  env.mailFrom = mailFrom;
  return () => {
    env.brevoApiKey = original.apiKey;
    env.mailFrom = original.mailFrom;
  };
}

describe("the test guard", () => {
  afterEach(() => vi.restoreAllMocks());

  it("captures mail in the outbox and NEVER reaches the network, even fully configured", async () => {
    // The hazard this pins: env.js calls dotenv.config() on import, so a real
    // BREVO_API_KEY in `.env` lands in process.env during a test run whether or not
    // `.env.test` mentions it. If the test branch were not first and unconditional,
    // this suite would email whatever address a fixture invented — 300/day of a
    // quota shared with another project, sent to strangers.
    const restore = withMailConfig({ apiKey: "xkeysib-real-looking-key", mailFrom: "RentEasy <a@b.test>" });
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    try {
      const sent = await sendMail({ to: "asha@example.test", subject: "Hello", text: "Body" });

      expect(sent).toBe(true);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(lastMailTo("asha@example.test")).toMatchObject({ subject: "Hello", text: "Body" });
    } finally {
      restore();
      clearOutbox();
    }
  });

  it("matches a recipient case-insensitively, because an address is not case-sensitive", async () => {
    await sendMail({ to: "Asha@Example.test", subject: "Hi", text: "Body" });
    expect(lastMailTo("asha@example.test")).toBeDefined();
    clearOutbox();
  });

  it("returns the newest message for an address, not the first", async () => {
    await sendMail({ to: "asha@example.test", subject: "First", text: "1" });
    await sendMail({ to: "asha@example.test", subject: "Second", text: "2" });

    // Resend reissues a token, so a test reading the OLD mail would follow a dead
    // link and fail for entirely the wrong reason.
    expect(lastMailTo("asha@example.test").subject).toBe("Second");
    expect(getOutbox()).toHaveLength(2);
    clearOutbox();
  });
});

describe("parseMailFrom", () => {
  it("passes a bare address through untouched", () => {
    expect(parseMailFrom("hello@renteasy.test")).toEqual({ email: "hello@renteasy.test" });
  });

  it("splits the display-name form", () => {
    expect(parseMailFrom("RentEasy <hello@renteasy.test>")).toEqual({
      email: "hello@renteasy.test",
      name: "RentEasy",
    });
  });

  it("absorbs BOTH quoting mistakes, resolving them to the same sender", () => {
    // Not pedantry. dotenv strips one surrounding pair from a `.env` file and a
    // hosting dashboard stores it verbatim, so a value that works on a laptop arrives
    // quoted in production. A nodemailer-style parser turns the first of these into
    // the garbage address `"RentEasy <hello@renteasy"@test>` and sends it anyway.
    const expected = { email: "hello@renteasy.test", name: "RentEasy" };

    expect(parseMailFrom('"RentEasy <hello@renteasy.test>"')).toEqual(expected); // whole value quoted
    expect(parseMailFrom('"RentEasy" <hello@renteasy.test>')).toEqual(expected); // the RFC form
  });

  it("reports nothing to parse as null, which is what unconfigured looks like", () => {
    expect(parseMailFrom("")).toBeNull();
    expect(parseMailFrom("   ")).toBeNull();
    expect(parseMailFrom(undefined)).toBeNull();
  });
});

describe("isMailConfigured", () => {
  it("requires the key AND the sender — two of two, never one of two", () => {
    // A half-filled environment is the most common `.env` state, and Brevo rejects a
    // send whose sender is not verified. Reading a key alone as "configured" would
    // therefore 4xx on every send instead of falling back to the console — a mail
    // outage presented as a provider error.
    const cases = [
      { apiKey: "", mailFrom: "", expected: false },
      { apiKey: "xkeysib-x", mailFrom: "", expected: false },
      { apiKey: "", mailFrom: "a@b.test", expected: false },
      { apiKey: "xkeysib-x", mailFrom: "a@b.test", expected: true },
    ];

    for (const { apiKey, mailFrom, expected } of cases) {
      const restore = withMailConfig({ apiKey, mailFrom });
      try {
        expect(isMailConfigured(), `key=${apiKey || "-"} from=${mailFrom || "-"}`).toBe(expected);
      } finally {
        restore();
      }
    }
  });
});

describe("describeMailMode", () => {
  it("says the outbox under test, whatever else is configured", () => {
    const restore = withMailConfig({ apiKey: "xkeysib-x", mailFrom: "a@b.test" });
    try {
      // The banner must never claim mail is live when the test guard is what will
      // actually run — that is the line someone reads to answer "did it send?".
      expect(describeMailMode()).toMatch(/outbox/i);
    } finally {
      restore();
    }
  });

  it("never puts the API key in the banner", () => {
    const restore = withMailConfig({ apiKey: "xkeysib-secret-value", mailFrom: "a@b.test" });
    try {
      // It goes to stdout at boot, and a deployed log is not a private place.
      expect(describeMailMode()).not.toContain("secret-value");
    } finally {
      restore();
    }
  });
});

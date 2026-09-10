/**
 * Registration, verification and the gate — from the browser's side.
 *
 * `fetch` is stubbed rather than mocking the service module, so these exercise the real
 * api wrapper, the real envelope unwrapping and the real auth context. Mocking
 * `register` would only prove the form calls a function.
 */

import { StrictMode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "../context/AuthContext.jsx";
import { App } from "../App.jsx";

// Wrapped in `{ body }` because that is the shape stubFetch destructures. Registered
// bare, `json()` resolves to undefined, the terms fetch fails silently, and the submit
// button stays disabled forever — which is how seven tests failed for one reason.
const TERMS = {
  body: { success: true, message: "OK", data: { version: "2026-09-01", url: "/terms" } },
};
const NO_SESSION = {
  status: 401,
  body: { success: false, message: "Authentication required", errors: {} },
};

/**
 * The home page browses listings now, so any test rendering `/` makes three more
 * requests. Stubbed as empty rather than left unstubbed: an unstubbed call fails
 * silently into the page's error state, and the assertions here would still pass while
 * quietly testing a broken page.
 */
const EMPTY_BROWSE = {
  "/listings/categories": { body: { success: true, message: "OK", data: { categories: [] } } },
  "/listings/cities": { body: { success: true, message: "OK", data: { cities: [] } } },
  "/listings": {
    body: { success: true, message: "OK", data: { listings: [], total: 0, limit: 24, offset: 0 } },
  },
};

/** Stubs fetch from a path → response map. Longest path match wins. */
function stubFetch(routes) {
  const calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, options = {}) => {
      calls.push({ url: String(url), method: options.method ?? "GET", body: options.body });
      const key = Object.keys(routes)
        .filter((path) => String(url).includes(path))
        .sort((a, b) => b.length - a.length)[0];
      if (!key) throw new Error(`Unstubbed request: ${url}`);
      const { status = 200, body } = routes[key];
      return { ok: status < 400, status, json: async () => body };
    })
  );
  return calls;
}

function renderApp(path, routes = {}, { strict = false } = {}) {
  const calls = stubFetch({
    "/auth/me": NO_SESSION,
    "/auth/terms/current": TERMS,
    ...EMPTY_BROWSE,
    ...routes,
  });
  const tree = (
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>
  );
  // `strict` renders the way main.jsx actually does. Without it a test can claim to
  // cover StrictMode while never triggering the double-invoke — which is exactly how a
  // permanent loading spinner reached the browser with a green suite.
  render(strict ? <StrictMode>{tree}</StrictMode> : tree);
  return calls;
}

/** Fills and submits the registration form. */
async function submitRegistration(user, overrides = {}) {
  const values = { name: "Asha Patil", email: "asha@example.test", password: "a-good-password", ...overrides };

  await user.type(await screen.findByLabelText(/full name/i), values.name);
  await user.type(screen.getByLabelText(/^email$/i), values.email);
  await user.type(screen.getByLabelText(/^password$/i), values.password);
  await user.click(screen.getByRole("checkbox"));
  await user.click(screen.getByRole("button", { name: /create account/i }));

  return values;
}

describe("RegisterPage", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("submits the terms version the server said was current", async () => {
    const calls = renderApp("/register", {
      "/auth/register": { status: 202, body: { success: true, message: "Check your email.", data: null } },
    });

    const user = userEvent.setup();
    await submitRegistration(user);

    // FETCHED, not hardcoded. The server refuses a stale version with a 409 — which is
    // the whole point of the field, since it means nobody can be recorded as agreeing
    // to terms they were never shown. A constant here would silently defeat that.
    await waitFor(() => {
      const call = calls.find((c) => c.url.includes("/auth/register"));
      expect(JSON.parse(call.body).acceptedTermsVersion).toBe("2026-09-01");
    });
  });

  it("omits phone entirely when left blank, rather than sending an empty string", async () => {
    const calls = renderApp("/register", {
      "/auth/register": { status: 202, body: { success: true, message: "Check your email.", data: null } },
    });

    const user = userEvent.setup();
    await submitRegistration(user);

    // An empty string fails the schema's minimum length; `undefined` is simply absent,
    // which is what "optional" means. Sending "" would 400 a perfectly valid signup.
    await waitFor(() => {
      const call = calls.find((c) => c.url.includes("/auth/register"));
      expect("phone" in JSON.parse(call.body)).toBe(false);
    });
  });

  it("blocks submission until the terms box is ticked, without a round trip", async () => {
    const calls = renderApp("/register");

    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/full name/i), "Asha");
    await user.type(screen.getByLabelText(/^email$/i), "asha@example.test");
    await user.type(screen.getByLabelText(/^password$/i), "a-good-password");
    await user.click(screen.getByRole("button", { name: /create account/i }));

    expect(await screen.findByText(/accept the terms/i)).toBeInTheDocument();
    // The one failure a user can see and fix without asking the server.
    expect(calls.some((c) => c.url.includes("/auth/register"))).toBe(false);
  });

  it("puts field errors under the field the server named", async () => {
    renderApp("/register", {
      "/auth/register": {
        status: 400,
        body: {
          success: false,
          message: "Validation failed",
          errors: { password: "Password must be at least 10 characters" },
        },
      },
    });

    const user = userEvent.setup();
    await submitRegistration(user, { password: "short" });

    const password = screen.getByLabelText(/^password$/i);
    await waitFor(() => expect(password).toHaveAttribute("aria-invalid", "true"));
    expect(password).toHaveAccessibleDescription(/at least 10 characters/i);
  });

  it("shows the server's message when the terms have moved on", async () => {
    renderApp("/register", {
      "/auth/register": {
        status: 409,
        body: { success: false, message: "The terms have been updated.", errors: {} },
      },
    });

    const user = userEvent.setup();
    await submitRegistration(user);

    expect(await screen.findByRole("alert")).toHaveTextContent(/terms have been updated/i);
  });
});

describe("after registering — the enumeration guarantee, at the last mile", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("never claims an account was created", async () => {
    renderApp("/register", {
      "/auth/register": { status: 202, body: { success: true, message: "Check your email.", data: null } },
    });

    const user = userEvent.setup();
    const { email } = await submitRegistration(user);

    expect(await screen.findByRole("heading", { name: /check your inbox/i })).toBeInTheDocument();
    expect(screen.getByText(email)).toBeInTheDocument();

    // THE ASSERTION THAT PROTECTS THE WHOLE DESIGN.
    //
    // The API answers identically whether the address was new, unverified, or already a
    // live account — so this page must be true in all three cases and distinguish none.
    // "Account created" is false when the address already had one; "we've sent you a
    // link" is false for a verified address, which gets a "someone tried to sign up"
    // notice instead.
    //
    // It is very easy to "improve" this copy into an enumeration oracle, so it is
    // pinned here.
    const page = document.body.textContent;
    expect(page).not.toMatch(/account created/i);
    expect(page).not.toMatch(/we.{0,3}ve sent you a link/i);
    expect(page).not.toMatch(/already registered/i);
    expect(page).not.toMatch(/welcome/i);
  });

  it("does not sign anyone in", async () => {
    renderApp("/register", {
      "/auth/register": { status: 202, body: { success: true, message: "Check your email.", data: null } },
    });

    const user = userEvent.setup();
    await submitRegistration(user);
    await screen.findByRole("heading", { name: /check your inbox/i });

    // The API issues no session, because at this moment nobody has proved the address
    // is theirs. The UI must not imply otherwise — no "Sign out", no signed-in header.
    expect(screen.queryByRole("button", { name: /sign out/i })).not.toBeInTheDocument();
  });

  it("redirects away if reached directly, with no address to show", async () => {
    renderApp("/check-email");

    // A hollow "check your email" for an address nobody supplied says nothing.
    expect(await screen.findByRole("heading", { name: /create your account/i })).toBeInTheDocument();
  });
});

describe("VerifyPage", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("confirms an email and offers the way onward", async () => {
    renderApp("/verify/a-valid-token", {
      "/auth/verify": {
        body: { success: true, message: "Email confirmed.", data: { alreadyVerified: false } },
      },
    });

    expect(await screen.findByRole("heading", { name: /email confirmed/i })).toBeInTheDocument();
  });

  it("treats a second click as success, not failure", async () => {
    renderApp("/verify/a-used-token", {
      "/auth/verify": {
        body: { success: true, message: "Already confirmed.", data: { alreadyVerified: true } },
      },
    });

    // Mail clients prefetch links, so this path is common rather than exotic — telling
    // someone their working link failed would be actively misleading.
    expect(await screen.findByRole("heading", { name: /already confirmed/i })).toBeInTheDocument();
  });

  it("consumes the token exactly once, despite StrictMode — and still reports the result", async () => {
    const calls = renderApp(
      "/verify/a-valid-token",
      {
        "/auth/verify": {
          body: { success: true, message: "Email confirmed.", data: { alreadyVerified: false } },
        },
      },
      { strict: true }
    );

    // THE ASSERTION THAT WAS MISSING. Reaching a terminal state matters as much as the
    // call count: a guard that suppresses the retry is worthless if it also suppresses
    // the ANSWER. This exact combination shipped a spinner that span forever in
    // development — one request correctly made, its result silently discarded.
    await screen.findByRole("heading", { name: /email confirmed/i });

    // The token is SINGLE-USE. StrictMode double-invokes effects in development, so
    // without the ref guard the second run would consume an already-used token and
    // report a perfectly good link as broken — every time, in development only.
    expect(calls.filter((c) => c.url.includes("/auth/verify")).length).toBe(1);
  });

  it("explains what to do rather than why a dead link failed", async () => {
    renderApp("/verify/expired-token", {
      "/auth/verify": {
        status: 410,
        body: { success: false, message: "This link is no longer valid", errors: {} },
      },
    });

    expect(await screen.findByRole("heading", { name: /no longer works/i })).toBeInTheDocument();

    // The API answers identically for expired, used, unknown and malformed, so that
    // guessing a token reveals nothing. Naming a specific cause here would leak at the
    // last mile what the API went to lengths to withhold — so the copy is about the
    // next step, which is the only useful thing to say.
    expect(await screen.findByRole("link", { name: /sign in to get a new link/i })).toBeInTheDocument();
  });
});

describe("the verification gate", () => {
  beforeEach(() => vi.restoreAllMocks());

  const unverified = {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Asha Patil",
    email: "asha@example.test",
    email_verified_at: null,
  };

  it("nags an unverified user without blocking the marketplace", async () => {
    renderApp("/", { "/auth/me": { body: { success: true, message: "OK", data: { user: unverified } } } });

    expect(await screen.findByText(/confirm your email/i)).toBeInTheDocument();
    // A banner, not a wall. Blocking an unverified user from browsing would hide the
    // very thing that makes confirming worth doing.
    expect(screen.getByRole("heading", { name: /rent almost anything/i })).toBeInTheDocument();
  });

  it("shows no banner once confirmed", async () => {
    renderApp("/", {
      "/auth/me": {
        body: {
          success: true,
          message: "OK",
          data: { user: { ...unverified, email_verified_at: "2026-09-08T00:00:00Z" } },
        },
      },
    });

    await screen.findByRole("heading", { name: /rent almost anything/i });
    expect(screen.queryByText(/confirm your email/i)).not.toBeInTheDocument();
  });

  it("reports the same thing after a resend, whatever the server did", async () => {
    renderApp("/", {
      "/auth/me": { body: { success: true, message: "OK", data: { user: unverified } } },
      "/auth/verify/resend": { status: 202, body: { success: true, message: "Check your email.", data: null } },
    });

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /resend link/i }));

    // The endpoint answers 202 whether it sent, was inside the cooldown, or the account
    // was already verified. The UI mirrors that single answer rather than inventing a
    // distinction the server deliberately refuses to make.
    expect(await screen.findByText(/check your inbox/i)).toBeInTheDocument();
  });
});

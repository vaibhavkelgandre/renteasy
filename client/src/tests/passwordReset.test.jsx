/**
 * Password reset, from the browser's side.
 *
 * `fetch` is stubbed rather than mocking the api module, so these exercise the real
 * api wrapper, the real envelope unwrapping and the real routing. The two things most
 * worth pinning are the ones easiest to break by editing copy: the confirmation panel
 * must not confirm that an account exists, and a spent link must explain what to do
 * rather than what went wrong.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "../context/AuthContext.jsx";
import { App } from "../App.jsx";

const TERMS = {
  body: { success: true, message: "OK", data: { version: "2026-09-01", url: "/terms" } },
};
const NO_SESSION = {
  status: 401,
  body: { success: false, message: "Authentication required", errors: {} },
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

function renderApp(path, routes = {}) {
  const calls = stubFetch({ "/auth/me": NO_SESSION, "/auth/terms/current": TERMS, ...routes });
  render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>
  );
  return calls;
}

const ACCEPTED = {
  status: 202,
  body: {
    success: true,
    message: "If that address has an account, we've emailed a reset link.",
    data: null,
  },
};

const GONE = {
  status: 410,
  body: { success: false, message: "This link is no longer valid", errors: {} },
};

describe("ForgotPasswordPage", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("posts the address and shows a confirmation", async () => {
    const calls = renderApp("/forgot-password", { "/auth/forgot-password": ACCEPTED });

    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/email/i), "asha@example.test");
    await user.click(screen.getByRole("button", { name: /send reset link/i }));

    expect(await screen.findByRole("heading", { name: /check your inbox/i })).toBeInTheDocument();
    await waitFor(() => {
      const call = calls.find((c) => c.url.includes("/auth/forgot-password"));
      expect(JSON.parse(call.body)).toEqual({ email: "asha@example.test" });
    });
  });

  it("NEVER confirms that the address has an account", async () => {
    renderApp("/forgot-password", { "/auth/forgot-password": ACCEPTED });

    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/email/i), "asha@example.test");
    await user.click(screen.getByRole("button", { name: /send reset link/i }));

    await screen.findByRole("heading", { name: /check your inbox/i });

    // THE ASSERTION THAT PROTECTS THE WHOLE DESIGN.
    //
    // The API answers identically for a live account, a suspended one, an unknown
    // address and a request inside its cooldown — so this page must be true in all
    // four and distinguish none. "We've sent you a link" is false for an address with
    // no account, and is the easiest way to hand back exactly what the identical 202
    // withholds.
    const page = document.body.textContent;
    expect(page).toMatch(/if .* has a RentEasy account/i);
    expect(page).not.toMatch(/we.{0,3}ve sent you a link/i);
    expect(page).not.toMatch(/account found/i);
    expect(page).not.toMatch(/no account/i);

    // The address is echoed, because a typo is the commonest reason nothing arrives.
    expect(screen.getByText("asha@example.test")).toBeInTheDocument();
  });

  it("shows a field error for a malformed address without claiming anything was sent", async () => {
    renderApp("/forgot-password", {
      "/auth/forgot-password": {
        status: 400,
        body: {
          success: false,
          message: "Validation failed",
          errors: { email: "Must be a valid email" },
        },
      },
    });

    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/email/i), "nope");
    await user.click(screen.getByRole("button", { name: /send reset link/i }));

    const field = await screen.findByLabelText(/email/i);
    await waitFor(() => expect(field).toHaveAttribute("aria-invalid", "true"));
    expect(screen.queryByRole("heading", { name: /check your inbox/i })).not.toBeInTheDocument();
  });
});

describe("ResetPasswordPage", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("does NOT spend the token on page load", async () => {
    const calls = renderApp("/reset-password/tok-123", { "/auth/reset-password": { body: {} } });

    await screen.findByRole("heading", { name: /set a new password/i });

    // The structural difference from VerifyPage, and it is not cosmetic: mail clients
    // and link scanners prefetch links, so a page that consumed its token on mount
    // would be burned before the recipient typed anything — and they would be told a
    // good link had expired.
    expect(calls.some((c) => c.url.includes("/auth/reset-password"))).toBe(false);
  });

  it("posts the token from the URL with the new password", async () => {
    const calls = renderApp("/reset-password/tok-123", {
      "/auth/reset-password": {
        body: { success: true, message: "Password updated. You can now sign in.", data: null },
      },
    });

    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/^new password$/i), "a-brand-new-password");
    await user.type(screen.getByLabelText(/confirm new password/i), "a-brand-new-password");
    await user.click(screen.getByRole("button", { name: /update password/i }));

    await waitFor(() => {
      const call = calls.find((c) => c.url.includes("/auth/reset-password"));
      expect(JSON.parse(call.body)).toEqual({
        token: "tok-123",
        password: "a-brand-new-password",
      });
    });
  });

  it("lands on sign-in afterwards, saying the password was updated", async () => {
    renderApp("/reset-password/tok-123", {
      "/auth/reset-password": {
        body: { success: true, message: "Password updated. You can now sign in.", data: null },
      },
    });

    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/^new password$/i), "a-brand-new-password");
    await user.type(screen.getByLabelText(/confirm new password/i), "a-brand-new-password");
    await user.click(screen.getByRole("button", { name: /update password/i }));

    // FR-025: no session is issued, so the only correct destination is sign-in — and
    // saying why is what stops "it worked but I'm not logged in" reading as a bug.
    expect(await screen.findByRole("heading", { name: /welcome back/i })).toBeInTheDocument();
    expect(await screen.findByRole("status")).toHaveTextContent(/password has been updated/i);
  });

  it("catches a mismatched confirmation WITHOUT a round trip", async () => {
    const calls = renderApp("/reset-password/tok-123", {
      "/auth/reset-password": { body: {} },
    });

    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/^new password$/i), "a-brand-new-password");
    await user.type(screen.getByLabelText(/confirm new password/i), "a-different-thing");
    await user.click(screen.getByRole("button", { name: /update password/i }));

    expect(await screen.findByText(/do not match/i)).toBeInTheDocument();
    // The confirm field is not a server concern — the API takes one password. Sending
    // it would spend the token on a typo the user can fix for free.
    expect(calls.some((c) => c.url.includes("/auth/reset-password"))).toBe(false);
  });

  it("explains what to DO when the link is spent, and offers a new one", async () => {
    renderApp("/reset-password/tok-123", { "/auth/reset-password": GONE });

    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/^new password$/i), "a-brand-new-password");
    await user.type(screen.getByLabelText(/confirm new password/i), "a-brand-new-password");
    await user.click(screen.getByRole("button", { name: /update password/i }));

    expect(
      await screen.findByRole("heading", { name: /no longer works/i })
    ).toBeInTheDocument();

    // The API will not say WHICH of expired / used / unknown / address-changed it was,
    // so the copy must not guess — it says what the rules are and where to go next.
    // The form is gone, because leaving one the user can only fail at again is worse
    // than replacing it.
    expect(screen.queryByRole("button", { name: /update password/i })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /request a new link/i })).toBeInTheDocument();
  });
});

describe("LoginPage", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("links to the reset flow", async () => {
    renderApp("/login");

    // FR-027. Before this the page promised help for an unconfirmed EMAIL and said
    // nothing about a forgotten PASSWORD, which is the gap a user actually falls into.
    const link = await screen.findByRole("link", { name: /forgot your password/i });
    expect(link).toHaveAttribute("href", "/forgot-password");
  });
});

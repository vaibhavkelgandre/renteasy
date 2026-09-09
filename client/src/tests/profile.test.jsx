/**
 * The account page, the public profile, and the terms page.
 *
 * The assertions that matter most are the two that protect a guarantee rather than a
 * behaviour: the email-change confirmation must not reveal whether an address is taken,
 * and a public profile must never render a contact detail.
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

const USER = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Asha Patil",
  email: "asha@example.test",
  phone: "9876543210",
  status: "ACTIVE",
  is_admin: false,
  email_verified_at: "2026-09-01T00:00:00Z",
  pending_email: null,
  created_at: "2026-03-14T00:00:00Z",
};

const SESSION = { body: { success: true, message: "OK", data: { user: USER } } };

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

describe("ProfilePage — the guard", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("bounces a signed-out visitor to sign in", async () => {
    renderApp("/profile");

    // The first exercise RequireAuth has ever had. It guarded zero routes until this
    // page existed, so nothing had proved it works in place.
    expect(await screen.findByRole("heading", { name: /welcome back/i })).toBeInTheDocument();
  });

  it("renders the account page for a signed-in user", async () => {
    renderApp("/profile", { "/auth/me": SESSION });

    expect(await screen.findByRole("heading", { name: /^your account$/i })).toBeInTheDocument();
    expect(screen.getByDisplayValue("Asha Patil")).toBeInTheDocument();
    expect(screen.getByText("asha@example.test")).toBeInTheDocument();
  });
});

describe("ProfilePage — details", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("sends null rather than an empty string when the phone is cleared", async () => {
    const calls = renderApp("/profile", {
      "/auth/me": SESSION,
      "/profile": { body: { success: true, message: "Profile updated", data: { user: USER } } },
    });

    const user = userEvent.setup();
    await user.clear(await screen.findByLabelText(/phone/i));
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    // `undefined` means "leave alone" and `null` means "clear". An empty string is
    // neither — it fails the schema's minimum length and would 400 a legitimate edit.
    await waitFor(() => {
      const call = calls.find((c) => c.method === "PATCH" && c.url.includes("/profile"));
      expect(JSON.parse(call.body).phone).toBeNull();
    });
  });
});

describe("ProfilePage — changing the email", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("NEVER says whether the new address already has an account", async () => {
    renderApp("/profile", {
      "/auth/me": SESSION,
      "/profile/email": {
        status: 202,
        body: { success: true, message: "Check the new address…", data: null },
      },
    });

    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/new email/i), "new@example.test");
    await user.type(screen.getByLabelText(/^your password$/i), "a-good-password");
    await user.click(screen.getByRole("button", { name: /send confirmation link/i }));

    // THE ASSERTION THAT PROTECTS THE GUARANTEE. The API answers identically whether
    // the address is free, belongs to someone else, or is the caller's own — so this
    // copy must be true in all three and distinguish none. Refusing with "that email is
    // taken" would hand any signed-in user an enumeration oracle over the platform.
    const panel = await screen.findByText(/if that address is available/i);
    expect(panel).toBeInTheDocument();

    const page = document.body.textContent;
    expect(page).not.toMatch(/already (in use|taken|registered)/i);
    expect(page).not.toMatch(/we.{0,3}ve sent you a link/i);
  });

  it("keeps showing the current address, and says the change is pending", async () => {
    renderApp("/profile", {
      "/auth/me": {
        body: {
          success: true,
          message: "OK",
          data: { user: { ...USER, pending_email: "new@example.test" } },
        },
      },
    });

    await screen.findByRole("heading", { name: /^your account$/i });

    // The point of FR-030 rendered: nothing has moved, and the page has to say so or a
    // link sitting in another inbox is completely invisible.
    expect(screen.getByText("asha@example.test")).toBeInTheDocument();
    expect(screen.getByText(/waiting for confirmation of/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /cancel this change/i })).toBeInTheDocument();
  });

  it("offers no cancel action when nothing is pending", async () => {
    renderApp("/profile", { "/auth/me": SESSION });

    await screen.findByRole("heading", { name: /^your account$/i });
    expect(screen.queryByRole("button", { name: /cancel this change/i })).not.toBeInTheDocument();
  });
});

describe("ProfilePage — password and deletion", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("catches a mismatched confirmation without a round trip", async () => {
    const calls = renderApp("/profile", { "/auth/me": SESSION });

    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/^current password$/i), "a-good-password");
    await user.type(screen.getByLabelText(/^new password$/i), "a-brand-new-password");
    await user.type(screen.getByLabelText(/confirm new password/i), "something-else-here");
    await user.click(screen.getByRole("button", { name: /update password/i }));

    expect(await screen.findByText(/do not match/i)).toBeInTheDocument();
    expect(calls.some((c) => c.url.includes("/profile/password"))).toBe(false);
  });

  it("states both consequences of deletion BEFORE asking for a password", async () => {
    renderApp("/profile", { "/auth/me": SESSION });

    await screen.findByRole("heading", { name: /^your account$/i });

    // The second consequence is surprising and permanent, and a person deserves to know
    // it while they are still deciding — not in a confirmation dialog after they have
    // committed to the idea.
    expect(screen.getByText(/cannot be undone/i)).toBeInTheDocument();
    expect(screen.getByText(/stays claimed by the deleted account/i)).toBeInTheDocument();

    // And the destructive control is behind a deliberate second step.
    expect(screen.queryByRole("button", { name: /permanently delete/i })).not.toBeInTheDocument();
  });

  it("asks for a password before deleting", async () => {
    renderApp("/profile", { "/auth/me": SESSION });

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /^delete account$/i }));

    expect(await screen.findByRole("button", { name: /permanently delete/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /keep my account/i })).toBeInTheDocument();
  });
});

describe("PublicProfilePage", () => {
  beforeEach(() => vi.restoreAllMocks());

  const PROFILE = {
    body: {
      success: true,
      message: "OK",
      data: {
        profile: {
          id: USER.id,
          name: "Asha Patil",
          memberSince: "2026-03-14T00:00:00Z",
          emailVerified: true,
          rating: null,
          listingCount: null,
        },
      },
    },
  };

  it("shows the name and member-since, with NO contact details", async () => {
    renderApp(`/u/${USER.id}`, { [`/users/${USER.id}/public`]: PROFILE });

    expect(await screen.findByRole("heading", { name: /asha patil/i })).toBeInTheDocument();
    expect(screen.getByText(/member since march 2026/i)).toBeInTheDocument();

    // FR-033's hard rule, asserted at the last mile. A marketplace puts strangers in
    // contact; leaking an address from a profile page is the difference between
    // "someone wants to rent my camera" and "someone knows how to reach me at home".
    const page = document.body.textContent;
    expect(page).not.toContain("asha@example.test");
    expect(page).not.toContain("9876543210");
  });

  it("shows unknown rather than zero for listings and rating", async () => {
    renderApp(`/u/${USER.id}`, { [`/users/${USER.id}/public`]: PROFILE });

    await screen.findByRole("heading", { name: /asha patil/i });

    // A hardcoded 0 would read as "this person has never listed anything" rather than
    // "listings do not exist yet".
    const listings = screen.getByText(/^listings$/i).parentElement;
    expect(listings).toHaveTextContent("—");
  });

  it("needs no session", async () => {
    // Rendered with /auth/me answering 401, which renderApp does by default.
    renderApp(`/u/${USER.id}`, { [`/users/${USER.id}/public`]: PROFILE });
    expect(await screen.findByRole("heading", { name: /asha patil/i })).toBeInTheDocument();
  });

  it("explains a 404 without saying which cause it was", async () => {
    renderApp(`/u/${USER.id}`, {
      [`/users/${USER.id}/public`]: {
        status: 404,
        body: { success: false, message: "Profile not found", errors: {} },
      },
    });

    expect(await screen.findByRole("heading", { name: /profile not found/i })).toBeInTheDocument();
    // Unknown id, malformed id and a deleted account all answer identically, so the
    // copy must not guess between them.
    expect(screen.getByText(/may no longer be active/i)).toBeInTheDocument();
  });
});

describe("TermsPage", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("renders, and admits the text is a placeholder", async () => {
    renderApp("/terms");

    expect(await screen.findByRole("heading", { name: /terms of use/i })).toBeInTheDocument();

    // The link on the registration form used to 404. Replacing that with
    // plausible-sounding legalese nobody wrote would be worse: registration records
    // WHICH version each person accepted, and that record has to mean something.
    expect(screen.getByText(/placeholder text/i)).toBeInTheDocument();
  });

  it("shows the version the API reports, rather than a hardcoded one", async () => {
    renderApp("/terms");

    // This page and the registration checkbox must never disagree about what is
    // current — the 409 on a stale version exists precisely so nobody is recorded as
    // agreeing to something they were not shown.
    expect(await screen.findByText(/version 2026-09-01/i)).toBeInTheDocument();
  });
});

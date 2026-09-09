/**
 * The account page's collapsible sections, and the header's single account control.
 *
 * Split from profile.test.jsx because these test the SHELL — what is on screen before
 * you interact, and what it takes to reveal a form — rather than what each form does.
 * The behaviour tests live next door and open a section first.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
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

const SECTION_HEADERS = [
  /your details/i,
  /^email address/i,
  /^password$/i,
  /delete your account/i,
];

describe("the account page starts closed", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("shows four headers and NO form fields until one is opened", async () => {
    renderApp("/profile", { "/auth/me": SESSION });

    await screen.findByRole("heading", { name: /^your account$/i });

    for (const name of SECTION_HEADERS) {
      expect(screen.getByRole("button", { name, expanded: false })).toBeInTheDocument();
    }

    // NOT RENDERED, not merely hidden. A visually hidden form is still in the tab
    // order, so a keyboard user would tab through three closed forms to reach the
    // fourth. This is what stops the collapse being "simplified" into a CSS class.
    expect(screen.queryByDisplayValue("Asha Patil")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/new email/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /permanently delete/i })).not.toBeInTheDocument();
  });

  it("opens one section on click and leaves the others shut", async () => {
    renderApp("/profile", { "/auth/me": SESSION });

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /your details/i, expanded: false }));

    expect(screen.getByDisplayValue("Asha Patil")).toBeInTheDocument();

    // Independent toggles, not an accordion that shuts its neighbours: someone changing
    // their email may well want the password form open at the same time.
    expect(screen.getByRole("button", { name: /^password$/i, expanded: false })).toBeInTheDocument();
    expect(screen.queryByLabelText(/new email/i)).not.toBeInTheDocument();
  });

  it("closes again on a second click", async () => {
    renderApp("/profile", { "/auth/me": SESSION });

    const user = userEvent.setup();
    const header = await screen.findByRole("button", { name: /your details/i });

    await user.click(header);
    expect(screen.getByDisplayValue("Asha Patil")).toBeInTheDocument();

    await user.click(header);
    expect(screen.queryByDisplayValue("Asha Patil")).not.toBeInTheDocument();
  });

  it("announces a pending email change in the header, WITHOUT opening the section", async () => {
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

    // Required rather than decorative now that sections start closed: the pending state
    // lives inside this section, so with it shut a link sitting in another inbox would
    // be completely invisible and the page would look like nothing had happened.
    const header = screen.getByRole("button", { name: /^email address/i, expanded: false });
    expect(header).toHaveTextContent(/waiting for confirmation of/i);
    expect(header).toHaveTextContent("new@example.test");
    expect(header).toHaveTextContent(/still using/i);
  });
});

describe("the header's account control", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("is ONE control, not a separate Account link and Sign out button", async () => {
    renderApp("/", { "/auth/me": SESSION });

    expect(await screen.findByRole("button", { name: /account menu for asha patil/i })).toBeInTheDocument();

    // Two controls for one subject spent twice the width of a phone header on something
    // used rarely, and left a destructive action one stray tap away on every page.
    expect(screen.queryByRole("link", { name: /^account$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^sign out$/i })).not.toBeInTheDocument();
  });

  it("keeps the email out of the page chrome until the menu is opened", async () => {
    renderApp("/", { "/auth/me": SESSION });

    await screen.findByRole("button", { name: /account menu for asha patil/i });

    // The address should not be sitting on screen on every page for anyone nearby to
    // read. It belongs in the menu, which is where someone deliberately looks to check
    // which account they are in.
    expect(screen.queryByText("asha@example.test")).not.toBeInTheDocument();
  });

  it("opens a menu with the account link and sign out", async () => {
    renderApp("/", { "/auth/me": SESSION });

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /account menu for asha patil/i }));

    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.getByText("asha@example.test")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /your account/i })).toHaveAttribute(
      "href",
      "/profile"
    );
    expect(screen.getByRole("menuitem", { name: /sign out/i })).toBeInTheDocument();
  });

  it("closes on Escape", async () => {
    renderApp("/", { "/auth/me": SESSION });

    const user = userEvent.setup();
    const trigger = await screen.findByRole("button", { name: /account menu for asha patil/i });
    await user.click(trigger);
    expect(screen.getByRole("menu")).toBeInTheDocument();

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    // Focus returns to the trigger, or a keyboard user is dropped at the top of the
    // document with no idea where they were.
    expect(trigger).toHaveFocus();
  });

  it("signs out from inside the menu", async () => {
    const calls = renderApp("/", { "/auth/me": SESSION, "/auth/logout": { body: { success: true, message: "Signed out", data: null } } });

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /account menu for asha patil/i }));
    await user.click(screen.getByRole("menuitem", { name: /sign out/i }));

    expect(calls.some((c) => c.url.includes("/auth/logout"))).toBe(true);
  });

  it("shows nothing account-shaped to a signed-out visitor", async () => {
    renderApp("/");

    // Scoped to the banner: the home page has its own sign-in link, so an unscoped
    // query legitimately finds two and the failure would say nothing useful.
    const header = within(await screen.findByRole("banner"));
    expect(header.getByRole("link", { name: /sign in/i })).toBeInTheDocument();
    expect(header.queryByRole("button", { name: /account menu/i })).not.toBeInTheDocument();
  });
});

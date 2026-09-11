/**
 * The bell and the notifications page — FR-986.
 *
 * The assertions worth having are the ones protecting behaviour that is invisible
 * when broken: the badge reading its own endpoint rather than counting a list, the
 * bell not fetching that list until it is opened, and a notification going to the
 * thing it is about.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "../context/AuthContext.jsx";
import { App } from "../App.jsx";

const USER = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Asha Patil",
  email: "asha@renteasy.test",
  phone: null,
  status: "ACTIVE",
  is_admin: false,
  email_verified_at: "2026-09-01T00:00:00Z",
  pending_email: null,
  created_at: "2026-03-14T00:00:00Z",
};

const SESSION = { body: { success: true, message: "OK", data: { user: USER } } };
const TERMS = {
  body: { success: true, message: "OK", data: { version: "2026-09-01", url: "/terms" } },
};
const NO_LISTINGS = {
  body: { success: true, message: "OK", data: { listings: [], total: 0, limit: 24, offset: 0 } },
};

const BOOKING_ID = "22222222-2222-4222-8222-222222222222";

const notification = (overrides = {}) => ({
  id: "33333333-3333-4333-8333-333333333333",
  type: "BOOKING_REQUESTED",
  entity_type: "BOOKING",
  entity_id: BOOKING_ID,
  message: 'Someone wants to rent your "Canon EOS R6".',
  read_at: null,
  created_at: "2026-10-03T09:00:00.000Z",
  ...overrides,
});

const list = (notifications, total = notifications.length) => ({
  body: { success: true, message: "OK", data: { notifications, total, limit: 20, offset: 0 } },
});

const count = (unread) => ({ body: { success: true, message: "OK", data: { unread } } });

function stubFetch(routes) {
  const calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, options = {}) => {
      calls.push({ url: String(url), method: options.method ?? "GET" });
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
  const calls = stubFetch({
    "/auth/me": SESSION,
    "/auth/terms/current": TERMS,
    "/listings/categories": { body: { success: true, message: "OK", data: { categories: [] } } },
    "/listings/cities": { body: { success: true, message: "OK", data: { cities: [] } } },
    "/listings?": NO_LISTINGS,
    // The FULL path, because `stubFetch` picks the longest matching key and a bare
    // "/notifications" would otherwise lose to nothing but win over itself.
    "/notifications/unread-count": count(0),
    "/notifications": list([]),
    ...routes,
  });

  render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>
  );
  return calls;
}

describe("the bell", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("reads its badge from the count endpoint, never from the list", async () => {
    const calls = renderApp("/", { "/notifications/unread-count": count(3) });

    // The number in the accessible name, so a screen reader gets what the badge
    // shows rather than an unlabelled button.
    expect(await screen.findByRole("button", { name: /3 unread/i })).toBeInTheDocument();

    // AND THE LIST WAS NEVER FETCHED. This is the assertion that matters: the badge
    // is polled on every page for every signed-in user, and deriving it from a page
    // of rows would make the most frequent request in the product one of the most
    // expensive.
    await waitFor(() => expect(calls.some((c) => c.url.includes("unread-count"))).toBe(true));
    expect(calls.filter((c) => /\/notifications(\?|$)/.test(c.url))).toHaveLength(0);
  });

  it("fetches the list only once it is opened", async () => {
    const calls = renderApp("/", {
      "/notifications/unread-count": count(1),
      "/notifications": list([notification()]),
    });

    await screen.findByRole("button", { name: /1 unread/i });
    const before = calls.filter((c) => c.url.includes("limit=8")).length;
    expect(before).toBe(0);

    await userEvent.click(screen.getByRole("button", { name: /1 unread/i }));

    expect(await screen.findByText(/someone wants to rent your/i)).toBeInTheDocument();
    expect(calls.filter((c) => c.url.includes("limit=8")).length).toBe(1);
  });

  it("links a notification to the thing it is about", async () => {
    renderApp("/", {
      "/notifications/unread-count": count(1),
      "/notifications": list([notification()]),
    });

    await userEvent.click(await screen.findByRole("button", { name: /1 unread/i }));

    const link = await screen.findByRole("link", { name: /someone wants to rent your/i });
    expect(link).toHaveAttribute("href", `/bookings/${BOOKING_ID}`);
  });

  it("shows no badge at all when there is nothing unread", async () => {
    renderApp("/", { "/notifications/unread-count": count(0) });

    // A zero badge is noise on every page for everybody who has read everything.
    const bell = await screen.findByRole("button", { name: /^notifications$/i });
    expect(bell).toBeInTheDocument();
    expect(bell).not.toHaveTextContent(/\d/);
  });

  it("caps the badge rather than letting two digits break the control", async () => {
    renderApp("/", { "/notifications/unread-count": count(42) });

    // Past nine the exact number stops changing what anybody does about it, and a
    // two-digit badge on a 36px button either overflows or shrinks to unreadable.
    const bell = await screen.findByRole("button", { name: /42 unread/i });
    expect(bell).toHaveTextContent("9+");
  });
});

describe("the notifications page", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("lists them, newest first as the server sent them", async () => {
    renderApp("/notifications", {
      "/notifications": list([
        notification({ id: "a", message: "Your booking was accepted." }),
        notification({ id: "b", message: "Someone wants to rent your thing.", read_at: "2026-10-03T10:00:00Z" }),
      ]),
    });

    expect(await screen.findByText(/your booking was accepted/i)).toBeInTheDocument();
    expect(screen.getByText(/someone wants to rent your thing/i)).toBeInTheDocument();
  });

  it("marks one read when it is opened, without waiting to navigate", async () => {
    const calls = renderApp("/notifications", {
      "/notifications": list([notification()]),
    });

    await userEvent.click(await screen.findByRole("link", { name: /someone wants to rent your/i }));

    await waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.url.includes("/read"))).toBe(true)
    );
  });

  it("offers Mark all read only when something is unread", async () => {
    renderApp("/notifications", {
      "/notifications": list([notification({ read_at: "2026-10-03T10:00:00Z" })]),
    });

    await screen.findByText(/someone wants to rent your/i);
    expect(screen.queryByRole("button", { name: /mark all read/i })).not.toBeInTheDocument();
  });

  it("says something useful when there is nothing", async () => {
    renderApp("/notifications", { "/notifications": list([]) });

    expect(await screen.findByRole("heading", { name: /nothing yet/i })).toBeInTheDocument();
    // An empty state that only says "empty" leaves somebody wondering whether it is
    // broken; this one says what would put something here.
    expect(screen.getByText(/when somebody asks to rent your things/i)).toBeInTheDocument();
  });

  it("pages on the total, not on what this page happens to hold", async () => {
    renderApp("/notifications", {
      "/notifications": list([notification()], 45),
    });

    await screen.findByText(/someone wants to rent your/i);
    expect(screen.getByRole("button", { name: /older/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /newer/i })).toBeDisabled();
  });
});

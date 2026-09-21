/**
 * The messaging screens.
 *
 * The assertions worth having protect the decisions: an inbox that says who you are
 * talking to and which side you are on, a thread that closes with its booking, and
 * an attachment that never carries a provider URL.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "../context/AuthContext.jsx";
import { App } from "../App.jsx";

const ME = "11111111-1111-4111-8111-111111111111";
const THEM = "44444444-4444-4444-8444-444444444444";
const BOOKING = "22222222-2222-4222-8222-222222222222";
const MESSAGE_ID = "33333333-3333-4333-8333-333333333333";

const USER = {
  id: ME,
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

const thread = (overrides = {}) => ({
  booking_id: BOOKING,
  booking_status: "ACCEPTED",
  starts_at: "2026-10-03T09:00:00Z",
  ends_at: "2026-10-05T09:00:00Z",
  listing_title: "Canon EOS R6",
  other_party_name: "Rohan Mehta",
  my_role: "owner",
  last_body: "Can I collect at eight?",
  last_kind: "TEXT",
  last_at: "2026-10-01T10:00:00Z",
  last_sender_id: THEM,
  unread: 2,
  ...overrides,
});

const message = (overrides = {}) => ({
  id: MESSAGE_ID,
  booking_id: BOOKING,
  sender_id: THEM,
  sender_name: "Rohan Mehta",
  kind: "TEXT",
  body: "Can I collect at eight?",
  hasAttachment: false,
  created_at: "2026-10-01T10:00:00Z",
  ...overrides,
});

const threads = (list) => ({ body: { success: true, message: "OK", data: { threads: list } } });

const messages = (list, canSend = true) => ({
  body: {
    success: true,
    message: "OK",
    data: { messages: list, canSend, bookingStatus: "ACCEPTED" },
  },
});

const BOOKING_RESPONSE = {
  body: {
    success: true,
    message: "OK",
    data: {
      booking: {
        id: BOOKING,
        listing_title: "Canon EOS R6",
        status: "ACCEPTED",
        owner_id: ME,
        renter_id: THEM,
        starts_at: "2026-10-03T09:00:00Z",
        ends_at: "2026-10-05T09:00:00Z",
        events: [],
      },
    },
  },
};

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
  const calls = stubFetch({
    "/auth/me": SESSION,
    "/auth/terms/current": TERMS,
    "/notifications/unread-count": { body: { success: true, message: "OK", data: { unread: 0 } } },
    "/bookings/messages/unread-count": {
      body: { success: true, message: "OK", data: { total: 0, byBooking: {} } },
    },
    "/bookings/messages/threads": threads([]),
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

describe("the inbox", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("names the other party and which side of the rental you are on", async () => {
    renderApp("/messages", { "/bookings/messages/threads": threads([thread()]) });

    expect(await screen.findByText("Rohan Mehta")).toBeInTheDocument();
    // Without this, somebody who both lends and rents cannot tell their two
    // conversations apart.
    expect(screen.getByText("lending")).toBeInTheDocument();
    expect(screen.getByText("Canon EOS R6")).toBeInTheDocument();
  });

  it("marks a thread whose last word was yours", async () => {
    renderApp("/messages", {
      "/bookings/messages/threads": threads([thread({ last_sender_id: ME, unread: 0 })]),
    });

    // Whether a thread waits on you or on them is the only thing most people scan
    // an inbox for.
    expect(await screen.findByText(/^You:/)).toBeInTheDocument();
  });

  it("summarises a photo rather than showing an empty line", async () => {
    renderApp("/messages", {
      "/bookings/messages/threads": threads([thread({ last_kind: "IMAGE", last_body: null })]),
    });

    expect(await screen.findByText("Photo")).toBeInTheDocument();
  });

  it("links a row to its thread", async () => {
    renderApp("/messages", { "/bookings/messages/threads": threads([thread()]) });

    const link = await screen.findByRole("link", { name: /Rohan Mehta/ });
    expect(link).toHaveAttribute("href", `/messages/${BOOKING}`);
  });

  it("explains an empty inbox rather than just showing nothing", async () => {
    renderApp("/messages");

    expect(
      await screen.findByRole("heading", { name: /no conversations yet/i })
    ).toBeInTheDocument();
    expect(screen.getByText(/a conversation starts when you request an item/i)).toBeInTheDocument();
  });
});

describe("a thread", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("shows the conversation and a way back to the booking", async () => {
    renderApp(`/messages/${BOOKING}`, {
      [`/bookings/${BOOKING}`]: BOOKING_RESPONSE,
      [`/bookings/${BOOKING}/messages`]: messages([message()]),
    });

    expect(await screen.findByText("Can I collect at eight?")).toBeInTheDocument();
    // Every action — accept, hand over, return — lives on the booking, not here.
    expect(screen.getByRole("link", { name: /view booking/i })).toHaveAttribute(
      "href",
      `/bookings/${BOOKING}`
    );
  });

  it("hides the composer once the booking is closed, and says why", async () => {
    renderApp(`/messages/${BOOKING}`, {
      [`/bookings/${BOOKING}`]: BOOKING_RESPONSE,
      [`/bookings/${BOOKING}/messages`]: messages([message()], false),
    });

    await screen.findByText("Can I collect at eight?");

    // The safety rule, made visible: a declined booking must not leave a live
    // channel open to a stranger.
    expect(screen.queryByRole("button", { name: /^send$/i })).not.toBeInTheDocument();
    expect(screen.getByText(/no new messages can be sent/i)).toBeInTheDocument();
  });

  it("sends on submit", async () => {
    const calls = renderApp(`/messages/${BOOKING}`, {
      [`/bookings/${BOOKING}`]: BOOKING_RESPONSE,
      [`/bookings/${BOOKING}/messages`]: messages([]),
    });

    await screen.findByRole("button", { name: /^send$/i });
    await userEvent.type(screen.getByLabelText(/write a message/i), "On my way");
    await userEvent.click(screen.getByRole("button", { name: /^send$/i }));

    await waitFor(() =>
      expect(
        calls.some(
          (call) =>
            call.method === "POST" &&
            call.url.includes("/messages") &&
            String(call.body).includes("On my way")
        )
      ).toBe(true)
    );
  });

  it("loads an attachment from this app, never from the storage provider", async () => {
    renderApp(`/messages/${BOOKING}`, {
      [`/bookings/${BOOKING}`]: BOOKING_RESPONSE,
      [`/bookings/${BOOKING}/messages`]: messages([
        message({ kind: "IMAGE", body: null, hasAttachment: true }),
      ]),
    });

    const image = await screen.findByAltText(/attachment/i);
    // A signed provider URL is a bearer credential. The proxy re-checks who is
    // asking on every single fetch.
    expect(image.getAttribute("src")).toBe(
      `/api/bookings/${BOOKING}/messages/${MESSAGE_ID}/file`
    );
    expect(image.getAttribute("src")).not.toMatch(/cloudinary|res\./);
  });

  it("labels a shared phone number as what it is", async () => {
    renderApp(`/messages/${BOOKING}`, {
      [`/bookings/${BOOKING}`]: BOOKING_RESPONSE,
      [`/bookings/${BOOKING}/messages`]: messages([
        message({ kind: "CONTACT_SHARED", body: "+919876543210" }),
      ]),
    });

    expect(await screen.findByText(/shared a phone number/i)).toBeInTheDocument();
    expect(screen.getByText("+919876543210")).toBeInTheDocument();
  });

  it("renders a system line as neither party's", async () => {
    renderApp(`/messages/${BOOKING}`, {
      [`/bookings/${BOOKING}`]: BOOKING_RESPONSE,
      [`/bookings/${BOOKING}/messages`]: messages([
        message({ kind: "SYSTEM", sender_id: null, body: "Booking accepted." }),
      ]),
    });

    expect(await screen.findByText("Booking accepted.")).toBeInTheDocument();
  });
});

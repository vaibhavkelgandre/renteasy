/**
 * The booking screens.
 *
 * The assertions worth having are the ones protecting a rule rather than a layout: the
 * client must never compute a price, the buttons must come from the server rather than
 * from a local guess about what is legal, and an owner cancelling must be warned
 * before pressing rather than after.
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

const USER = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Asha Patil",
  email: "asha@example.test",
  phone: null,
  status: "ACTIVE",
  is_admin: false,
  email_verified_at: "2026-09-01T00:00:00Z",
  pending_email: null,
  created_at: "2026-03-14T00:00:00Z",
};
const SESSION = { body: { success: true, message: "OK", data: { user: USER } } };

const LISTING_ID = "22222222-2222-4222-8222-222222222222";
const BOOKING_ID = "33333333-3333-4333-8333-333333333333";

const LISTING = {
  body: {
    success: true,
    message: "OK",
    data: {
      listing: {
        id: LISTING_ID,
        owner_id: "99999999-9999-4999-8999-999999999999",
        title: "Canon EOS R6",
        description: "Full-frame mirrorless.",
        status: "PUBLISHED",
        condition: "GOOD",
        category_name: "Cameras & photography",
        daily_rate_paise: 80000,
        hourly_rate_paise: null,
        monthly_rate_paise: null,
        deposit_paise: 500000,
        locality: "Kothrud",
        city: "Pune",
        fulfilment: "PICKUP",
        photos: [],
      },
    },
  },
};

const QUOTE = (blockers = []) => ({
  body: {
    success: true,
    message: "OK",
    data: {
      quote: {
        requestedHours: 96,
        coveredHours: 96,
        lines: [{ unit: "day", quantity: 4, unitPricePaise: 80000, subtotalPaise: 320000 }],
        rentPaise: 320000,
        taxPaise: 0,
        depositPaise: 500000,
        depositRefundable: true,
        renterTotalPaise: 820000,
        commissionPaise: 32000,
        ownerPayoutPaise: 288000,
      },
      blockers,
      quotedAt: "2026-09-10T12:00:00.000Z",
    },
  },
});

const booking = (overrides = {}) => ({
  id: BOOKING_ID,
  listing_id: LISTING_ID,
  listing_title: "Canon EOS R6",
  starts_at: "2026-10-01T09:00:00Z",
  ends_at: "2026-10-05T09:00:00Z",
  status: "REQUESTED",
  rent_paise: 320000,
  tax_paise: 0,
  deposit_paise: 500000,
  commission_paise: 32000,
  renter_total_paise: 820000,
  owner_payout_paise: 288000,
  quote_lines: [{ unit: "day", quantity: 4, unitPricePaise: 80000, subtotalPaise: 320000 }],
  renter_message: "Need it for a wedding.",
  coverUrl: null,
  availableActions: ["CANCEL"],
  yourRole: "renter",
  events: [
    {
      id: "e1",
      from_status: null,
      to_status: "REQUESTED",
      comment: "Need it for a wedding.",
      created_at: "2026-09-10T12:00:00Z",
      actor_id: USER.id,
      actor_name: "Asha Patil",
    },
  ],
  ...overrides,
});

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

describe("requesting a booking", () => {
  beforeEach(() => vi.restoreAllMocks());

  const routes = (blockers = []) => ({
    [`/listings/${LISTING_ID}/quote`]: QUOTE(blockers),
    [`/listings/${LISTING_ID}`]: LISTING,
  });

  it("renders the itemised quote from the SERVER, not from local arithmetic", async () => {
    const calls = renderApp(`/listings/${LISTING_ID}/book`, routes());

    // FR-404. The client has no pricing code at all, which is what makes "a
    // client-supplied total is never trusted" structural rather than a rule.
    expect(await screen.findByText(/4 × days/i)).toBeInTheDocument();

    // ₹3,200 appears twice on purpose — once as the line's subtotal and once as the
    // Rent row — which is what "itemised" means: the reader can add the lines up and
    // check the total themselves.
    expect(screen.getAllByText("₹3,200")).toHaveLength(2);
    expect(screen.getByText("₹5,000")).toBeInTheDocument(); // the deposit, kept separate
    expect(screen.getByText("₹8,200")).toBeInTheDocument(); // what they actually pay

    expect(calls.some((c) => c.url.includes(`/listings/${LISTING_ID}/quote`))).toBe(true);
  });

  it("re-quotes when the dates change", async () => {
    const calls = renderApp(`/listings/${LISTING_ID}/book`, routes());
    await screen.findByText(/4 × days/i);
    const before = calls.filter((c) => c.url.includes("/quote")).length;

    const user = userEvent.setup();
    await user.clear(screen.getByLabelText(/^until$/i));
    await user.type(screen.getByLabelText(/^until$/i), "2026-12-25T10:00");

    // The server is the only thing that knows what a rental costs, so every date
    // change is a round trip rather than a local recalculation.
    await waitFor(() =>
      expect(calls.filter((c) => c.url.includes("/quote")).length).toBeGreaterThan(before)
    );
  });

  it("shows the deposit separately and marks it refundable", async () => {
    renderApp(`/listings/${LISTING_ID}/book`, routes());

    // FR-402: a renter comparing listings needs to know which part comes back.
    expect(await screen.findByText(/deposit/i)).toBeInTheDocument();
    expect(screen.getByText(/refundable/i)).toBeInTheDocument();
  });

  it("blocks submission and explains why when the dates break a listing rule", async () => {
    renderApp(`/listings/${LISTING_ID}/book`, routes(["This listing has a minimum rental of 2 days"]));

    expect(await screen.findByText(/minimum rental of 2 days/i)).toBeInTheDocument();
    // Reported rather than enforced here — the server owns the rule; this saves a
    // round trip and says what to change.
    expect(screen.getByRole("button", { name: /send request/i })).toBeDisabled();
  });

  it("sends ISO instants, and omits an empty message", async () => {
    const calls = renderApp(`/listings/${LISTING_ID}/book`, {
      ...routes(),
      "/bookings": {
        status: 201,
        body: { success: true, message: "Booking requested", data: { booking: booking() } },
      },
    });

    await screen.findByText(/4 × days/i);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /send request/i }));

    await waitFor(() => {
      const post = calls.find((c) => c.method === "POST" && c.url.includes("/api/bookings"));
      const body = JSON.parse(post.body);
      expect(body.listingId).toBe(LISTING_ID);
      expect(body.startsAt).toMatch(/T.*Z$/);
      // An empty string would fail the schema's minimum length; absent means absent.
      expect("message" in body).toBe(false);
    });
  });
});

describe("the bookings list", () => {
  beforeEach(() => vi.restoreAllMocks());

  const list = (bookings, side = "renter") => ({
    "/bookings": { body: { success: true, message: "OK", data: { bookings, side } } },
  });

  it("shows your rentals by default", async () => {
    renderApp("/bookings", list([booking()]));

    expect(await screen.findByText("Canon EOS R6")).toBeInTheDocument();
    expect(screen.getByText("Awaiting reply")).toBeInTheDocument();
  });

  it("keeps the side in the URL so a tab is linkable", async () => {
    const calls = renderApp("/bookings?side=owner", list([], "owner"));

    await screen.findByRole("tab", { name: /lending/i });
    expect(calls.some((c) => c.url.includes("side=owner"))).toBe(true);
    expect(screen.getByRole("tab", { name: /lending/i })).toHaveAttribute("aria-selected", "true");
  });

  it("switches side without leaving the page", async () => {
    const calls = renderApp("/bookings", list([booking()]));
    await screen.findByText("Canon EOS R6");

    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: /lending/i }));

    await waitFor(() => expect(calls.some((c) => c.url.includes("side=owner"))).toBe(true));
  });

  it("gives each side its own empty state", async () => {
    renderApp("/bookings", list([]));
    // Two different situations needing two different next steps: find something to
    // rent, versus wait for somebody to ask.
    expect(await screen.findByText(/have not requested anything/i)).toBeInTheDocument();
  });
});

describe("one booking", () => {
  beforeEach(() => vi.restoreAllMocks());

  const detail = (overrides = {}) => ({
    [`/bookings/${BOOKING_ID}`]: {
      body: { success: true, message: "OK", data: { booking: booking(overrides) } },
    },
  });

  it("renders only the actions the SERVER says are available", async () => {
    renderApp(`/bookings/${BOOKING_ID}`, detail({ availableActions: ["ACCEPT", "DECLINE"], yourRole: "owner" }));

    // Derived from the state machine server-side, so the UI cannot offer a control the
    // server refuses or hide one it would allow.
    expect(await screen.findByRole("button", { name: /^accept$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^decline$/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /cancel/i })).not.toBeInTheDocument();
  });

  it("says why there is nothing to do rather than showing an empty box", async () => {
    renderApp(`/bookings/${BOOKING_ID}`, detail({ status: "COMPLETED", availableActions: [] }));
    expect(await screen.findByText(/nothing to do here/i)).toBeInTheDocument();
  });

  it("WARNS an owner before they cancel a booking they accepted — FR-510", async () => {
    renderApp(
      `/bookings/${BOOKING_ID}`,
      detail({ status: "ACCEPTED", availableActions: ["CANCEL_AS_OWNER"], yourRole: "owner" })
    );

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /cancel this booking/i }));

    // Before pressing, not after. An owner who did not know this has been penalised
    // without being told.
    expect(await screen.findByText(/counts against your reliability/i)).toBeInTheDocument();
  });

  it("shows the renter what they pay and the owner what they receive", async () => {
    renderApp(`/bookings/${BOOKING_ID}`, detail());
    expect(await screen.findByRole("heading", { name: /what you pay/i })).toBeInTheDocument();
    // The renter's total never included commission, so it is not shown to them.
    expect(screen.queryByText(/platform fee/i)).not.toBeInTheDocument();
  });

  it("shows the owner the platform fee coming out of their payout — FR-403", async () => {
    renderApp(`/bookings/${BOOKING_ID}`, detail({ yourRole: "owner", availableActions: [] }));

    expect(await screen.findByRole("heading", { name: /what you receive/i })).toBeInTheDocument();
    expect(screen.getByText(/platform fee/i)).toBeInTheDocument();
    expect(screen.getByText("₹2,880")).toBeInTheDocument();
  });

  it("renders the append-only trail, and says that it is", async () => {
    renderApp(`/bookings/${BOOKING_ID}`, detail());

    expect(await screen.findByRole("heading", { name: /history/i })).toBeInTheDocument();
    expect(screen.getByText(/by Asha Patil/i)).toBeInTheDocument();
    expect(screen.getByText(/append-only/i)).toBeInTheDocument();
  });

  it("says an expiry happened automatically rather than inventing an actor", async () => {
    renderApp(
      `/bookings/${BOOKING_ID}`,
      detail({
        status: "EXPIRED",
        availableActions: [],
        events: [
          {
            id: "e2",
            from_status: "REQUESTED",
            to_status: "EXPIRED",
            comment: null,
            created_at: "2026-09-12T12:00:00Z",
            actor_id: null,
            actor_name: null,
          },
        ],
      })
    );

    expect(await screen.findByText(/automatically/i)).toBeInTheDocument();
  });

  it("explains a 404 without guessing which cause it was", async () => {
    renderApp(`/bookings/${BOOKING_ID}`, {
      [`/bookings/${BOOKING_ID}`]: {
        status: 404,
        body: { success: false, message: "Booking not found", errors: {} },
      },
    });

    // Unknown id, malformed id, and somebody else's booking all answer identically.
    expect(await screen.findByRole("heading", { name: /booking not found/i })).toBeInTheDocument();
    expect(screen.getByText(/belong to somebody else/i)).toBeInTheDocument();
  });
});

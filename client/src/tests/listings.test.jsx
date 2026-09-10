/**
 * The listing screens, and the money conversion underneath them.
 *
 * The assertions worth having here are the ones that protect a rule rather than a
 * layout: rupees typed on screen must reach the API as whole paise, the publish
 * checklist must show every outstanding item at once, and the detail page must render
 * for someone with no account.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "../context/AuthContext.jsx";
import { App } from "../App.jsx";
import { formatPaise, parseRupeesToPaise, paiseToRupeeInput } from "../lib/money.js";

const NO_SESSION = {
  status: 401,
  body: { success: false, message: "Authentication required", errors: {} },
};
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

const CATEGORIES = {
  body: {
    success: true,
    message: "OK",
    data: { categories: [{ id: "c1", slug: "cameras", name: "Cameras & photography" }] },
  },
};

const LISTING_ID = "22222222-2222-4222-8222-222222222222";

const LISTING = {
  id: LISTING_ID,
  owner_id: USER.id,
  title: "Canon EOS R6",
  description: "Full-frame mirrorless with two batteries.",
  condition: "GOOD",
  status: "DRAFT",
  category_slug: "cameras",
  category_name: "Cameras & photography",
  hourly_rate_paise: null,
  daily_rate_paise: 150000,
  monthly_rate_paise: null,
  deposit_paise: 500000,
  locality: "Kothrud",
  city: "Pune",
  min_duration_hours: null,
  max_duration_hours: null,
  fulfilment: "PICKUP",
  published_at: null,
  photos: [],
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

describe("money — rupees on screen, paise on the wire", () => {
  it("drops the decimals only when there are none", () => {
    // "₹1,500" reads as a price; "₹1,500.00" reads as an invoice.
    expect(formatPaise(150000)).toBe("₹1,500");
    expect(formatPaise(150050)).toBe("₹1,500.50");
    expect(formatPaise(null)).toBe("");
  });

  it("rounds rather than truncating when parsing", () => {
    // 19.99 * 100 is 1998.9999… in binary floating point. Truncating would silently
    // charge a paisa less on a significant share of ordinary prices.
    expect(parseRupeesToPaise("19.99")).toBe(1999);
    expect(parseRupeesToPaise("1,500")).toBe(150000);
    expect(parseRupeesToPaise("")).toBeNull();
    expect(parseRupeesToPaise("abc")).toBeNull();
    expect(parseRupeesToPaise("-5")).toBeNull();
  });

  it("round-trips through an input without a symbol or separators", () => {
    // An <input> containing "₹1,500" would fail to parse its own value on resubmit.
    expect(paiseToRupeeInput(150000)).toBe("1500");
    expect(parseRupeesToPaise(paiseToRupeeInput(150050))).toBe(150050);
  });
});

describe("MyListingsPage — FR-115", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("shows drafts, which are invisible everywhere else", async () => {
    renderApp("/listings/mine", {
      "/auth/me": SESSION,
      "/listings/mine": {
        body: {
          success: true,
          message: "OK",
          data: { listings: [{ ...LISTING, coverUrl: null, photo_count: 0 }] },
        },
      },
    });

    expect(await screen.findByText("Canon EOS R6")).toBeInTheDocument();
    // If this page hid drafts too they would be unreachable: written once, then lost.
    expect(screen.getByText("Draft")).toBeInTheDocument();
    expect(screen.getByText(/₹1,500\/day/)).toBeInTheDocument();
  });

  it("flags a listing with no price rather than showing a blank", async () => {
    renderApp("/listings/mine", {
      "/auth/me": SESSION,
      "/listings/mine": {
        body: {
          success: true,
          message: "OK",
          data: { listings: [{ ...LISTING, daily_rate_paise: null, coverUrl: null }] },
        },
      },
    });

    expect(await screen.findByText(/no price set/i)).toBeInTheDocument();
  });

  it("bounces a signed-out visitor", async () => {
    renderApp("/listings/mine");
    expect(await screen.findByRole("heading", { name: /welcome back/i })).toBeInTheDocument();
  });
});

describe("ListingFormPage — the publish checklist", () => {
  beforeEach(() => vi.restoreAllMocks());

  const routes = (readiness, listing = LISTING) => ({
    "/auth/me": SESSION,
    "/listings/categories": CATEGORIES,
    [`/listings/${LISTING_ID}/readiness`]: {
      body: { success: true, message: "OK", data: readiness },
    },
    [`/listings/${LISTING_ID}`]: {
      body: { success: true, message: "OK", data: { listing } },
    },
  });

  it("lists EVERY outstanding item at once, not one at a time", async () => {
    renderApp(
      `/listings/${LISTING_ID}/edit`,
      routes({ canPublish: false, blockers: ["Add at least one photo", "Say roughly where the item is"] })
    );

    // Showing them one at a time turns publishing into a guessing game where each fix
    // reveals the next obstacle.
    expect(await screen.findByText(/add at least one photo/i)).toBeInTheDocument();
    expect(screen.getByText(/say roughly where the item is/i)).toBeInTheDocument();
  });

  it("disables Publish only once the server has said it would fail", async () => {
    renderApp(`/listings/${LISTING_ID}/edit`, routes({ canPublish: false, blockers: ["Add at least one photo"] }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^publish$/i })).toBeDisabled()
    );
  });

  it("enables Publish when the checklist is clear", async () => {
    renderApp(`/listings/${LISTING_ID}/edit`, routes({ canPublish: true, blockers: [] }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^publish$/i })).toBeEnabled()
    );
  });

  it("offers Hide, not Publish, for a live listing", async () => {
    renderApp(
      `/listings/${LISTING_ID}/edit`,
      routes({ canPublish: true, blockers: [] }, { ...LISTING, status: "PUBLISHED" })
    );

    expect(await screen.findByRole("button", { name: /hide it/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^publish$/i })).not.toBeInTheDocument();
  });
});

describe("ListingFormPage — money crosses the boundary once", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("sends whole paise, and null for a blank rate", async () => {
    const calls = renderApp(`/listings/${LISTING_ID}/edit`, {
      "/auth/me": SESSION,
      "/listings/categories": CATEGORIES,
      [`/listings/${LISTING_ID}/readiness`]: {
        body: { success: true, message: "OK", data: { canPublish: true, blockers: [] } },
      },
      [`/listings/${LISTING_ID}`]: {
        body: { success: true, message: "OK", data: { listing: LISTING } },
      },
    });

    const user = userEvent.setup();
    const hourly = await screen.findByLabelText(/per hour/i);
    await user.type(hourly, "99.50");
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => {
      const patch = calls.find((c) => c.method === "PATCH");
      const body = JSON.parse(patch.body);
      // Integers all the way down. A float in a money path is a bug.
      expect(body.hourlyRatePaise).toBe(9950);
      expect(Number.isInteger(body.hourlyRatePaise)).toBe(true);
      // A blank rate is null — a real state meaning "I do not rent by the month".
      expect(body.monthlyRatePaise).toBeNull();
    });
  });

  it("says at least one price is enough, so three boxes do not read as three requirements", async () => {
    renderApp(`/listings/${LISTING_ID}/edit`, {
      "/auth/me": SESSION,
      "/listings/categories": CATEGORIES,
      [`/listings/${LISTING_ID}/readiness`]: {
        body: { success: true, message: "OK", data: { canPublish: true, blockers: [] } },
      },
      [`/listings/${LISTING_ID}`]: {
        body: { success: true, message: "OK", data: { listing: LISTING } },
      },
    });

    expect(await screen.findByText(/fill in at least one/i)).toBeInTheDocument();
  });

  it("warns against putting a street address in the location fields — FR-113", async () => {
    renderApp(`/listings/${LISTING_ID}/edit`, {
      "/auth/me": SESSION,
      "/listings/categories": CATEGORIES,
      [`/listings/${LISTING_ID}/readiness`]: {
        body: { success: true, message: "OK", data: { canPublish: true, blockers: [] } },
      },
      [`/listings/${LISTING_ID}`]: {
        body: { success: true, message: "OK", data: { listing: LISTING } },
      },
    });

    // The absence of a street-address field is a safety decision. An owner who does not
    // know that will type their address into "Area" instead.
    expect(await screen.findByText(/never your street address/i)).toBeInTheDocument();
  });
});

describe("ListingDetailPage", () => {
  beforeEach(() => vi.restoreAllMocks());

  const published = {
    ...LISTING,
    status: "PUBLISHED",
    photos: [
      { id: "p1", sortOrder: 0, width: 1200, height: 900, thumbUrl: "/t1.jpg", url: "/d1.jpg" },
      { id: "p2", sortOrder: 1, width: 1200, height: 900, thumbUrl: "/t2.jpg", url: "/d2.jpg" },
    ],
  };

  it("renders for a visitor with NO account", async () => {
    renderApp(`/listings/${LISTING_ID}`, {
      [`/listings/${LISTING_ID}`]: {
        body: { success: true, message: "OK", data: { listing: published } },
      },
    });

    // Browsing needs no account — this page must never assume a user.
    expect(await screen.findByRole("heading", { name: /canon eos r6/i })).toBeInTheDocument();
    expect(screen.getByText("₹1,500")).toBeInTheDocument();
    expect(screen.getByText(/kothrud, pune/i)).toBeInTheDocument();
  });

  it("reserves the image's real dimensions, so the page does not jump", async () => {
    renderApp(`/listings/${LISTING_ID}`, {
      [`/listings/${LISTING_ID}`]: {
        body: { success: true, message: "OK", data: { listing: published } },
      },
    });

    // Which is why width and height are stored alongside the storage id at all.
    const image = await screen.findByAltText(/canon eos r6/i);
    expect(image).toHaveAttribute("width", "1200");
    expect(image).toHaveAttribute("height", "900");
  });

  it("offers a real booking action, and is still honest about negotiation", async () => {
    renderApp(`/listings/${LISTING_ID}`, {
      [`/listings/${LISTING_ID}`]: {
        body: { success: true, message: "OK", data: { listing: published } },
      },
    });

    // This test used to assert booking "was not built yet". Step 6 built it, and the
    // assertion kept passing only because the replacement copy happens to mention that
    // NEGOTIATION is unbuilt — a test passing for the wrong reason, which is worse than
    // one failing.
    const book = await screen.findByRole("link", { name: /request to book/i });
    expect(book).toHaveAttribute("href", `/listings/${LISTING_ID}/book`);

    // Still honest about what genuinely does not exist: negotiation is step 7.
    expect(screen.getByText(/negotiation is not built yet/i)).toBeInTheDocument();
  });

  it("explains a 404 without guessing which cause it was", async () => {
    renderApp(`/listings/${LISTING_ID}`, {
      [`/listings/${LISTING_ID}`]: {
        status: 404,
        body: { success: false, message: "Listing not found", errors: {} },
      },
    });

    // An unknown id, a malformed one, a draft and an unpublished listing all answer
    // identically, so the copy must not guess between them.
    expect(await screen.findByRole("heading", { name: /listing not found/i })).toBeInTheDocument();
    expect(screen.getByText(/taken down, or the link may be wrong/i)).toBeInTheDocument();
  });
});

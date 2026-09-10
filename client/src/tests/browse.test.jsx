/**
 * The browse page.
 *
 * The assertions that matter are the ones protecting behaviour that is easy to break
 * and invisible when broken: filters living in the URL rather than in state, the
 * offset resetting when a filter narrows, and rupees reaching the API as paise.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "../context/AuthContext.jsx";
import { App } from "../App.jsx";

const NO_SESSION = {
  status: 401,
  body: { success: false, message: "Authentication required", errors: {} },
};
const TERMS = {
  body: { success: true, message: "OK", data: { version: "2026-09-01", url: "/terms" } },
};
const CATEGORIES = {
  body: {
    success: true,
    message: "OK",
    data: { categories: [{ id: "c1", slug: "cameras", name: "Cameras & photography" }] },
  },
};
const CITIES = {
  body: { success: true, message: "OK", data: { cities: ["Pune", "Mumbai"] } },
};

/** Builds a browse response of `count` tiles, reporting `total` as the whole set. */
function browseResponse(count, total = count) {
  return {
    body: {
      success: true,
      message: "OK",
      data: {
        listings: Array.from({ length: count }, (_, i) => ({
          id: `1111111${i}-1111-4111-8111-11111111111${i}`,
          title: `Camera ${i}`,
          category_name: "Cameras & photography",
          locality: "Kothrud",
          city: "Pune",
          hourly_rate_paise: null,
          daily_rate_paise: 150000,
          monthly_rate_paise: null,
          coverUrl: `/thumb-${i}.jpg`,
        })),
        total,
        limit: 24,
        offset: 0,
      },
    },
  };
}

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

function renderBrowse(path = "/", routes = {}) {
  const calls = stubFetch({
    "/auth/me": NO_SESSION,
    "/auth/terms/current": TERMS,
    "/listings/categories": CATEGORIES,
    "/listings/cities": CITIES,
    "/listings?": browseResponse(2),
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

/** The most recent call to the browse endpoint, as a URLSearchParams. */
function lastBrowseQuery(calls) {
  const call = [...calls].reverse().find((c) => c.url.includes("/api/listings?"));
  return new URLSearchParams(call.url.split("?")[1]);
}

describe("browsing without an account", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("renders listings for a signed-out visitor", async () => {
    renderBrowse();

    // FR-300. `/auth/me` answers 401 here, which is the ordinary state for most
    // visitors to a marketplace.
    expect(await screen.findByText("Camera 0")).toBeInTheDocument();
    expect(screen.getByText("Camera 1")).toBeInTheDocument();
  });

  it("shows the price per the unit being browsed", async () => {
    renderBrowse();

    // findAll, not find: every tile in this fixture carries the same daily rate, and
    // `findByText` requires exactly one match.
    const prices = await screen.findAllByText("₹1,500", { exact: false });
    expect(prices).toHaveLength(2);
    // The unit is spelled out beside the amount, so ₹1,500 is not ambiguous between
    // an hour and a month.
    expect(prices[0].textContent).toContain("/day");
  });

  it("reports the total, not the page size", async () => {
    renderBrowse("/", { "/listings?": browseResponse(2, 57) });
    expect(await screen.findByText(/57 listings/)).toBeInTheDocument();
  });
});

describe("filters live in the URL", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("reads its filters from the query string on first render", async () => {
    const calls = renderBrowse("/?category=cameras&city=Pune&sort=price_asc");

    // A shared or refreshed URL must reproduce the same view. State initialised from
    // props and then diverging is exactly what putting it in the URL avoids.
    await screen.findByText("Camera 0");
    const query = lastBrowseQuery(calls);
    expect(query.get("category")).toBe("cameras");
    expect(query.get("city")).toBe("Pune");
    expect(query.get("sort")).toBe("price_asc");
  });

  it("writes a filter change back into the URL and refetches", async () => {
    const calls = renderBrowse();
    await screen.findByText("Camera 0");

    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText(/^city$/i), "Mumbai");

    await waitFor(() => expect(lastBrowseQuery(calls).get("city")).toBe("Mumbai"));
  });

  it("does NOT fire a request per keystroke in the search box", async () => {
    const calls = renderBrowse();
    await screen.findByText("Camera 0");
    const before = calls.filter((c) => c.url.includes("/api/listings?")).length;

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/search listings/i), "camera");

    // Typing is local state; only submitting commits it. Otherwise six characters is
    // six requests and six history entries.
    expect(calls.filter((c) => c.url.includes("/api/listings?")).length).toBe(before);
  });

  it("searches on submit", async () => {
    const calls = renderBrowse();
    await screen.findByText("Camera 0");

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/search listings/i), "pulsar");
    await user.click(screen.getByRole("button", { name: /^search$/i }));

    await waitFor(() => expect(lastBrowseQuery(calls).get("q")).toBe("pulsar"));
  });

  it("converts a typed rupee maximum into whole paise", async () => {
    const calls = renderBrowse();
    await screen.findByText("Camera 0");

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/maximum price/i), "1500");
    await user.tab();

    // Rupees on screen, paise on the wire — the boundary is crossed once.
    await waitFor(() => expect(lastBrowseQuery(calls).get("maxPricePaise")).toBe("150000"));
  });
});

  it("sends a date range only once BOTH halves are given — FR-303", async () => {
    const calls = renderBrowse("/");
    await screen.findByText("Camera 0");

    const user = userEvent.setup();

    // One date alone must change nothing. The server refuses a half-open range with a
    // 400, so sending it would turn a half-filled form into an error message where
    // the reader is still looking at unfiltered results.
    await user.type(screen.getByLabelText(/free from/i), "2026-10-03");
    await waitFor(() => expect(lastBrowseQuery(calls).get("availableFrom")).toBeNull());

    await user.type(screen.getByLabelText(/^until$/i), "2026-10-06");

    await waitFor(() => {
      const query = lastBrowseQuery(calls);
      // Instants on the wire, dates in the URL. Local midnight, not `Z` — parsing
      // "2026-10-03" as UTC would shift the whole window by the reader's offset.
      expect(query.get("availableFrom")).toBe(new Date(2026, 9, 3).toISOString());
      expect(query.get("availableTo")).toBe(new Date(2026, 9, 6).toISOString());
    });
  });

  it("never lets the end of the range precede its start", async () => {
    renderBrowse("/?from=2026-10-03");
    await screen.findByText("Camera 0");

    // Enforced by the input itself as well as by the server: a reader should not be
    // able to construct a range that can only be refused.
    expect(screen.getByLabelText(/^until$/i)).toHaveAttribute("min", "2026-10-03");
  });

describe("pagination", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("hides the pager when everything fits on one page", async () => {
    renderBrowse("/", { "/listings?": browseResponse(2, 2) });

    await screen.findByText("Camera 0");
    // A lone disabled prev/next pair is noise on a result that already fits.
    expect(screen.queryByRole("navigation", { name: /pagination/i })).not.toBeInTheDocument();
  });

  it("shows the pager, and the range, once there is more than a page", async () => {
    renderBrowse("/", { "/listings?": browseResponse(2, 57) });

    expect(await screen.findByRole("navigation", { name: /pagination/i })).toBeInTheDocument();
    expect(screen.getByText("1–24 of 57")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /previous/i })).toBeDisabled();
  });

  it("advances the offset by a page", async () => {
    const calls = renderBrowse("/", { "/listings?": browseResponse(2, 57) });
    await screen.findByRole("navigation", { name: /pagination/i });

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /next/i }));

    await waitFor(() => expect(lastBrowseQuery(calls).get("offset")).toBe("24"));
  });

  it("disables Next on the last page", async () => {
    renderBrowse("/?offset=48", { "/listings?": browseResponse(2, 57) });

    await screen.findByRole("navigation", { name: /pagination/i });
    expect(screen.getByRole("button", { name: /next/i })).toBeDisabled();
  });

  it("RESETS the offset when a filter changes", async () => {
    const calls = renderBrowse("/?offset=48", { "/listings?": browseResponse(2, 57) });
    await screen.findByText("Camera 0");
    expect(lastBrowseQuery(calls).get("offset")).toBe("48");

    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText(/^category$/i), "cameras");

    // The bug this prevents: a narrower filter matches fewer rows than the current
    // offset, so the page renders empty and reads as "no matches" when the real cause
    // is being on page three of a one-page result.
    await waitFor(() => {
      const query = lastBrowseQuery(calls);
      expect(query.get("category")).toBe("cameras");
      expect(query.get("offset")).toBeNull();
    });
  });
});

describe("empty and error states", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("distinguishes an empty catalogue from an over-narrow filter", async () => {
    renderBrowse("/", { "/listings?": browseResponse(0, 0) });

    // Two different problems needing two different actions: one is "be the first to
    // list something", the other is "widen your search".
    expect(await screen.findByRole("heading", { name: /nothing listed yet/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /list something/i })).toBeInTheDocument();
  });

  it("offers to widen a search that matched nothing", async () => {
    renderBrowse("/?q=xyzzy", { "/listings?": browseResponse(0, 0) });

    expect(await screen.findByRole("heading", { name: /nothing matches that/i })).toBeInTheDocument();
    expect(screen.getByText(/try a wider search/i)).toBeInTheDocument();
  });

  it("clears every filter at once", async () => {
    const calls = renderBrowse("/?q=camera&city=Pune&category=cameras");
    await screen.findByText("Camera 0");

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /clear filters/i }));

    await waitFor(() => {
      const query = lastBrowseQuery(calls);
      expect(query.get("q")).toBeNull();
      expect(query.get("city")).toBeNull();
      expect(query.get("category")).toBeNull();
    });
  });

  it("still renders results when the filter options fail to load", async () => {
    renderBrowse("/", {
      "/listings/cities": { status: 500, body: { success: false, message: "boom", errors: {} } },
    });

    // A dropdown failing to populate must not take the page down with it.
    expect(await screen.findByText("Camera 0")).toBeInTheDocument();
  });
});

/**
 * Client test setup. Runs before every test file (vite.config.js).
 */

import { afterEach, expect, vi } from "vitest";
import { cleanup, configure } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { resetRealtime } from "./socketMock.js";

// The socket, replaced everywhere. The notification bell is in the layout, so every
// test that renders the app reaches `lib/socket.js` — and left real, each one opens a
// connection from jsdom that fails and then retries for the rest of the run.
//
// Mocked HERE rather than per file for that reason: it is not a messaging concern any
// more. `src/tests/socketMock.js` explains what it does and how a test opts into the
// connected path.
vi.mock("../lib/socket.js", async () => await import("./socketMock.js"));

// Adds toBeInTheDocument, toBeDisabled, toHaveAttribute and friends.
expect.extend(matchers);

// Unmounts anything rendered, so one test's DOM cannot be found by the next. Without
// it, a `getByRole` can match a leftover element from a previous test and pass for
// entirely the wrong reason - which is the worst kind of green.
afterEach(() => {
  cleanup();
  // Reset fetch stubs between tests for the same reason.
  vi.restoreAllMocks();
  // And the socket's own state, which `restoreAllMocks` cannot reach — it is an
  // ordinary module, not a spy. A listener or a `connected` left set would make the
  // next test pass or fail for a reason belonging to this one.
  resetRealtime();
});

configure({
  // Testing Library keeps its OWN budget for findBy*/waitFor, defaulting to 1000ms -
  // and `testTimeout` in the vite config does nothing for it. A findByRole waiting on
  // a mocked fetch therefore fails at one second no matter what vitest allows, which
  // is a load-sensitive flake with nothing wrong with the component or the test.
  //
  // Deliberately well below the 15s testTimeout: an element that genuinely never
  // appears then still fails with Testing Library's "unable to find role=..." plus a
  // DOM dump, rather than a bare vitest timeout that explains nothing.
  asyncUtilTimeout: 5000,
});

// jsdom implements no layout, so this does not exist. Anything that scrolls a
// selected row into view throws "scrollIntoView is not a function" the moment a test
// exercises it. Stubbed once, globally, rather than mocked per test.
Element.prototype.scrollIntoView ??= () => {};

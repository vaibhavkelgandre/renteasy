/**
 * Client test setup. Runs before every test file (vite.config.js).
 */

import { afterEach, expect, vi } from "vitest";
import { cleanup, configure } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";

// Adds toBeInTheDocument, toBeDisabled, toHaveAttribute and friends.
expect.extend(matchers);

// Unmounts anything rendered, so one test's DOM cannot be found by the next. Without
// it, a `getByRole` can match a leftover element from a previous test and pass for
// entirely the wrong reason - which is the worst kind of green.
afterEach(() => {
  cleanup();
  // Reset fetch stubs between tests for the same reason.
  vi.restoreAllMocks();
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

/**
 * Vitest configuration.
 *
 * Two settings, both with a reason.
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Node, not jsdom. These are API tests against Express — there is no DOM, and
    // booting jsdom for every file would cost seconds per file for nothing. The
    // client suite (step 12) gets its own config with jsdom.
    environment: "node",

    // Runs before every test FILE. Loads .env.test, asserts we are pointed at a
    // _test database, and truncates between tests.
    setupFiles: ["./tests/setup.js"],

    // Vitest defaults to 5s per test and 10s per hook. These are integration tests
    // against a real Postgres: a bcrypt hash, a few round trips and a TRUNCATE add
    // up, and under load the defaults expire on work that is progressing perfectly
    // well — which reads as a real failure and sends you hunting a bug that does not
    // exist.
    //
    // The cost is accepted, not overlooked: a genuinely hung test now takes 20s to
    // report instead of 5s. If a test starts NEEDING this headroom, that is a signal
    // about the test, not a reason to raise the ceiling again.
    testTimeout: 20_000,
    hookTimeout: 20_000,

    // One process. These tests share one database and truncate between each test, so
    // running files in parallel would have them deleting each other's fixtures
    // mid-run — producing failures that vanish when you re-run a single file, which
    // is the worst kind of flake to debug.
    //
    // The real fix at scale is one database per worker. That is worth doing when the
    // suite is slow; it is not worth doing when it has six tests.
    fileParallelism: false,
  },
});

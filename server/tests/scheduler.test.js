/**
 * The scheduler — the wiring behind FR-508, and from step 7 FR-603.
 *
 * Unit tests with fake timers, no database. What is worth pinning here is not that a
 * sweep expires a booking — `bookings.test.js` already covers that against real rows
 * — but the four properties of the TIMER, every one of which fails silently:
 *
 *   a sweep that throws must not stop the schedule
 *   a slow pass must not have a second one start on top of it
 *   stopping must actually stop
 *   the first pass must happen at boot, not an hour later
 *
 * None of these would produce a visible error. They would produce bookings that
 * quietly never expire, which is the failure this whole file exists to prevent.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mocked because this file is about the timer, not about what it drives — and
// because importing the real one would pull in a database connection for a test
// that has no business needing one.
const sweepExpiredRequests = vi.fn();
const sweepStalledConfirmations = vi.fn();

vi.mock("../src/services/bookingService.js", () => ({
  sweepExpiredRequests: (...args) => sweepExpiredRequests(...args),
  sweepStalledConfirmations: (...args) => sweepStalledConfirmations(...args),
  REQUEST_EXPIRY_HOURS: 48,
}));

const { startScheduler, runSweeps, SWEEP_INTERVAL_MS } = await import("../src/scheduler.js");

/** Lets every already-resolved promise settle without advancing the clock. */
const flush = () => vi.advanceTimersByTimeAsync(0);

describe("the sweep schedule", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sweepExpiredRequests.mockReset().mockResolvedValue({ expired: 0, failed: 0 });
    sweepStalledConfirmations.mockReset().mockResolvedValue({ expired: 0, failed: 0 });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("runs once at boot, not an hour later", async () => {
    // A process that has been down — a deploy, a crash, a free tier waking up —
    // comes back with work already overdue. Waiting a full interval to notice would
    // make every restart a fresh hour of staleness.
    const stop = startScheduler();
    await flush();

    expect(sweepExpiredRequests).toHaveBeenCalledTimes(1);
    stop();
  });

  it("SWALLOWS a sweep that throws — runSweeps must never reject", async () => {
    // Asserted directly on `runSweeps`, and the first version of this test did not.
    // It started the scheduler, made one pass reject, and checked the next pass
    // still fired — which passes even with the catch removed, because setInterval
    // does not care whether its callback rejected. It was true and it was vacuous.
    //
    // What actually breaks without the catch is the PROCESS: the rejection escapes
    // `void tick()` as an unhandled rejection, which Node terminates on by default.
    // So the property worth pinning is the contract itself.
    sweepExpiredRequests.mockRejectedValueOnce(new Error("database went away"));

    await expect(runSweeps()).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("expired-requests"),
      "database went away"
    );
  });

  it("keeps to the schedule after a bad pass", async () => {
    sweepExpiredRequests.mockRejectedValueOnce(new Error("database went away"));

    const stop = startScheduler();
    await flush();
    expect(sweepExpiredRequests).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS);
    expect(sweepExpiredRequests).toHaveBeenCalledTimes(2);

    stop();
  });

  it("never starts a pass while the previous one is still running", async () => {
    // setInterval does not wait for an async callback. Without the guard, a pass
    // slower than the interval gets a second one on top of it, both trying to expire
    // the same rows — the state machine refuses the loser, so nothing is corrupted,
    // but real work gets reported as `failed`.
    let release;
    sweepExpiredRequests.mockImplementationOnce(
      () => new Promise((resolve) => {
        release = () => resolve({ expired: 0, failed: 0 });
      })
    );

    const stop = startScheduler();
    await flush();
    expect(sweepExpiredRequests).toHaveBeenCalledTimes(1);

    // Two intervals pass while the first is still in flight. Neither may start one.
    await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS * 2);
    expect(sweepExpiredRequests).toHaveBeenCalledTimes(1);

    release();
    await flush();

    // And the schedule recovers rather than being wedged by the skip.
    await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS);
    expect(sweepExpiredRequests).toHaveBeenCalledTimes(2);

    stop();
  });

  it("stops, and stays stopped", async () => {
    const stop = startScheduler();
    await flush();
    stop();

    await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS * 3);
    expect(sweepExpiredRequests).toHaveBeenCalledTimes(1);

    // Idempotent: shutdown may run twice if two signals arrive.
    expect(() => stop()).not.toThrow();
  });

  it("runs EVERY sweep in the list, not just the first", async () => {
    // The failure this guards against is adding a sweep to SWEEPS and having it
    // silently never run — which looks exactly like the feature not working, three
    // layers away from the scheduler.
    await runSweeps();

    expect(sweepExpiredRequests).toHaveBeenCalledTimes(1);
    expect(sweepStalledConfirmations).toHaveBeenCalledTimes(1);
  });

  it("runs the rest of the list after one of them throws", async () => {
    // Sequential and in a try/catch each, so a broken sweep costs its own results
    // and nobody else's.
    sweepExpiredRequests.mockRejectedValueOnce(new Error("database went away"));

    await expect(runSweeps()).resolves.toBeUndefined();
    expect(sweepStalledConfirmations).toHaveBeenCalledTimes(1);
  });

  it("logs a pass that did something, and stays quiet about one that did not", async () => {
    // An hourly line saying "expired 0" is 24 lines a day that train you to stop
    // reading the log — at which point the line that matters goes unread too.
    await runSweeps();
    expect(console.log).not.toHaveBeenCalled();

    sweepExpiredRequests.mockResolvedValueOnce({ expired: 3, failed: 1 });
    await runSweeps();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("expired=3 failed=1"));
  });
});

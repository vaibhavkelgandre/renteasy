/**
 * The only scheduler in this application.
 *
 * Some rules in this product are about the PASSAGE OF TIME rather than about anything
 * a person does — a booking request nobody answers must expire (FR-508), and from
 * step 7 an offer nobody answers must too. There is no request handler to hang those
 * off, because the whole point is that nobody made a request.
 *
 * WHY THIS IS STARTED FROM `server.js` AND NEVER FROM `app.js`, which is the decision
 * that matters most here. `app.js` is what the integration tests import — they build
 * an Express app in-process and never bind a port. A timer started there would run
 * during every test file, in parallel with the tests, mutating fixtures other tests
 * are asserting against. The failures would be intermittent and would look like
 * concurrency bugs in the booking code rather than like a stray timer. `server.js`
 * owns being a running process, so this belongs to it — the same separation that file
 * already describes, applied to the one thing that most needs it.
 *
 * That separation is also why there is no `NODE_ENV === "test"` guard in here. A guard
 * would be a second line of defence for a door that is not reachable, and it would
 * make the real reason harder to see.
 */

import { sweepExpiredRequests, REQUEST_EXPIRY_HOURS } from "./services/bookingService.js";

/**
 * How often the sweeps run.
 *
 * Hourly, chosen against what is being swept rather than as a round number: a request
 * expires after 48 hours, so an hour of lateness is a rounding error on that window
 * and nobody can tell. A tighter interval would buy precision nobody asked for and
 * multiply the query count for it.
 */
export const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Every sweep, named. Step 7's offer expiry joins this list rather than starting a
 * second timer — one scheduler is a thing you can reason about, two is a thing you
 * forget you have.
 */
const SWEEPS = [{ name: "bookings", run: sweepExpiredRequests }];

/**
 * Runs every sweep once, in sequence.
 *
 * EXPORTED SEPARATELY FROM THE TIMER so it can be tested, and called by hand, without
 * waiting an hour. Never throws: a sweep is a background chore, and a process that
 * dies because one of them failed is strictly worse than one that logs and tries
 * again next hour.
 *
 * Sequential rather than parallel. These share one connection pool, and there are two
 * of them at most — the concurrency would buy nothing and would make the log
 * interleave.
 *
 * @returns {Promise<void>}
 */
export async function runSweeps() {
  for (const sweep of SWEEPS) {
    try {
      const result = await sweep.run();

      // Only when something actually happened. An hourly line saying "expired 0" on
      // every quiet hour is 24 lines a day that train you to stop reading the log.
      if (result.expired > 0 || result.failed > 0) {
        console.log(
          `[sweep] ${sweep.name}: expired=${result.expired} failed=${result.failed}`
        );
      }
    } catch (error) {
      console.error(`[sweep] ${sweep.name} failed:`, error.message);
    }
  }
}

/**
 * Starts the schedule, and runs one pass immediately.
 *
 * IMMEDIATELY, deliberately. A process that has been down — a deploy, a crash, a free
 * tier spinning back up — comes back with work already overdue, and waiting a full
 * hour to notice would make every restart a fresh hour of staleness.
 *
 * Overlapping runs are skipped rather than queued. `setInterval` does not wait for an
 * async callback, so a slow pass would have a second one starting on top of it, both
 * trying to expire the same rows — the state machine would refuse the loser, which is
 * safe but reports real work as `failed`. A flag is enough; nothing here needs a lock.
 *
 * @returns {() => void} Stops the schedule. Idempotent.
 */
export function startScheduler() {
  let running = false;

  const tick = async () => {
    if (running) {
      console.warn("[sweep] previous pass still running, skipping this one");
      return;
    }
    running = true;
    try {
      await runSweeps();
    } finally {
      running = false;
    }
  };

  console.log(
    `[sweep] every ${SWEEP_INTERVAL_MS / 60000}m — booking requests expire after ${REQUEST_EXPIRY_HOURS}h`
  );

  void tick();
  const timer = setInterval(tick, SWEEP_INTERVAL_MS);

  return () => clearInterval(timer);
}

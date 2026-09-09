/**
 * Process entry point.
 *
 * This file owns everything about being a RUNNING PROCESS: validating the
 * environment, binding a port, and shutting down cleanly. app.js owns what the
 * application is. Nothing imports this file except Node itself - see app.js for why
 * that separation is load-bearing for the tests.
 */

import { app } from "./app.js";
import { assertEnvIsValid, env } from "./config/env.js";
import { closeDatabase } from "./config/db.js";
import { describeMailMode } from "./config/mailer.js";

// Validate BEFORE binding a port. The order matters: a process that fails validation
// must never reach a state where it accepts a request it cannot serve. Getting this
// backwards produces a service that answers /health with 200 and then 500s on the
// first real call - which looks healthy to every monitor you have.
assertEnvIsValid();

const server = app.listen(env.port, () => {
  console.log(`[server] listening on port ${env.port} (${env.nodeEnv})`);
  console.log(`[server] health: http://localhost:${env.port}/api/health`);

  // The base URL every emailed link is built from. Printed because it is otherwise
  // invisible until someone clicks a link and lands somewhere unexpected - which is
  // exactly how a Vite port drift once sent verification links to a different
  // application on this machine. If this does not match the client dev server's port,
  // every link in every email is wrong.
  console.log(`[server] links point at: ${env.appUrl}`);

  // Said at boot deliberately. "Mail is not configured" is otherwise invisible until
  // the first person fails to receive a verification link — at which point it looks
  // like a bug in registration rather than a missing environment variable.
  console.log(`[mail] ${describeMailMode()}`);
});

/**
 * Shuts down without dropping in-flight requests.
 *
 * `server.close()` stops accepting NEW connections and waits for current responses to
 * finish. Without it, a deploy kills the process mid-request and a customer sees a
 * failed submission for work the server had already done.
 *
 * @param {string} signal The signal that triggered shutdown, for the log line.
 * @returns {Promise<void>}
 */
async function shutdown(signal) {
  console.log(`[server] ${signal} received, shutting down`);

  server.close(async () => {
    // Close the pool only after the HTTP server has drained - a request still
    // finishing may need one more query.
    await closeDatabase();
    console.log("[server] closed cleanly");
    process.exit(0);
  });

  // Backstop: if a connection refuses to close (a hung keep-alive, a slow query), do
  // not hang forever. Container orchestrators SIGKILL after ~10s anyway, so exiting
  // at 10s on our own terms means the cleanup above at least got its chance.
  setTimeout(() => {
    console.error("[server] forced exit after 10s");
    process.exit(1);
  }, 10_000).unref(); // unref so this timer alone never keeps the process alive
}

// SIGTERM is what Docker, Render and Kubernetes send to stop a container.
// SIGINT is Ctrl+C in a terminal. Both must shut down the same way.
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

/**
 * Refuses to let the test suite run against a non-test database.
 *
 * WHY THIS FILE EXISTS AT ALL, and it is not paranoia: the test harness TRUNCATEs
 * tables between tests. Pointed at the wrong database, that is silent, total data
 * loss — and it reports a healthy green run while doing it.
 *
 * The realistic way it happens is mundane. You export DATABASE_URL into a shell to
 * run a migration against a deployed database, then run `npm test` in the same
 * terminal an hour later. Nothing warns you. Every table is gone.
 *
 * So the rule is enforced in code rather than by memory, and it FAILS CLOSED: if the
 * configuration cannot be read, that is a refusal, not a pass. "Can't tell" must
 * never mean "probably fine".
 *
 * Extracted into its own module on purpose. Inline in the test setup it could only be
 * exercised by spawning a whole test run, so in practice it would never be tested —
 * which is exactly how a guard this important ends up carrying a hole.
 */

/**
 * Resolves the database that would actually be connected to.
 *
 * MIRRORS `buildDatabaseUrl` in config/env.js — DATABASE_URL first, discrete DB_*
 * second — and that ordering is the whole safety property. If this checked DB_NAME
 * while the pool used a DATABASE_URL left over in the shell, the guard would approve
 * one database and the suite would truncate another.
 *
 * Kept as a small duplicate of that logic rather than importing it, deliberately:
 * importing config/env.js runs `dotenv.config()` and would couple the guard to
 * module load order, and this module has to be safe to call before anything else.
 *
 * @param {NodeJS.ProcessEnv} vars
 * @returns {{ name: string } | { error: string }}
 */
function resolveDatabaseName(vars) {
  // Truthy check, not `in`: `.env.test` deliberately sets `DATABASE_URL=` to an empty
  // string to neutralise a value inherited from the shell, and an empty string must
  // fall through to the discrete parts rather than count as "configured".
  if (vars.DATABASE_URL) {
    let name;
    try {
      // The pathname is "/service_center_test" — strip the leading slash.
      name = new URL(vars.DATABASE_URL).pathname.replace(/^\//, "");
    } catch {
      // Fail closed. An unparseable URL cannot be proven safe.
      return { error: "DATABASE_URL could not be parsed." };
    }
    if (!name) return { error: "DATABASE_URL names no database." };
    return { name };
  }

  if (vars.DB_NAME) return { name: vars.DB_NAME };

  return { error: "No database is configured (set DB_NAME, or DATABASE_URL)." };
}

/**
 * Asserts the current environment is safe to truncate.
 *
 * @param {object} [envVars=process.env] Injectable so this can be unit-tested
 *        without mutating the real environment.
 * @returns {void}
 * @throws {Error} If NODE_ENV is not "test", or no database is configured, or the
 *         configuration is unreadable, or the resolved database does not end in
 *         `_test`. The message names the DATABASE but never the connection string —
 *         that string contains a password, and this error is going to end up in a
 *         log or a screenshot.
 */
export function assertTestDatabase(envVars = process.env) {
  if (envVars.NODE_ENV !== "test") {
    throw new Error(
      `Refusing to run: NODE_ENV must be "test", got "${envVars.NODE_ENV ?? "undefined"}".`
    );
  }

  const resolved = resolveDatabaseName(envVars);
  if ("error" in resolved) {
    throw new Error(`Refusing to run: ${resolved.error}`);
  }

  // The `_test` suffix is a convention this project relies on, so the check is a
  // simple string test rather than an allow-list of known-safe names — an allow-list
  // would need updating for every new developer's local database.
  //
  // `endsWith`, not `includes`: "my_test_data" contains "_test" and is not a test
  // database.
  if (!resolved.name.endsWith("_test")) {
    throw new Error(
      `Refusing to run: database "${resolved.name}" does not end in "_test". ` +
        `The test suite truncates tables and must never point at real data.`
    );
  }
}

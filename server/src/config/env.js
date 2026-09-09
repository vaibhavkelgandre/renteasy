/**
 * Environment configuration and startup validation.
 *
 * The process must refuse to start if a required secret is missing, and say WHICH.
 * A secret whose absence is only discovered at first use produces a service that
 * boots fine, answers /health with 200, and then throws on the first real request —
 * a much worse bug than a crash at startup, because everything looks healthy.
 *
 * Nothing else in the codebase reads `process.env` directly.
 */

import dotenv from "dotenv";

dotenv.config();

/** Variables the process cannot run without. */
const REQUIRED = ["JWT_SECRET"];

/**
 * Builds a Postgres connection string from discrete DB_* variables.
 *
 * Two ways to configure a database and both are needed: discrete parts locally (each
 * value on its own line, so filling in a password is one field rather than surgery
 * inside a URL), and `DATABASE_URL` for managed hosts, which hand you one string and
 * no parts. `DATABASE_URL` WINS when set — a deployed environment sets it, and a
 * stale DB_* value left alongside must not silently take precedence.
 *
 * @param {NodeJS.ProcessEnv} vars
 * @returns {string | undefined}
 */
function buildDatabaseUrl(vars) {
  if (vars.DATABASE_URL) return vars.DATABASE_URL;

  const { DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME } = vars;
  if (!DB_USER || !DB_NAME) return undefined;

  // encodeURIComponent on the password is not optional. A password containing
  // @ : / ? # is legal in Postgres and breaks URL parsing outright — `p@ss` makes the
  // parser read "p" as the password and "ss@host" as the host, producing a connection
  // error that names a host you have never heard of.
  const auth = `${encodeURIComponent(DB_USER)}:${encodeURIComponent(DB_PASSWORD ?? "")}`;
  return `postgresql://${auth}@${DB_HOST ?? "localhost"}:${DB_PORT ?? 5432}/${DB_NAME}`;
}

/**
 * Validates the environment and aborts if anything required is absent.
 *
 * Called once from server.js BEFORE the listener starts — deliberately not at import
 * time, so importing this module inside a test never kills the test runner.
 *
 * @returns {void}
 * @throws Never. Calls process.exit(1), because a misconfigured process should die
 *         visibly rather than hand a broken object to its caller.
 */
export function assertEnvIsValid() {
  const missing = REQUIRED.filter((name) => !process.env[name]);

  if (missing.length > 0) {
    // Names only, never values — this line goes to logs.
    console.error(`[env] Refusing to start. Missing: ${missing.join(", ")}`);
    console.error(`[env] See server/.env.example.`);
    process.exit(1);
  }

  if (!env.databaseUrl) {
    console.error(`[env] Refusing to start. No database configured.`);
    console.error(`[env] Set DB_USER and DB_NAME (plus DB_PASSWORD), or set DATABASE_URL.`);
    process.exit(1);
  }

  if (Number.isNaN(Number(env.port))) {
    console.error(`[env] Refusing to start. PORT must be a number, got: ${process.env.PORT}`);
    process.exit(1);
  }
}

export const env = {
  port: process.env.PORT ?? 5000,
  nodeEnv: process.env.NODE_ENV ?? "development",
  appVersion: process.env.APP_VERSION ?? "0.1.0",
  databaseUrl: buildDatabaseUrl(process.env),

  // No fallback, deliberately. A default like "dev-secret" is worse than a missing
  // one: everything appears to work while the deployment signs real sessions with a
  // value that is in the repository.
  jwtSecret: process.env.JWT_SECRET,

  // Where verification links point. The token is never in a URL we control
  // server-side — this is a FRONTEND route that reads the token and POSTs it.
  appUrl: process.env.APP_URL ?? "http://localhost:5173",

  /**
   * The terms version a new account must accept.
   *
   * Config rather than a database row: it changes when the lawyers say so, which is a
   * deploy, not an admin action. Registration refuses a stale version (409) — see
   * docs/features/01-public-registration.md §7.
   */
  termsVersion: process.env.TERMS_VERSION ?? "2026-09-01",

  /**
   * Mail provider credentials. Absent is a legitimate state — see mailer.js, which
   * falls back to the console in development and refuses to send in production.
   *
   * Both are TRIMMED, and that is not tidiness. A key pasted out of a dashboard
   * routinely carries a trailing newline or a leading space, and Brevo answers a
   * whitespace-padded key with a 401 that is indistinguishable from a wrong one.
   *
   * No default for either. A default sender would send as somebody else's verified
   * address, which the provider rejects anyway — but only after the send looked
   * configured.
   */
  brevoApiKey: (process.env.BREVO_API_KEY ?? "").trim(),
  mailFrom: (process.env.MAIL_FROM ?? "").trim(),

  isProduction: process.env.NODE_ENV === "production",
  isTest: process.env.NODE_ENV === "test",
  isDevelopment: (process.env.NODE_ENV ?? "development") === "development",
};

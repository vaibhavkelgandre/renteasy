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
 * The only legal values for NODE_ENV.
 *
 * `nodeEnv`/`isDevelopment` below default a MISSING NODE_ENV to "development" — that
 * default exists so importing this module in a script that never calls
 * `assertEnvIsValid()` doesn't crash. It must never be reachable in a real deployment,
 * because "development" flips three things at once: mailer.js prints verification and
 * reset links (live, single-use tokens) to stdout, cookies.js drops the cookie's
 * `Secure` flag, and db.js disables Postgres SSL entirely. A host that simply forgets
 * to set NODE_ENV would otherwise boot looking perfectly healthy — /health still
 * answers 200 — while quietly running in the least safe mode there is.
 */
const VALID_NODE_ENVS = ["production", "development", "test"];

/**
 * Normalizes an APP_URL value down to a bare origin — scheme + host + port, no path,
 * no trailing slash.
 *
 * Two call sites depend on that shape in incompatible ways if it drifts: socketAuth.js
 * checks a browser's `Origin` header with `origin === env.appUrl`, which is an EXACT
 * string match — a trailing slash (an easy typo in a hosting dashboard) makes every
 * WebSocket handshake fail closed, silently falling back to polling. mailService.js
 * concatenates `${env.appUrl}/verify/...` — the same trailing slash there produces a
 * double slash in every emailed link instead.
 *
 * @param {string} value
 * @returns {string} the normalized origin
 * @throws {TypeError} if value is not a parseable absolute URL
 */
function normalizeAppUrl(value) {
  return new URL(value).origin;
}

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
  // Checked FIRST and against process.env directly, never against the defaulted
  // `env.nodeEnv` below — a defaulted value can never fail this check by definition,
  // which is exactly the silent-fallback bug this exists to close. Every later check
  // in this function (and every env.isProduction/isDevelopment branch elsewhere)
  // assumes NODE_ENV was actually set on purpose, so this has to run before anything
  // else does.
  if (!VALID_NODE_ENVS.includes(process.env.NODE_ENV)) {
    console.error(
      `[env] Refusing to start. NODE_ENV must be one of ${VALID_NODE_ENVS.join(", ")}, got: ${
        process.env.NODE_ENV ? `"${process.env.NODE_ENV}"` : "(unset)"
      }`
    );
    console.error(`[env] Set NODE_ENV=production on the deployed host.`);
    process.exit(1);
  }

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

  // APP_URL defaults to http://localhost:5173 below — fine for a laptop, silently
  // wrong in production. Left unset there, every verification/reset email links to
  // localhost (breaking signup and recovery outright) and every browser WebSocket
  // handshake is refused (socketAuth.js's exact-match Origin check can never equal
  // "http://localhost:5173"), which falls back to polling with no error anywhere.
  // Both failures are invisible to /health, so this has to be caught at boot instead.
  if (env.isProduction) {
    if (!process.env.APP_URL) {
      console.error(`[env] Refusing to start. APP_URL is required in production.`);
      console.error(`[env] Set it to the deployed frontend origin, e.g. https://<service>.onrender.com`);
      process.exit(1);
    }

    let parsed;
    try {
      parsed = new URL(process.env.APP_URL);
    } catch {
      console.error(`[env] Refusing to start. APP_URL is not a valid URL: "${process.env.APP_URL}"`);
      process.exit(1);
    }

    if (parsed.protocol !== "https:") {
      console.error(
        `[env] Refusing to start. APP_URL must be https in production, got: "${process.env.APP_URL}"`
      );
      process.exit(1);
    }
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
  //
  // Normalized through normalizeAppUrl() so a trailing slash (or a path) typed into a
  // hosting dashboard can't silently break the socket Origin check or double-slash a
  // link — see that function's comment. Falls back to the raw value on a malformed
  // APP_URL rather than throwing at import time: assertEnvIsValid() is what refuses to
  // boot on that in production; in development an invalid value here just means
  // visibly broken links, which is a loud, harmless local-only failure.
  appUrl: (() => {
    const raw = process.env.APP_URL ?? "http://localhost:5173";
    try {
      return normalizeAppUrl(raw);
    } catch {
      return raw;
    }
  })(),

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

  /**
   * Image storage. Absent is legitimate: uploads simply refuse, loudly, and everything
   * that is not a photo still works. Checked as three-of-three by
   * `isMediaConfigured()`, because a half-filled environment fails with an
   * authentication error indistinguishable from a wrong secret.
   *
   * Trimmed for the same reason as the mail key — a value pasted from a dashboard
   * routinely carries a trailing newline.
   */
  cloudinaryCloudName: (process.env.CLOUDINARY_CLOUD_NAME ?? "").trim(),
  cloudinaryApiKey: (process.env.CLOUDINARY_API_KEY ?? "").trim(),
  cloudinaryApiSecret: (process.env.CLOUDINARY_API_SECRET ?? "").trim(),

  isProduction: process.env.NODE_ENV === "production",
  isTest: process.env.NODE_ENV === "test",
  isDevelopment: (process.env.NODE_ENV ?? "development") === "development",

  /**
   * TLS setting for the Postgres connection pool AND the migration runner — the one
   * place either reads it, so the two can never disagree.
   *
   * EXPLICIT DB_SSL, not inferred from NODE_ENV alone: migrating from a laptop against
   * a hosted database (Neon) needs SSL on while NODE_ENV stays "development" locally,
   * and tying SSL only to the environment name means every such command has to fight
   * the default. `DB_SSL=true`/`DB_SSL=false` overrides; unset falls back to "on in
   * production" — the previous, and still the common, case.
   *
   * `rejectUnauthorized: true`, never false: Neon and Render Postgres both present
   * certificates that chain to a public CA, so verifying costs nothing. `false` still
   * encrypts the connection but never actually checks who is on the other end of it —
   * a man-in-the-middle can present any certificate and be accepted. A local Postgres
   * has no DATABASE_URL and offers no SSL at all; demanding it there fails the
   * handshake outright, which is why the default is `false` off of production.
   */
  dbSsl: (() => {
    const raw = (process.env.DB_SSL ?? "").trim().toLowerCase();
    if (raw === "true") return { rejectUnauthorized: true };
    if (raw === "false") return false;
    return process.env.NODE_ENV === "production" ? { rejectUnauthorized: true } : false;
  })(),
};

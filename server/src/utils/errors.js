/**
 * Typed HTTP errors.
 *
 * Services throw these; app.js's error handler turns them into responses. That split
 * is what keeps a service free of `res` — a service that writes to the response
 * cannot be called from anywhere except an Express handler, and cannot be
 * unit-tested without faking one.
 *
 * `expose: true` is the flag app.js checks before putting `message` in the response
 * body. An unexpected error (a TypeError, a dropped connection) has no `expose`, so
 * it answers a generic "Something went wrong" — a stack trace or a SQL string in a
 * response body is itself an information leak.
 *
 * WHICH CODE TO USE is a decision, not a default. docs/2.api-documentation.md holds
 * the per-endpoint answer; the general rule:
 *   401  no valid session at all
 *   403  authenticated, record legitimately known to them, action not permitted
 *   404  record absent, OR the caller has no more reason to know it exists than a
 *        stranger — a technician fetching another technician's ticket
 *   409  request is fine, the record's current STATE refuses it (illegal transition)
 */

/**
 * An error carrying an HTTP status and a client-safe message.
 */
export class AppError extends Error {
  /**
   * @param {number} status HTTP status code.
   * @param {string} message Client-safe. Never include SQL, stack traces, tokens or
   *        connection strings — this string is sent to the caller.
   * @param {Record<string, string>} [errors={}] Field-keyed detail for form errors.
   */
  constructor(status, message, errors = {}) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.errors = errors;
    this.expose = true;
  }
}

/** @param {string} [message] @param {Record<string,string>} [errors] */
export const badRequest = (message = "Invalid request", errors = {}) =>
  new AppError(400, message, errors);

/** @param {string} [message] */
export const unauthorized = (message = "Authentication required") => new AppError(401, message);

/** @param {string} [message] */
export const forbidden = (message = "You do not have permission to do this") =>
  new AppError(403, message);

/** @param {string} [message] */
export const notFound = (message = "Not found") => new AppError(404, message);

/**
 * 410 Gone — used for every verification-token failure.
 *
 * Expired, already used, unknown, malformed, or issued for an address the user has
 * since changed: FIVE causes, ONE answer. Distinguishing them would tell someone
 * guessing tokens which guesses were closer.
 *
 * @param {string} [message]
 */
export const gone = (message = "This link is no longer valid") => new AppError(410, message);

/** @param {string} [message] */
export const conflict = (message = "That is not possible in the current state") =>
  new AppError(409, message);

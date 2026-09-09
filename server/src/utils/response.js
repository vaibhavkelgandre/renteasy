/**
 * The single response envelope for the whole API.
 *
 * Every endpoint answers in one of exactly two shapes:
 *
 *   { success: true,  message: "...", data: {} }
 *   { success: false, message: "...", errors: {} }
 *
 * Why one shape everywhere: the client writes ONE error handler instead of guessing
 * per endpoint whether a failure is a string, an array, or a bare status code. It also
 * means a rate-limit 429 and a validation 400 look the same to the frontend, so
 * nothing needs a special case.
 *
 * Documented in docs/features/01-public-registration.md §6. If these two functions and that doc ever
 * disagree, the doc is wrong - but fix both.
 */

/**
 * Sends a success response.
 *
 * @param {import("express").Response} res Express response.
 * @param {object} options
 * @param {number} [options.status=200] HTTP status. 201 when a record was created.
 * @param {string} [options.message="OK"] Human-readable, safe to show a user.
 * @param {unknown} [options.data=null] The payload. Always under `data`, never at the top level.
 * @returns {import("express").Response}
 */
export function sendSuccess(res, { status = 200, message = "OK", data = null } = {}) {
  return res.status(status).json({ success: true, message, data });
}

/**
 * Sends an error response.
 *
 * @param {import("express").Response} res Express response.
 * @param {object} options
 * @param {number} [options.status=400] HTTP status. See docs/features/01-public-registration.md §6 for
 *        which code means what - the 403/404/409 split is a deliberate decision per
 *        endpoint, not a default.
 * @param {string} options.message Human-readable. Must never leak internals: no stack
 *        traces, no SQL, no connection strings, no token values.
 * @param {Record<string, string>} [options.errors={}] Field-keyed detail for form errors,
 *        e.g. { phone: "required" }. Machine-readable so the client can mark fields.
 * @returns {import("express").Response}
 */
export function sendError(res, { status = 400, message, errors = {} } = {}) {
  return res.status(status).json({ success: false, message, errors });
}

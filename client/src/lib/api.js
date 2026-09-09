/**
 * The single HTTP client for the whole app.
 *
 * Nothing else calls `fetch` directly. That is what keeps four things from being
 * re-decided per call site: the base path, the envelope, cookie behaviour, and what
 * an error looks like.
 */

const BASE = "/api";

/**
 * An HTTP error carrying the server's own message and field errors.
 *
 * The server answers every failure in one envelope
 * (`{ success: false, message, errors }`), so a caller gets a usable message and
 * per-field detail without inspecting status codes itself.
 */
export class ApiError extends Error {
  /**
   * @param {number} status HTTP status.
   * @param {string} message The server's message, safe to show a user.
   * @param {Record<string, string>} errors Field-keyed detail, e.g. { email: "Required" }.
   */
  constructor(status, message, errors = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.errors = errors;
  }
}

/**
 * Makes a request and unwraps the response envelope.
 *
 * @param {string} path Path under /api, e.g. "/auth/login".
 * @param {object} [options]
 * @param {"GET"|"POST"|"PATCH"|"DELETE"} [options.method="GET"]
 * @param {unknown} [options.body] Serialised as JSON when present.
 * @returns {Promise<unknown>} The envelope's `data`, never the envelope itself —
 *          callers should not have to remember to unwrap.
 * @throws {ApiError} On any non-2xx response, or on an unreachable server.
 */
async function request(path, { method = "GET", body } = {}) {
  let response;

  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,

      // "same-origin" is correct here and "include" would be wrong. Vite proxies /api
      // in development and Nginx does the same in production, so this request IS
      // same-origin from the browser's point of view — which is exactly what lets the
      // session cookie be `SameSite=Strict`, the strongest setting, eliminating CSRF
      // rather than mitigating it.
      //
      // Move the frontend to a different domain and this needs "include", the cookie
      // needs `SameSite=None`, and CSRF protection has to be added back by hand.
      credentials: "same-origin",
    });
  } catch {
    // fetch only rejects when the request never completed — server down, DNS
    // failure, connection dropped. An HTTP error status is a resolved promise, so it
    // is handled below.
    throw new ApiError(0, "Could not reach the server. Is it running?");
  }

  // 204 has no body, so parsing it would throw.
  if (response.status === 204) return null;

  let payload;
  try {
    payload = await response.json();
  } catch {
    // A non-JSON body from an endpoint that promises JSON usually means a proxy or a
    // crash returned HTML. Say so, rather than surfacing "Unexpected token < in JSON".
    throw new ApiError(response.status, `Unexpected response from the server (${response.status}).`);
  }

  if (!response.ok) {
    throw new ApiError(
      response.status,
      payload?.message ?? `Request failed (${response.status})`,
      payload?.errors ?? {}
    );
  }

  return payload.data;
}

export const api = {
  /** @param {string} path @returns {Promise<unknown>} */
  get: (path) => request(path),
  /** @param {string} path @param {unknown} [body] @returns {Promise<unknown>} */
  post: (path, body) => request(path, { method: "POST", body }),
  /** @param {string} path @param {unknown} [body] @returns {Promise<unknown>} */
  patch: (path, body) => request(path, { method: "PATCH", body }),
  /** @param {string} path @returns {Promise<unknown>} */
  delete: (path) => request(path, { method: "DELETE" }),
};

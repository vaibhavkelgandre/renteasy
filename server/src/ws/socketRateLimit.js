/**
 * A per-socket cap on how often one client may fire an event.
 *
 * WHY THIS EXISTS AT ALL, AND WHY IT DID NOT UNTIL NOW. `express-rate-limit` guards
 * the pre-auth HTTP routes, and NFR-9 is deliberate that it guards nothing else — a
 * limiter over ordinary authenticated use would throttle ordinary browsing. That
 * reasoning covers `message:send` too, which writes a row and is subject to exactly
 * the same (absent) policy as the HTTP route beside it.
 *
 * `thread:typing` and `thread:read` are the ones that are genuinely different. They
 * have NO HTTP equivalent, they write nothing a person would notice, and they cost
 * the client nothing to send — so a buggy or hostile client can emit them in a tight
 * loop, and no middleware stands in the way, because a frame on an established
 * connection passes through none. That is the gap this closes, and nothing wider.
 *
 * A FIXED WINDOW, NOT A TOKEN BUCKET. The difference between them only matters at a
 * boundary — a fixed window lets through up to twice the limit across two adjacent
 * windows — and here that is a client sending forty typing pings instead of twenty.
 * The bucket's extra state buys nothing against that.
 *
 * THE STATE LIVES ON THE SOCKET, so it is reclaimed when the connection closes and
 * there is nothing to expire, sweep, or leak. It is also per connection rather than
 * per user, which is the honest unit: five tabs are five clients.
 */

/**
 * Whether this event may proceed, counting it if so.
 *
 * @param {import("socket.io").Socket} socket
 * @param {string} event Counted separately per event, so a flood of one cannot
 *        starve another.
 * @param {object} limits
 * @param {number} limits.limit How many are allowed per window.
 * @param {number} limits.windowMs
 * @returns {boolean} False when the caller is over its limit and the event should be
 *          dropped.
 */
export function withinRateLimit(socket, event, { limit, windowMs }) {
  const windows = (socket.data.rateLimits ??= new Map());
  const now = Date.now();
  const current = windows.get(event);

  if (!current || now - current.start >= windowMs) {
    windows.set(event, { start: now, count: 1 });
    return true;
  }

  if (current.count >= limit) return false;

  current.count += 1;
  return true;
}

/**
 * Typing: generous, because a correctly debounced client sends roughly one every
 * three seconds and a burst of genuine start/stop is normal. This is a ceiling on a
 * loop, not a shaping of ordinary use.
 */
export const TYPING_LIMIT = { limit: 20, windowMs: 10_000 };

/**
 * Read receipts: fired on focus and on each arriving message, so a busy thread can
 * legitimately produce several in a few seconds.
 */
export const READ_LIMIT = { limit: 30, windowMs: 10_000 };

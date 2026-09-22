/**
 * A stand-in for `lib/socket.js`, mocked globally in `setup.js`.
 *
 * GLOBAL RATHER THAN PER FILE, because the notification bell lives in the layout —
 * so every test that renders the app touches the socket, not just the ones about
 * messaging. Left real, each of those would open a connection from jsdom, fail, and
 * retry with backoff for the rest of the run.
 *
 * `lib/socket.js` being the only module that imports `socket.io-client` is what makes
 * one mock enough. That was the reason for the wrapper, and this is where it pays.
 *
 * IT DEFAULTS TO DISCONNECTED. `request` rejects, components fall back to polling,
 * and every test written before this transport existed still describes real
 * behaviour — the fallback path, which is worth having covered by default. A test
 * that wants the live path opts in with `realtime.connected` and a `reply`.
 */

import { act } from "@testing-library/react";

/** event → the handlers a component has registered. */
const listeners = new Map();

/**
 * The knobs a test turns, and the record of what the component did.
 *
 * A mutable object rather than setters, so a test reads as three assignments at the
 * top and assertions at the bottom.
 */
export const realtime = {
  /** Whether `getSocket().connected` reports true. */
  connected: false,

  /** Set to `(event, payload) => data` to make acknowledged requests succeed. */
  reply: null,

  /** Every `request(...)` the component made. */
  requests: [],

  /** Every fire-and-forget `socket.emit(...)` — typing, and `thread:leave`. */
  emitted: [],
};

export function getSocket() {
  return {
    get connected() {
      return realtime.connected;
    },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(handler);
    },
    off(event, handler) {
      listeners.get(event)?.delete(handler);
    },
    emit(event, payload) {
      realtime.emitted.push({ event, payload });
    },
  };
}

export function closeSocket() {}

export async function request(event, payload = {}) {
  realtime.requests.push({ event, payload });
  if (!realtime.reply) throw new Error("No socket");
  return realtime.reply(event, payload);
}

/**
 * Delivers a server-sent event to whatever the component registered.
 *
 * Wrapped in `act` here rather than at each call site: a push arrives from outside
 * React's own event system, so without it the state update is flushed after the
 * assertion has already run — a failure that looks like the component ignoring the
 * event.
 *
 * @param {string} event
 * @param {object} payload
 * @returns {void}
 */
export function push(event, payload) {
  act(() => {
    for (const handler of listeners.get(event) ?? []) handler(payload);
  });
}

/** Called from `setup.js`'s `afterEach`, so no test inherits another's socket. */
export function resetRealtime() {
  listeners.clear();
  realtime.connected = false;
  realtime.reply = null;
  realtime.requests.length = 0;
  realtime.emitted.length = 0;
}

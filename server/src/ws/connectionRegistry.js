/**
 * Who is currently connected, and on how many sockets.
 *
 * ONE HUMAN IS MANY SOCKETS — a phone, a laptop, and three tabs on that laptop. So
 * the unit of presence is a USER, not a connection, and the only two moments that
 * matter are the FIRST socket arriving and the LAST one leaving. Everything in
 * between is invisible to the other party and must not produce an event.
 *
 * WHY THIS EXISTS WHEN SOCKET.IO ALREADY TRACKS ROOMS. Its adapter does know who is
 * in `user:<id>`, so `isOnline` could be derived from it. Two reasons not to:
 * transition detection off the adapter means reading a room's size before and after
 * a join, which is both fiddly and dependent on adapter internals; and
 * `fetchSockets()` is async, so presence would become an await inside code paths
 * that are otherwise synchronous. A 40-line Map is cheaper than either.
 *
 * DELIBERATELY IN-MEMORY, AND THEREFORE PER PROCESS. This is the same assumption
 * `scheduler.js` already writes down — one instance. A second one would see only its
 * own half of the connections and report a user as offline to anybody attached to the
 * other node. THIS MODULE IS THE PLACE THAT CHANGES when that day comes: swap the Map
 * for a Redis set with a TTL and add `@socket.io/redis-adapter`. Nothing outside this
 * file knows how the answer is stored.
 *
 * The state can only drift if `unregister` is not called for a socket that is gone.
 * Socket.IO guarantees a `disconnect` event for every connection it accepted, so the
 * single rule is that the disconnect handler in socketServer.js must never be
 * conditional.
 */

/**
 * userId → the set of that user's live socket ids.
 *
 * Socket IDS rather than socket objects: nothing here needs to talk to a socket, and
 * holding the objects would keep a disconnected socket's buffers alive until the entry
 * was removed. Talking to sockets is done through the room (`io.in(userRoom(id))`),
 * which is Socket.IO's job and works unchanged under a clustered adapter.
 */
const socketIdsByUser = new Map();

/**
 * The room every one of a user's sockets joins.
 *
 * Exported rather than inlined at the two call sites, because a room name is a string
 * that fails SILENTLY when it is wrong: a typo produces a room nobody is in and a
 * publish that reaches nobody, with no error anywhere.
 *
 * @param {string} userId
 * @returns {string}
 */
export function userRoom(userId) {
  return `user:${userId}`;
}

/**
 * Records a connected socket.
 *
 * @param {string} userId
 * @param {string} socketId
 * @returns {boolean} True only if this was the user's FIRST socket — i.e. they just
 *          came online, and that transition is worth telling somebody about. False for
 *          a second tab, which is not news.
 */
export function register(userId, socketId) {
  const existing = socketIdsByUser.get(userId);

  if (existing) {
    existing.add(socketId);
    return false;
  }

  socketIdsByUser.set(userId, new Set([socketId]));
  return true;
}

/**
 * Forgets a disconnected socket.
 *
 * @param {string} userId
 * @param {string} socketId
 * @returns {boolean} True only if that was the user's LAST socket — they are now
 *          offline. False while any other tab remains, which is why closing one tab
 *          must not mark somebody away.
 */
export function unregister(userId, socketId) {
  const existing = socketIdsByUser.get(userId);
  if (!existing) return false;

  existing.delete(socketId);
  if (existing.size > 0) return false;

  // The empty Set is deleted rather than left behind, so `socketIdsByUser.size` stays
  // the count of online users and never grows with everyone who has ever connected.
  socketIdsByUser.delete(userId);
  return true;
}

/**
 * Whether a user has at least one live socket right now.
 *
 * @param {string} userId
 * @returns {boolean}
 */
export function isOnline(userId) {
  return socketIdsByUser.has(userId);
}

/**
 * Every user with a live socket.
 *
 * For the revalidation sweep, which has to re-ask the database whether each of them is
 * still allowed to be connected. A snapshot array, not the live keys, because the
 * caller disconnects sockets while iterating and mutating a Map mid-iteration is how
 * you silently skip an entry.
 *
 * @returns {string[]}
 */
export function connectedUserIds() {
  return [...socketIdsByUser.keys()];
}

/**
 * Empties the registry. TESTS ONLY.
 *
 * Module-level state outlives a test, unlike the database, which `tests/setup.js`
 * truncates. Without this a user left registered by one test is online in the next —
 * the same reason `mailer.js` exports `clearOutbox`.
 *
 * @returns {void}
 */
export function resetRegistry() {
  socketIdsByUser.clear();
}

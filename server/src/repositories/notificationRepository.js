/**
 * Database access for in-app notifications — FR-986.
 *
 * Nothing here decides who gets told what; that is `notificationService`. This file
 * only writes rows and counts them.
 */

import { query } from "../config/db.js";

/** Everything the client needs. `user_id` is absent — a caller only ever reads their own. */
const NOTIFICATION_COLUMNS = `
  id, type, entity_type, entity_id, message, read_at, created_at
`;

/**
 * Writes one notification.
 *
 * @param {object} input
 * @param {string} input.userId The RECIPIENT, never the actor.
 * @param {string} input.type
 * @param {string} input.entityType `BOOKING` or `LISTING`.
 * @param {string} input.entityId
 * @param {string} input.message
 * @returns {Promise<object>} The created row.
 * @throws {Error} On a database failure — the caller is expected to swallow it.
 */
export async function insertNotification({ userId, type, entityType, entityId, message }) {
  const { rows } = await query(
    `INSERT INTO notifications (user_id, type, entity_type, entity_id, message)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${NOTIFICATION_COLUMNS}`,
    [userId, type, entityType, entityId, message]
  );
  return rows[0];
}

/**
 * One page of somebody's notifications, newest first — FR-986.
 *
 * `total` comes from the SAME STATEMENT via `count(*) OVER ()`, not a second query.
 * Sharing a WHERE clause between two statements relies on discipline; sharing one
 * statement makes disagreement impossible, and the failure it prevents is silent —
 * a pager offering a page that renders empty.
 *
 * @param {string} userId
 * @param {object} page
 * @param {number} page.limit
 * @param {number} page.offset
 * @returns {Promise<{ notifications: object[], total: number }>}
 * @throws {Error} On a database failure.
 */
export async function findNotifications(userId, { limit, offset }) {
  const { rows } = await query(
    `SELECT ${NOTIFICATION_COLUMNS}, count(*) OVER () AS total_count
       FROM notifications
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  );

  return {
    notifications: rows.map(({ total_count, ...row }) => row),
    // No rows means no matches — there is no row to read a count off, and zero is
    // the right answer rather than a missing one.
    total: rows.length > 0 ? Number(rows[0].total_count) : 0,
  };
}

/**
 * How many are unread.
 *
 * ITS OWN QUERY, NEVER DERIVED FROM A LIST. This is polled by the header for every
 * signed-in user for as long as a tab is open, and fetching a page of rows to call
 * `.length` on it would make the most frequent request in the product also one of
 * the most expensive. Served by the partial index from migration 009.
 *
 * @param {string} userId
 * @returns {Promise<number>}
 * @throws {Error} On a database failure.
 */
export async function countUnreadNotifications(userId) {
  const { rows } = await query(
    `SELECT count(*)::int AS unread FROM notifications WHERE user_id = $1 AND read_at IS NULL`,
    [userId]
  );
  return rows[0].unread;
}

/**
 * Marks one notification read.
 *
 * SCOPED BY user_id AS WELL AS id, so knowing a uuid is not enough to touch somebody
 * else's row — the same rule as every other per-owner resource here. `read_at IS
 * NULL` makes it idempotent: reading twice keeps the first timestamp rather than
 * moving it, which matters because that is when they actually saw it.
 *
 * @param {string} userId
 * @param {string} id
 * @returns {Promise<object | null>} Null when there was no such unread row.
 * @throws {Error} On a database failure.
 */
export async function markNotificationRead(userId, id) {
  const { rows } = await query(
    `UPDATE notifications
        SET read_at = now()
      WHERE user_id = $1 AND id = $2 AND read_at IS NULL
      RETURNING ${NOTIFICATION_COLUMNS}`,
    [userId, id]
  );
  return rows[0] ?? null;
}

/**
 * Marks everything of somebody's read.
 *
 * @param {string} userId
 * @returns {Promise<number>} How many were actually unread.
 * @throws {Error} On a database failure.
 */
export async function markAllNotificationsRead(userId) {
  const { rowCount } = await query(
    `UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL`,
    [userId]
  );
  return rowCount;
}

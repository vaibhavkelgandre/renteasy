/**
 * Database access for booking messages.
 *
 * Nothing here decides who may read or write a thread — that is `messageService`,
 * which leans on `loadBookingForParty`. This file only moves rows.
 */

import { query } from "../config/db.js";

/**
 * `sender_id` is exposed so the client can tell "mine" from "theirs"; the sender's
 * NAME is joined rather than stored, so a rename is not a data migration.
 */
const MESSAGE_COLUMNS = `
  m.id, m.booking_id, m.sender_id, m.kind, m.body,
  m.storage_id, m.mime_type, m.bytes, m.created_at,
  u.name AS sender_name
`;

const FROM_MESSAGES = `FROM booking_messages m LEFT JOIN users u ON u.id = m.sender_id`;

/**
 * Appends one message.
 *
 * @param {object} input
 * @param {string} input.bookingId
 * @param {string|null} input.senderId Null for a SYSTEM message — nobody said it.
 * @param {string} input.kind
 * @param {string|null} [input.body]
 * @param {object|null} [input.attachment] `{ storageId, mimeType, bytes }`.
 * @returns {Promise<object>} The created row, with its sender's name.
 * @throws {Error} On a database failure.
 */
export async function insertMessage({ bookingId, senderId, kind, body = null, attachment = null }) {
  const { rows } = await query(
    `WITH inserted AS (
       INSERT INTO booking_messages (booking_id, sender_id, kind, body, storage_id, mime_type, bytes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *
     )
     SELECT ${MESSAGE_COLUMNS}
       FROM inserted m LEFT JOIN users u ON u.id = m.sender_id`,
    [
      bookingId,
      senderId,
      kind,
      body,
      attachment?.storageId ?? null,
      attachment?.mimeType ?? null,
      attachment?.bytes ?? null,
    ]
  );
  return rows[0];
}

/**
 * A page of a thread.
 *
 * TWO WINDOWS, NOT ONE, and they serve opposite directions:
 *
 *   `since`  — everything newer. This is the 3-second poll, and it is why the
 *              transport can later become SSE without the API changing: a
 *              reconnecting stream asks the same question.
 *   `before` — the page above the current one, for scrolling back through history.
 *
 * Oldest-first within the page, because a chat reads downwards and reversing it in
 * the client is a step that can be forgotten in one of the two callers.
 *
 * `since` IS EFFECTIVELY INCLUSIVE AT ITS BOUNDARY, despite the `>` below, and a
 * caller has to expect it. Postgres keeps microseconds, the `pg` driver hands back a
 * millisecond-precision JS `Date`, and JSON carries that truncated value — so a client
 * echoing a message's own `created_at` back as `since` sends a value up to 999µs
 * EARLIER than the one stored, and that message matches `>` again. Measured, not
 * assumed: `11:20:11.01424` came back as `11:20:11.014`.
 *
 * Left as it is rather than fixed, because the fix is worse than the symptom. Making
 * it exact would mean either a compound (timestamp, id) cursor in every caller, or
 * telling the `pg` driver to return timestamps as strings — which changes the shape of
 * every date in the whole API. The symptom is that a reconnecting client re-receives
 * ONE message it already has, and every client already merges by `id` because a socket
 * push and a poll response can overlap anyway. At-least-once with a dedupe by id is
 * the contract; exactly-once is not, and never was.
 *
 * @param {string} bookingId
 * @param {object} [window]
 * @param {Date|null} [window.since]
 * @param {Date|null} [window.before]
 * @param {number} [window.limit=50]
 * @returns {Promise<object[]>}
 * @throws {Error} On a database failure.
 */
export async function findMessages(bookingId, { since = null, before = null, limit = 50 } = {}) {
  const { rows } = await query(
    `SELECT * FROM (
       SELECT ${MESSAGE_COLUMNS}
         ${FROM_MESSAGES}
        WHERE m.booking_id = $1
          AND ($2::timestamptz IS NULL OR m.created_at > $2)
          AND ($3::timestamptz IS NULL OR m.created_at < $3)
        -- Newest first HERE so that LIMIT keeps the most recent page rather than the
        -- oldest, then flipped below so the caller always reads downwards.
        ORDER BY m.created_at DESC
        LIMIT $4
     ) page
     ORDER BY created_at ASC`,
    [bookingId, since, before, limit]
  );
  return rows;
}

/**
 * One message, for the attachment proxy to resolve before checking who is asking.
 *
 * Returns the booking id alongside, because the caller's next question is always
 * "are they a party to it".
 *
 * @param {string} id
 * @returns {Promise<object | null>}
 * @throws {Error} On a database failure.
 */
export async function findMessageById(id) {
  const { rows } = await query(
    `SELECT ${MESSAGE_COLUMNS} ${FROM_MESSAGES} WHERE m.id = $1`,
    [id]
  );
  return rows[0] ?? null;
}

/**
 * Moves a party's read watermark to now.
 *
 * An upsert rather than an insert-or-update pair: two tabs marking a thread read at
 * once would otherwise race on the primary key and one would 23505.
 *
 * `GREATEST` so a slow request cannot move the watermark BACKWARDS — which would
 * silently resurrect messages the person has already seen.
 *
 * @param {string} bookingId
 * @param {string} userId
 * @returns {Promise<void>}
 * @throws {Error} On a database failure.
 */
export async function markThreadRead(bookingId, userId) {
  await query(
    `INSERT INTO booking_message_reads (booking_id, user_id, last_read_at)
     VALUES ($1, $2, now())
     ON CONFLICT (booking_id, user_id)
     DO UPDATE SET last_read_at = GREATEST(booking_message_reads.last_read_at, EXCLUDED.last_read_at)`,
    [bookingId, userId]
  );
}

/**
 * How far through a thread one party has read.
 *
 * The same watermark `markThreadRead` moves, read back so the OTHER party can be
 * shown which of their messages have been seen. `countUnreadMessages` answers the
 * mirror-image question — "how much have I not seen" — and cannot serve this one,
 * because a read receipt is about somebody else's progress through your messages.
 *
 * @param {string} bookingId
 * @param {string} userId Whose progress to report.
 * @returns {Promise<Date | null>} Null when they have never opened the thread, which
 *          is a real answer and not a missing one — it means nothing has been read.
 * @throws {Error} On a database failure.
 */
export async function findReadWatermark(bookingId, userId) {
  const { rows } = await query(
    `SELECT last_read_at FROM booking_message_reads WHERE booking_id = $1 AND user_id = $2`,
    [bookingId, userId]
  );
  return rows[0]?.last_read_at ?? null;
}

/**
 * How many messages in one thread the caller has not seen.
 *
 * "Not mine, and newer than my watermark." A thread never read at all has no row, so
 * `COALESCE` to the epoch makes every message count — the correct answer rather than
 * zero, which is what a plain join would have given.
 *
 * @param {string} bookingId
 * @param {string} userId
 * @returns {Promise<number>}
 * @throws {Error} On a database failure.
 */
export async function countUnreadInThread(bookingId, userId) {
  const { rows } = await query(
    `SELECT count(*)::int AS unread
       FROM booking_messages m
       LEFT JOIN booking_message_reads r
         ON r.booking_id = m.booking_id AND r.user_id = $2
      WHERE m.booking_id = $1
        AND m.sender_id IS DISTINCT FROM $2
        AND m.created_at > COALESCE(r.last_read_at, 'epoch'::timestamptz)`,
    [bookingId, userId]
  );
  return rows[0].unread;
}

/**
 * Unread message counts across every thread the caller is party to.
 *
 * ONE QUERY, NOT ONE PER BOOKING. The bookings list shows a badge per row, and a
 * count per row would be an N+1 that grows with somebody's rental history.
 *
 * @param {string} userId
 * @returns {Promise<{ total: number, byBooking: Record<string, number> }>}
 * @throws {Error} On a database failure.
 */
export async function countUnreadMessages(userId) {
  const { rows } = await query(
    `SELECT m.booking_id, count(*)::int AS unread
       FROM booking_messages m
       JOIN bookings b ON b.id = m.booking_id
       JOIN listings l ON l.id = b.listing_id
       LEFT JOIN booking_message_reads r
         ON r.booking_id = m.booking_id AND r.user_id = $1
      WHERE (b.renter_id = $1 OR l.owner_id = $1)
        AND m.sender_id IS DISTINCT FROM $1
        AND m.created_at > COALESCE(r.last_read_at, 'epoch'::timestamptz)
      GROUP BY m.booking_id`,
    [userId]
  );

  return {
    total: rows.reduce((sum, row) => sum + row.unread, 0),
    byBooking: Object.fromEntries(rows.map((row) => [row.booking_id, row.unread])),
  };
}

/**
 * Every thread the caller has, newest activity first — the inbox.
 *
 * ONLY BOOKINGS THAT HAVE MESSAGES. An inbox listing every booking you have ever
 * made, most of them empty, is a list you stop reading. A conversation starts from
 * the booking page, which always offers it; this is where it lives afterwards.
 *
 * ONE QUERY, with two LATERALs rather than a fetch per row. The last message and the
 * unread count are both per-booking, and doing either in a loop is an N+1 that grows
 * with somebody's rental history.
 *
 * @param {string} userId
 * @returns {Promise<object[]>}
 * @throws {Error} On a database failure.
 */
export async function findThreads(userId) {
  const { rows } = await query(
    `SELECT b.id            AS booking_id,
            b.status        AS booking_status,
            b.starts_at,
            b.ends_at,
            l.title         AS listing_title,
            -- WHO THE OTHER PERSON IS, resolved here rather than in the client.
            -- The caller is one of two people and which one they are decides whose
            -- name to show; making the browser work that out means every consumer
            -- repeats the same conditional.
            CASE WHEN b.renter_id = $1 THEN owner.name ELSE renter.name END AS other_party_name,
            CASE WHEN b.renter_id = $1 THEN 'renter' ELSE 'owner' END       AS my_role,
            last.body       AS last_body,
            last.kind       AS last_kind,
            last.created_at AS last_at,
            last.sender_id  AS last_sender_id,
            COALESCE(unread.count, 0) AS unread
       FROM bookings b
       JOIN listings l    ON l.id = b.listing_id
       JOIN users renter  ON renter.id = b.renter_id
       JOIN users owner   ON owner.id = l.owner_id

       -- The most recent message, and its existence is what puts the booking in the
       -- list at all: a CROSS JOIN LATERAL drops rows with no match.
       CROSS JOIN LATERAL (
         SELECT m.body, m.kind, m.created_at, m.sender_id
           FROM booking_messages m
          WHERE m.booking_id = b.id
          ORDER BY m.created_at DESC
          LIMIT 1
       ) last

       LEFT JOIN LATERAL (
         SELECT count(*)::int AS count
           FROM booking_messages m
           LEFT JOIN booking_message_reads r
             ON r.booking_id = m.booking_id AND r.user_id = $1
          WHERE m.booking_id = b.id
            AND m.sender_id IS DISTINCT FROM $1
            AND m.created_at > COALESCE(r.last_read_at, 'epoch'::timestamptz)
       ) unread ON true

      WHERE b.renter_id = $1 OR l.owner_id = $1
      ORDER BY last.created_at DESC`,
    [userId]
  );
  return rows;
}

/**
 * Records a report against a message.
 *
 * ⚠️ Nothing reads this yet — there is no admin surface. See migration 010 for why
 * it is written anyway.
 *
 * @param {object} input
 * @param {string} input.messageId
 * @param {string} input.reportedBy
 * @param {string} input.reason
 * @returns {Promise<object | null>} Null when this person already reported it.
 * @throws {Error} On a database failure.
 */
export async function insertMessageReport({ messageId, reportedBy, reason }) {
  const { rows } = await query(
    `INSERT INTO booking_message_reports (message_id, reported_by, reason)
     VALUES ($1, $2, $3)
     -- A second press of the button is not a stronger complaint. Silently keeping
     -- the first is friendlier than a 409 nobody can act on.
     ON CONFLICT (message_id, reported_by) DO NOTHING
     RETURNING id, message_id, reason, created_at`,
    [messageId, reportedBy, reason]
  );
  return rows[0] ?? null;
}

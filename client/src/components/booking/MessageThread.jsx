/**
 * The conversation between the two parties to a booking.
 *
 * PUSHED, WITH POLLING AS THE FALLBACK — and the fallback is not a leftover. A socket
 * can fail in ways an HTTP request cannot: a proxy that refuses to upgrade, a captive
 * portal, a corporate network that blocks it outright. Keeping the 3-second timer for
 * exactly those cases costs one `if` and means realtime degrades to what this screen
 * did before rather than to a conversation that silently stops updating.
 *
 * So there are three sources of messages and they all agree:
 *
 *   1. one HTTP load on mount, so the thread renders without waiting on a handshake;
 *   2. `thread:join`, which authorizes, catches up via `since`, and subscribes;
 *   3. `message:new`, pushed to everyone reading the thread.
 *
 * EVERYTHING MERGES BY MESSAGE ID, which is what lets those overlap harmlessly — and
 * they do overlap constantly: the sender receives their own broadcast as well as the
 * acknowledgement, a poll and a push can carry the same row, and `since` is inclusive
 * at its boundary (see `findMessages` on the server). Deduplicating by id is cheaper
 * than making any of those exactly-once, and messages are append-only, so a merge can
 * never need to remove anything.
 *
 * STATE IS KEYED BY `bookingId`, not reset when it changes. This component is not
 * remounted between two conversations — `MessageThreadPage` renders it under one route
 * — so merging into unkeyed state would blend two people's threads together. Keying it
 * also avoids a synchronous `setState` inside an effect, which is the same reason that
 * page keys its own booking.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Alert } from "../ui/Alert.jsx";
import { Button } from "../ui/Button.jsx";
import { Card } from "../ui/Card.jsx";
import { api, ApiError } from "../../lib/api.js";
import { getSocket, request } from "../../lib/socket.js";
import { formatWhen } from "../../lib/dates.js";

/** Only used while the socket is not carrying this thread. */
const POLL_MS = 3000;

/** Matches the server's own cap, so the composer stops before the request is refused. */
const MAX_BODY = 2000;

/**
 * How long after the last keystroke we announce that typing has stopped.
 *
 * Short enough that the indicator does not linger after somebody gives up
 * mid-sentence, long enough that an ordinary pause for thought does not make it
 * flicker off and on again.
 */
const TYPING_IDLE_MS = 3000;

/**
 * How long a received "typing" survives without being renewed.
 *
 * A SAFETY NET, NOT THE MECHANISM. The sender sends an explicit `false`, but cannot
 * if their tab is closed, their laptop sleeps or their connection drops mid-word —
 * and an indicator stuck on forever is worse than no indicator, because it says
 * somebody is about to reply when nobody is there. Longer than the sender's own idle
 * timer, so a live typist is never cleared out from under themselves.
 */
const TYPING_EXPIRY_MS = TYPING_IDLE_MS + 2000;

const EMPTY = { bookingId: null, messages: [], canSend: false, otherParty: null };

/**
 * Combines two sets of messages, keeping one copy of each.
 *
 * Sorted by `created_at` with the id as a tiebreaker: two messages can share a
 * millisecond, and without a second key their order would depend on which source
 * delivered them first — so the same thread could read differently on two screens.
 *
 * @param {object[]} existing
 * @param {object[]} incoming
 * @returns {object[]}
 */
function merge(existing, incoming) {
  if (incoming.length === 0) return existing;

  const byId = new Map(existing.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);

  return [...byId.values()].sort(
    (a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)
  );
}

function MessageBubble({ message, bookingId, mine }) {
  // A system line is neither party's — centred, quiet, and it gives the thread a
  // spine so the conversation reads as the story of the rental.
  if (message.kind === "SYSTEM") {
    return (
      <li className="my-1 text-center">
        <span className="rounded-full bg-raised px-3 py-1 text-xs text-muted">
          {message.body}
        </span>
      </li>
    );
  }

  const shared = message.kind === "CONTACT_SHARED";

  return (
    <li className={`flex ${mine ? "justify-end" : "justify-start"}`}>
      <div
        className={[
          "max-w-[85%] rounded-2xl px-3.5 py-2.5 text-[15px] leading-snug",
          mine ? "bg-accent text-accent-ink" : "bg-raised text-ink",
        ].join(" ")}
      >
        {message.hasAttachment && (
          <img
            // A path on THIS server, never the storage provider. A signed URL is a
            // bearer credential — anyone holding it can fetch the bytes until it
            // expires — so the proxy checks who is asking on every single request.
            src={`/api/bookings/${bookingId}/messages/${message.id}/file`}
            alt="Attachment"
            loading="lazy"
            className="mb-2 max-h-64 rounded-lg object-cover"
          />
        )}

        {shared && (
          // `accent-ink/70` inside your own bubble, never `accent`: that bubble IS the
          // accent, so secondary text on it has to be a dimmed version of the
          // foreground rather than a second use of the fill colour.
          <p className={`text-xs ${mine ? "text-accent-ink/70" : "text-muted"}`}>
            Shared a phone number
          </p>
        )}

        {message.body && (
          <p className={shared ? "font-medium tabular" : "whitespace-pre-wrap break-words"}>
            {message.body}
          </p>
        )}

        <p className={`mt-1 text-[11px] ${mine ? "text-accent-ink/60" : "text-faint"}`}>
          {formatWhen(message.created_at)}
        </p>
      </div>
    </li>
  );
}

/**
 * @param {object} props
 * @param {string} props.bookingId
 * @param {string} props.currentUserId Decides which side a bubble sits on.
 */
export function MessageThread({ bookingId, currentUserId }) {
  const [thread, setThread] = useState(EMPTY);

  // Which thread the socket is currently carrying, rather than a bare boolean. Keyed
  // for the same reason the messages are: navigating to another conversation must not
  // inherit the previous one's subscription, and a key makes that true without a
  // reset step that could be forgotten.
  const [liveFor, setLiveFor] = useState(null);

  const [draft, setDraft] = useState("");
  const [file, setFile] = useState(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);

  /** `{ bookingId, name }` — keyed, like everything else, so it cannot outlive a thread. */
  const [typing, setTyping] = useState(null);

  const bottom = useRef(null);
  const fileInput = useRef(null);

  /** Clears a received typing indicator that was never explicitly cancelled. */
  const typingExpiry = useRef(null);

  /** Whether WE have told the other party we are typing, so we announce it once. */
  const typingSent = useRef(false);

  /** Fires the "stopped typing" announcement after a pause. */
  const typingIdle = useRef(null);

  const { messages, canSend, otherParty } = thread.bookingId === bookingId ? thread : EMPTY;
  const live = liveFor === bookingId;
  const typingName = typing?.bookingId === bookingId ? typing.name : null;

  // A receipt on every message would be noise — the only one anybody looks for is
  // against the newest thing they said, which is the one still waiting on a reply.
  const lastMine = [...messages].reverse().find((message) => message.sender_id === currentUserId);
  const readByOther = Boolean(
    lastMine && otherParty?.readAt && otherParty.readAt >= lastMine.created_at
  );

  /** Folds a whole thread payload — from the HTTP load or from `thread:join` — in. */
  const apply = useCallback(
    (incoming) => {
      setThread((previous) => {
        const same = previous.bookingId === bookingId;

        return {
          bookingId,
          messages: merge(same ? previous.messages : [], incoming.messages ?? []),
          canSend: incoming.canSend,

          // The HTTP load carries no presence — only `thread:join` does — so a poll
          // must keep what is already known rather than blanking it. Without the
          // fallback, the fallback path would erase the other party every 3 seconds.
          otherParty: incoming.otherParty ?? (same ? previous.otherParty : null),
        };
      });
    },
    [bookingId]
  );

  /** Folds in one message — from a push, or from our own send's acknowledgement. */
  const absorb = useCallback(
    (message) => {
      setThread((previous) =>
        previous.bookingId === bookingId
          ? { ...previous, messages: merge(previous.messages, [message]) }
          : previous
      );
    },
    [bookingId]
  );

  const load = useCallback(async () => {
    try {
      apply(await api.get(`/bookings/${bookingId}/messages`));
    } catch {
      // Silent. A poll that cannot reach the server should leave the last thread on
      // screen, not replace a conversation with an error box every three seconds.
    }
  }, [bookingId, apply]);

  // One HTTP load per conversation. Kept even though `thread:join` returns the same
  // thing, because it renders the conversation immediately instead of after a
  // handshake — and it is the only thing that runs at all if the socket never
  // connects.
  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const socket = getSocket();

    // Guards against a reply landing after the component has moved to another
    // conversation, which would mark the wrong thread live.
    let cancelled = false;

    async function join() {
      try {
        const joined = await request("thread:join", { bookingId });
        if (cancelled) return;
        apply(joined);
        setLiveFor(bookingId);
      } catch {
        // Refused or unreachable: stay on the polling path. Not surfaced as an error,
        // because from the reader's point of view nothing is wrong — the conversation
        // is on screen and still updating, just more slowly.
        if (!cancelled) setLiveFor(null);
      }
    }

    function onMessage(payload) {
      // The socket is shared, so this fires for every thread the app is subscribed to.
      if (payload?.bookingId === bookingId) absorb(payload.message);
    }

    /** Patches one field of the other party, leaving the rest of the thread alone. */
    function updateOtherParty(userId, changes) {
      setThread((previous) =>
        previous.bookingId === bookingId && previous.otherParty?.id === userId
          ? { ...previous, otherParty: { ...previous.otherParty, ...changes } }
          : previous
      );
    }

    function onPresence(payload) {
      if (payload?.bookingId !== bookingId) return;

      updateOtherParty(payload.userId, {
        online: payload.online,
        // Only overwritten when one is supplied: an "arrived" event carries none, and
        // taking `undefined` would throw away the last-seen we would need again the
        // moment they leave.
        ...(payload.lastSeenAt ? { lastSeenAt: payload.lastSeenAt } : {}),
      });
    }

    function onRead(payload) {
      if (payload?.bookingId !== bookingId) return;
      updateOtherParty(payload.userId, { readAt: payload.readAt });
    }

    function onTyping(payload) {
      if (payload?.bookingId !== bookingId) return;

      clearTimeout(typingExpiry.current);

      if (!payload.isTyping) {
        setTyping(null);
        return;
      }

      setTyping({ bookingId, name: payload.name });
      typingExpiry.current = setTimeout(() => setTyping(null), TYPING_EXPIRY_MS);
    }

    function onDisconnect() {
      setLiveFor(null);

      // A typing indicator outlives its connection otherwise: the sender's `false`
      // can never arrive over a socket that is gone, so it would sit there claiming
      // somebody is mid-reply until the thread was reopened.
      setTyping(null);
    }

    // `connect` fires on every RECONNECT too, not only the first time — so this is
    // also what re-subscribes after a dropped connection. Socket.IO does not restore
    // rooms itself, and `thread:join` catching up is why it does not have to.
    socket.on("connect", join);
    socket.on("disconnect", onDisconnect);
    socket.on("message:new", onMessage);
    socket.on("presence:changed", onPresence);
    socket.on("thread:read", onRead);
    socket.on("thread:typing", onTyping);

    // Already connected — another screen opened the socket first, so no `connect`
    // event is coming and joining has to be kicked off here.
    if (socket.connected) join();

    return () => {
      cancelled = true;
      clearTimeout(typingExpiry.current);
      socket.emit("thread:leave", { bookingId });
      socket.off("connect", join);
      socket.off("disconnect", onDisconnect);
      socket.off("message:new", onMessage);
      socket.off("presence:changed", onPresence);
      socket.off("thread:read", onRead);
      socket.off("thread:typing", onTyping);
    };
  }, [bookingId, apply, absorb]);

  /**
   * Tells the other party we have read the thread.
   *
   * ONLY WHILE THE TAB IS VISIBLE, which also fixes an older bug rather than just
   * avoiding a new one: the 3-second poll marked the thread read on every pass, so a
   * conversation left open in a BACKGROUND tab reported as read by somebody who was
   * not there. A receipt is a claim about a person, not about a request.
   */
  const reportRead = useCallback(() => {
    if (document.visibilityState !== "visible") return;
    request("thread:read", { bookingId }).catch(() => {});
  }, [bookingId]);

  useEffect(() => {
    if (!live || messages.length === 0) return undefined;

    reportRead();

    // Also when the tab comes BACK, because everything that arrived while it was
    // hidden was deliberately not acknowledged above.
    document.addEventListener("visibilitychange", reportRead);
    return () => document.removeEventListener("visibilitychange", reportRead);
  }, [live, messages.length, reportRead]);

  /** Announces that we are typing, at most once per burst. */
  function signalTyping() {
    if (!live) return;

    if (!typingSent.current) {
      typingSent.current = true;
      getSocket().emit("thread:typing", { bookingId, isTyping: true });
    }

    clearTimeout(typingIdle.current);
    typingIdle.current = setTimeout(stopTyping, TYPING_IDLE_MS);
  }

  /** Announces that we have stopped. Safe to call when we never started. */
  function stopTyping() {
    clearTimeout(typingIdle.current);
    if (!typingSent.current) return;

    typingSent.current = false;
    if (live) getSocket().emit("thread:typing", { bookingId, isTyping: false });
  }

  // The fallback timer exists only while the socket is not carrying this thread — so
  // a live connection means no HTTP traffic at all, and losing it silently restores
  // the old behaviour.
  useEffect(() => {
    if (live) return undefined;

    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [load, live]);

  // Only when the count changes, not on every poll — otherwise a thread somebody is
  // scrolling up through yanks itself back to the bottom every three seconds.
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "nearest" });
  }, [messages.length]);

  async function submit(event) {
    event.preventDefault();
    if (!draft.trim() && !file) return;

    setSending(true);
    setError(null);

    try {
      if (file) {
        // ALWAYS HTTP. Multipart is where the server sniffs the real file type and
        // enforces the size limit; reassembling a file out of socket frames to reach
        // the same checks would be a second upload path to keep honest.
        const form = new FormData();
        form.append("attachment", file);
        if (draft.trim()) form.append("body", draft.trim());
        await api.postForm(`/bookings/${bookingId}/messages`, form);
        await load();
      } else if (live) {
        // Both transports call the same service function on the server, so this is a
        // different route to the identical write — not a second implementation of
        // sending. The broadcast will arrive as well; `absorb` merges by id, so
        // holding both costs nothing.
        const { message } = await request("message:send", { bookingId, body: draft.trim() });
        absorb(message);
      } else {
        await api.post(`/bookings/${bookingId}/messages`, { body: draft.trim() });
        await load();
      }

      setDraft("");
      setFile(null);
      if (fileInput.current) fileInput.current.value = "";

      // Immediately, not after the idle timer: the message has arrived, so leaving
      // "typing" up for another three seconds would show somebody composing the
      // thing the reader is already looking at.
      stopTyping();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not send that.");
    } finally {
      setSending(false);
    }
  }

  async function share() {
    setError(null);
    try {
      await api.post(`/bookings/${bookingId}/messages/share-contact`);
      await load();
    } catch (caught) {
      setError(caught.message);
    }
  }

  return (
    <Card className="flex flex-col p-5 sm:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <h2 className="font-semibold text-ink">Messages</h2>

          {/* Presence, and only between two parties to a booking — never on a
              listing, never in search. Whether somebody is at their phone is a fact
              about them, and sharing a rental is what earns the right to see it. */}
          {otherParty?.online ? (
            <span className="text-xs font-medium text-emerald-600">Online</span>
          ) : (
            otherParty?.lastSeenAt && (
              <span className="text-xs text-faint">
                Last seen {formatWhen(otherParty.lastSeenAt)}
              </span>
            )
          )}
        </div>

        {canSend && (
          <button
            type="button"
            onClick={share}
            className="text-sm font-medium text-accent underline underline-offset-2"
          >
            Share my phone number
          </button>
        )}
      </div>

      {messages.length === 0 ? (
        <p className="mt-3 text-sm leading-relaxed text-muted">
          No messages yet. Ask anything you need to know before you meet.
        </p>
      ) : (
        // A fixed max height with its own scroll, so a long conversation does not
        // push the booking's details and actions off the page.
        <ul className="mt-4 max-h-96 space-y-2 overflow-y-auto pr-1">
          {messages.map((message) => (
            <MessageBubble
              key={message.id}
              message={message}
              bookingId={bookingId}
              mine={message.sender_id === currentUserId}
            />
          ))}
          <li ref={bottom} />
        </ul>
      )}

      {readByOther && <p className="mt-1 text-right text-[11px] text-faint">Read</p>}

      {/* Held in the layout rather than appearing and disappearing: a line that pops
          into existence pushes the composer down under the reader's cursor, which is
          the one place in this screen where a jump costs somebody a click. */}
      <p className="mt-2 h-4 text-xs text-muted" aria-live="polite">
        {typingName ? `${typingName} is typing…` : ""}
      </p>

      {error && (
        <Alert tone="error" className="mt-3">
          {error}
        </Alert>
      )}

      {canSend ? (
        <form onSubmit={submit} className="mt-4 space-y-2">
          <div className="flex items-end gap-2">
            <textarea
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
                signalTyping();
              }}
              onKeyDown={(event) => {
                // Enter sends, Shift+Enter breaks the line — the convention every
                // chat uses, and the reason this is a textarea rather than an input.
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  submit(event);
                }
              }}
              rows={2}
              maxLength={MAX_BODY}
              placeholder="Write a message…"
              aria-label="Write a message"
              className="min-h-[2.75rem] w-full resize-y rounded-xl border border-line bg-raised px-3 py-2 text-[15px] text-ink transition-colors placeholder:text-faint focus:border-accent"
            />

            <Button type="submit" size="sm" loading={sending} className="shrink-0">
              Send
            </Button>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <input
              ref={fileInput}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              aria-label="Attach a photo"
              className="text-sm text-muted file:mr-3 file:rounded-lg file:border-0 file:bg-raised file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-ink-soft hover:file:bg-sunken"
            />
            {file && <span className="text-sm text-muted">{file.name}</span>}
          </div>
        </form>
      ) : (
        <p className="mt-4 rounded-xl bg-raised px-3 py-2.5 text-sm leading-relaxed text-muted">
          This booking is closed, so no new messages can be sent. The conversation
          stays here for both of you to read.
        </p>
      )}
    </Card>
  );
}

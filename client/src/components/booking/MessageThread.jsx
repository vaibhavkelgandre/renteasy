/**
 * The conversation between the two parties to a booking.
 *
 * POLLED, NOT PUSHED, and 3 seconds rather than the bell's 60. There is no
 * WebSocket anywhere in this product and adding one for this would be a second
 * transport to operate, secure and reconnect — plus a pub/sub backplane the moment
 * a second instance exists, because a message published on one would never reach a
 * socket held by the other.
 *
 * Messages here are minutes apart, not seconds: "can I collect at eight?", not a
 * group chat. Twenty requests a minute while a thread is open is nothing, and the
 * `?since=` contract is exactly what an SSE stream would ask on reconnect — so the
 * upgrade, if it is ever wanted, changes the transport and not the API.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Alert } from "../ui/Alert.jsx";
import { Button } from "../ui/Button.jsx";
import { Card } from "../ui/Card.jsx";
import { api, ApiError } from "../../lib/api.js";
import { formatWhen } from "../../lib/dates.js";

const POLL_MS = 3000;

/** Matches the server's own cap, so the composer stops before the request is refused. */
const MAX_BODY = 2000;

function MessageBubble({ message, bookingId, mine }) {
  // A system line is neither party's — centred, quiet, and it gives the thread a
  // spine so the conversation reads as the story of the rental.
  if (message.kind === "SYSTEM") {
    return (
      <li className="my-1 text-center">
        <span className="rounded-full bg-stone-100 px-3 py-1 text-xs text-stone-500">
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
          mine ? "bg-brand-600 text-white" : "bg-stone-100 text-stone-900",
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
          <p className={`text-xs ${mine ? "text-brand-100" : "text-stone-500"}`}>
            Shared a phone number
          </p>
        )}

        {message.body && (
          <p className={shared ? "font-medium tabular" : "whitespace-pre-wrap break-words"}>
            {message.body}
          </p>
        )}

        <p className={`mt-1 text-[11px] ${mine ? "text-brand-100" : "text-stone-500"}`}>
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
  const [messages, setMessages] = useState([]);
  const [canSend, setCanSend] = useState(false);
  const [draft, setDraft] = useState("");
  const [file, setFile] = useState(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);

  const bottom = useRef(null);
  const fileInput = useRef(null);

  const load = useCallback(async () => {
    try {
      const data = await api.get(`/bookings/${bookingId}/messages`);
      setMessages(data.messages ?? []);
      setCanSend(data.canSend);
    } catch {
      // Silent. A poll that cannot reach the server should leave the last thread on
      // screen, not replace a conversation with an error box every three seconds.
    }
  }, [bookingId]);

  useEffect(() => {
    load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

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
        const form = new FormData();
        form.append("attachment", file);
        if (draft.trim()) form.append("body", draft.trim());
        await api.postForm(`/bookings/${bookingId}/messages`, form);
      } else {
        await api.post(`/bookings/${bookingId}/messages`, { body: draft.trim() });
      }

      setDraft("");
      setFile(null);
      if (fileInput.current) fileInput.current.value = "";
      await load();
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
        <h2 className="font-semibold text-stone-900">Messages</h2>
        {canSend && (
          <button
            type="button"
            onClick={share}
            className="text-sm font-medium text-brand-700 underline underline-offset-2"
          >
            Share my phone number
          </button>
        )}
      </div>

      {messages.length === 0 ? (
        <p className="mt-3 text-sm leading-relaxed text-stone-600">
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
              onChange={(event) => setDraft(event.target.value)}
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
              className="min-h-[2.75rem] w-full resize-y rounded-xl border border-stone-300 bg-white px-3 py-2 text-[15px] text-stone-900 placeholder:text-stone-400 focus:border-brand-600"
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
              className="text-sm text-stone-600 file:mr-3 file:rounded-lg file:border-0 file:bg-stone-100 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-stone-700 hover:file:bg-stone-200"
            />
            {file && <span className="text-sm text-stone-500">{file.name}</span>}
          </div>
        </form>
      ) : (
        <p className="mt-4 rounded-xl bg-stone-50 px-3 py-2.5 text-sm leading-relaxed text-stone-600">
          This booking is closed, so no new messages can be sent. The conversation
          stays here for both of you to read.
        </p>
      )}
    </Card>
  );
}

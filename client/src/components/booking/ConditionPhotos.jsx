/**
 * Condition photos on a booking — FR-702.
 *
 * OPTIONAL, AND THE UI HAS TO SAY SO WITHOUT NAGGING. A handover happens in a car
 * park with one bar of signal, so a required upload would block the thing it exists
 * to record. What it does instead is state plainly when a phase has none — "No photos
 * were taken" is a fact both parties can see, and is itself the argument for taking
 * some next time.
 *
 * EITHER PARTY UPLOADS, AT EITHER END, and that is adversarial by design: a scratch
 * is worth photographing by whichever side thinks it helps them. A record only one
 * party can contribute to is not a record.
 *
 * Every image is fetched from a path on this API, never from the provider. These are
 * private assets — the server mints a short-lived signed URL per request and streams
 * the bytes through itself, so no credential ever reaches the browser.
 */

import { useState } from "react";
import { Alert } from "../ui/Alert.jsx";
import { Card } from "../ui/Card.jsx";
import { api, ApiError } from "../../lib/api.js";
import { formatWhen } from "../../lib/dates.js";

/** Which phases may be photographed from which booking states — mirrors the service. */
const OPEN_PHASES = {
  HANDOVER: ["ACCEPTED", "HANDED_OVER", "ACTIVE"],
  RETURN: ["ACTIVE", "HANDED_OVER", "RETURNED"],
};

const PHASE_LABEL = { HANDOVER: "At handover", RETURN: "On return" };

function PhotoGrid({ photos }) {
  return (
    <ul className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
      {photos.map((photo) => (
        <li key={photo.id}>
          <a
            href={photo.url}
            target="_blank"
            rel="noreferrer"
            className="group block overflow-hidden rounded-xl border border-stone-200"
          >
            <img
              src={photo.url}
              // The note if there is one, because that is what the uploader actually
              // said about this image. Falls back to who took it, which is never
              // nothing — a photo with an empty alt in an evidence list is the one
              // place a screen reader user is left guessing.
              alt={photo.note || `Photo by ${photo.uploadedByName ?? "a former account"}`}
              loading="lazy"
              className="aspect-[4/3] w-full object-cover transition-transform duration-300 group-hover:scale-105"
            />
          </a>

          <p className="mt-1 truncate text-xs text-stone-500">
            {photo.uploadedByName ?? "Deleted account"} · {formatWhen(photo.createdAt)}
          </p>
          {photo.note && <p className="mt-0.5 text-xs text-stone-700">{photo.note}</p>}
        </li>
      ))}
    </ul>
  );
}

function PhaseSection({ phase, photos, bookingStatus, bookingId, onAdded }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [note, setNote] = useState("");

  const open = OPEN_PHASES[phase].includes(bookingStatus);

  async function upload(event) {
    const files = [...event.target.files];
    // Clearing the input lets the same file be chosen twice running, which otherwise
    // fires no change event and looks like the button stopped working.
    event.target.value = "";
    if (files.length === 0) return;

    setBusy(true);
    setError(null);

    try {
      const body = new FormData();
      body.append("phase", phase);
      if (note.trim()) body.append("note", note.trim());
      for (const file of files) body.append("photos", file);

      await api.postForm(`/bookings/${bookingId}/photos`, body);
      setNote("");
      onAdded();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "That upload did not work.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="border-t border-stone-200 pt-4 first:border-t-0 first:pt-0">
      <h3 className="text-sm font-semibold text-stone-900">{PHASE_LABEL[phase]}</h3>

      {photos.length > 0 ? (
        <PhotoGrid photos={photos} />
      ) : (
        <p className="mt-1 text-sm leading-snug text-stone-500">
          {open
            ? "No photos yet. Worth a couple before it changes hands."
            : "No photos were taken."}
        </p>
      )}

      {open && (
        <div className="mt-3 space-y-2">
          <input
            type="text"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Note (optional) — e.g. scratch on the lens barrel"
            aria-label={`Note for ${PHASE_LABEL[phase].toLowerCase()} photos`}
            maxLength={500}
            className="h-10 w-full rounded-lg border border-stone-300 bg-white px-3 text-sm text-stone-900 placeholder:text-stone-400"
          />

          {/* A label wrapping a hidden input, rather than a button that clicks one
              through a ref: it is the same control to a keyboard and to assistive
              tech, with no JavaScript in the middle to get wrong. */}
          <label className="inline-block">
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              multiple
              onChange={upload}
              disabled={busy}
              className="sr-only"
            />
            <span
              className={[
                "inline-flex h-9 cursor-pointer items-center rounded-xl border border-stone-300 bg-white px-3 text-sm font-medium text-stone-800 shadow-sm transition-all",
                busy ? "cursor-wait opacity-60" : "hover:border-stone-400 hover:bg-stone-50",
              ].join(" ")}
            >
              {busy ? "Uploading…" : "Add photos"}
            </span>
          </label>
        </div>
      )}

      {error && (
        <Alert tone="error" className="mt-2">
          {error}
        </Alert>
      )}
    </section>
  );
}

/**
 * @param {object} props
 * @param {string} props.bookingId
 * @param {string} props.bookingStatus
 * @param {object[]} props.photos
 * @param {() => void} props.onChanged Refetches; the parent owns the data.
 */
export function ConditionPhotos({ bookingId, bookingStatus, photos = [], onChanged }) {
  // Defaulted rather than assumed. This is one panel on a page whose real subject is
  // the booking, and a malformed photo response must cost the panel, not the screen.
  const all = Array.isArray(photos) ? photos : [];

  // Nothing to show and nothing to add: before a booking is accepted there is no
  // handover to photograph, and an empty panel would only ask a question the reader
  // cannot yet answer.
  const anyOpen = Object.values(OPEN_PHASES).some((states) => states.includes(bookingStatus));
  if (!anyOpen && all.length === 0) return null;

  return (
    <Card className="p-5">
      <h2 className="font-semibold text-stone-900">Condition</h2>
      <p className="mt-0.5 text-sm leading-snug text-stone-600">
        Optional, and visible only to the two of you.
      </p>

      <div className="mt-4 space-y-4">
        {["HANDOVER", "RETURN"].map((phase) => (
          <PhaseSection
            key={phase}
            phase={phase}
            bookingId={bookingId}
            bookingStatus={bookingStatus}
            photos={all.filter((photo) => photo.phase === phase)}
            onAdded={onChanged}
          />
        ))}
      </div>
    </Card>
  );
}

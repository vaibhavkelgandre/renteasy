/**
 * A labelled input, and a labelled checkbox.
 *
 * Bundling the label WITH the control is the point. A bare `<input>` leaves every
 * caller to wire up `htmlFor`/`id` themselves, and the one that forgets ships a field
 * a screen reader cannot name — a defect nobody catches in review.
 */

import { useId } from "react";

/**
 * @param {object} props
 * @param {string} props.label Required. An unlabelled field is a bug.
 * @param {string} [props.error] Straight from the API's `errors` map.
 * @param {string} [props.hint] Hidden while an error is showing.
 * @param {boolean} [props.optional] Marks the field optional in the label.
 * @param {string} [props.type="text"]
 */
export function Field({ label, error, hint, optional, type = "text", className = "", ...rest }) {
  // useId, not a hand-passed prop: two instances of the same field on one page would
  // otherwise share an id, and clicking one label would focus the other.
  const id = useId();
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;

  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1.5 flex items-baseline gap-2 text-sm font-medium text-stone-700">
        {label}
        {/* Marking what is OPTIONAL rather than what is required. On a signup form
            where all but one field is mandatory, asterisks everywhere are noise — and
            people abandon forms that look longer than they are. */}
        {optional && <span className="text-xs font-normal text-stone-400">optional</span>}
      </label>

      <input
        id={id}
        type={type}
        aria-invalid={error ? true : undefined}
        // Links the message to the input so it is announced on focus, rather than
        // sitting nearby as text nobody encounters.
        aria-describedby={describedBy}
        className={[
          "h-12 w-full rounded-xl border bg-white px-4 text-[15px] text-stone-900",
          "placeholder:text-stone-400 transition-colors",
          // Colour is a SECOND signal, never the only one: the message below carries
          // the meaning, so this still works for a colour-blind user.
          error
            ? "border-rose-400 focus:border-rose-500"
            : "border-stone-300 focus:border-brand-600",
          "disabled:bg-stone-100 disabled:text-stone-500",
        ].join(" ")}
        {...rest}
      />

      {error && (
        <p id={`${id}-error`} className="mt-1.5 text-sm text-rose-600">
          {error}
        </p>
      )}
      {/* The hint hides while an error shows — two messages under one box is noise,
          and the error is the one that needs reading. */}
      {hint && !error && (
        <p id={`${id}-hint`} className="mt-1.5 text-sm text-stone-500">
          {hint}
        </p>
      )}
    </div>
  );
}

/**
 * A labelled checkbox. Used for terms acceptance, which is the one field on this form
 * with legal weight.
 *
 * @param {object} props
 * @param {React.ReactNode} props.label Accepts nodes, so the terms link can live inside it.
 * @param {string} [props.error]
 */
export function Checkbox({ label, error, className = "", ...rest }) {
  const id = useId();

  return (
    <div className={className}>
      <div className="flex items-start gap-3">
        <input
          id={id}
          type="checkbox"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          // size-5 rather than the browser default ~13px. A checkbox that carries a
          // legal agreement should not be the hardest thing on the page to hit.
          className={[
            "mt-0.5 size-5 shrink-0 rounded border-stone-300 text-brand-600",
            "focus:ring-brand-600",
            error ? "border-rose-400" : "",
          ].join(" ")}
          {...rest}
        />
        <label htmlFor={id} className="text-sm leading-relaxed text-stone-600">
          {label}
        </label>
      </div>

      {error && (
        <p id={`${id}-error`} className="mt-1.5 text-sm text-rose-600">
          {error}
        </p>
      )}
    </div>
  );
}

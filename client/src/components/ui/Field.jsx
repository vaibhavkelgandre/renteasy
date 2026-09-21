/**
 * A labelled input, and a labelled checkbox.
 *
 * Bundling the label WITH the control is the point. A bare `<input>` leaves every
 * caller to wire up `htmlFor`/`id` themselves, and the one that forgets ships a field
 * a screen reader cannot name — a defect nobody catches in review.
 *
 * THE FIELD IS A WELL, NOT A BOX. On a dark interface an input drawn as a bordered
 * rectangle the same colour as its surroundings is invisible; one drawn a step DARKER
 * than the panel it sits in reads as somewhere you put something. `bg-raised` on
 * `surface` is that step, and the border only sharpens the edge.
 */

import { useId } from "react";

/**
 * The shared shape of every text control in the app — the field below, the search
 * box, the filter inputs, the message composer. Exported because those live in other
 * files and a second copy of this string is how two inputs end up different heights.
 */
export const INPUT_CLASSES =
  "w-full rounded-xl border bg-raised px-4 text-[15px] text-ink " +
  "placeholder:text-faint transition-colors";

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
      <label htmlFor={id} className="mb-1.5 flex items-baseline gap-2 text-sm font-medium text-ink-soft">
        {label}
        {/* Marking what is OPTIONAL rather than what is required. On a signup form
            where all but one field is mandatory, asterisks everywhere are noise — and
            people abandon forms that look longer than they are. */}
        {optional && <span className="text-xs font-normal text-faint">optional</span>}
      </label>

      <input
        id={id}
        type={type}
        aria-invalid={error ? true : undefined}
        // Links the message to the input so it is announced on focus, rather than
        // sitting nearby as text nobody encounters.
        aria-describedby={describedBy}
        className={[
          INPUT_CLASSES,
          "h-12",
          // Colour is a SECOND signal, never the only one: the message below carries
          // the meaning, so this still works for a colour-blind reader.
          error
            ? "border-bad/60 focus:border-bad"
            : "border-line focus:border-accent",
          "disabled:bg-surface disabled:text-faint",
        ].join(" ")}
        {...rest}
      />

      {error && (
        <p id={`${id}-error`} className="mt-1.5 text-sm text-bad">
          {error}
        </p>
      )}
      {/* The hint hides while an error shows — two messages under one box is noise,
          and the error is the one that needs reading. */}
      {hint && !error && (
        <p id={`${id}-hint`} className="mt-1.5 text-sm text-muted">
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
          // size-5 rather than the browser default ~13px. A checkbox carrying a legal
          // agreement should not be the hardest thing on the page to hit.
          //
          // `accent-accent` is not a typo: the CSS property is `accent-color`, and it
          // is what tints the browser's own checked state. Without it a checked box
          // is the operating system's blue, which belongs to no palette here.
          className={[
            "mt-0.5 size-5 shrink-0 rounded border-line-strong bg-raised accent-accent",
            error ? "border-bad/60" : "",
          ].join(" ")}
          {...rest}
        />
        <label htmlFor={id} className="text-sm leading-relaxed text-muted">
          {label}
        </label>
      </div>

      {error && (
        <p id={`${id}-error`} className="mt-1.5 text-sm text-bad">
          {error}
        </p>
      )}
    </div>
  );
}

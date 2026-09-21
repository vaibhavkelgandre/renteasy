/**
 * A panel on the canvas.
 *
 * THE BRIEF FOR THIS COMPONENT CHANGED, and the change is the point: a card is now a
 * hairline and a half-step of lift, not a floating white slab. The old version was a
 * rounded-2xl white box with a real shadow, which is fine once on a page and reads as
 * "AI template" six times on a page — because every section then announces itself as a
 * separate object and nothing looks composed.
 *
 * On a dark ground the border does almost all the work. `surface` against `canvas` is
 * a 4% step, which the eye reads as depth on its own; the border only gives it an
 * edge. There is no drop shadow at rest, because a shadow needs light to fall from
 * somewhere and on near-black it just produces a dirty halo.
 *
 * USE IT FOR A CONTAINER THAT HOLDS SOMETHING, not to fence off every heading. Where
 * a group of facts needs separating from the group above it, a divider or a heading
 * is the lighter answer and usually the better one.
 */

/**
 * @param {object} props
 * @param {boolean} [props.interactive=false] For a card that is itself a link or a
 *        button. Adds the hover treatment — opt-in rather than automatic, because a
 *        panel that lifts when the pointer crosses it while doing nothing when
 *        clicked is a promise the card does not keep.
 * @param {React.ReactNode} props.children
 */
export function Card({ interactive = false, className = "", children, ...rest }) {
  return (
    <div
      className={[
        "rounded-2xl border border-line bg-surface",
        interactive
          ? // The accent appears only on the border, never as a fill. A tinted panel
            // on hover is the thing that makes a dark interface look like a toy; a
            // warming edge reads as the object catching the light.
            "transition-[border-color,transform,box-shadow] duration-200 " +
            "hover:-translate-y-0.5 hover:border-line-strong hover:shadow-lg hover:shadow-black/40"
          : "",
        className,
      ].join(" ")}
      {...rest}
    >
      {children}
    </div>
  );
}

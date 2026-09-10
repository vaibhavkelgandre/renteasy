/**
 * A white panel on the warm ground.
 *
 * Rounded generously and shadowed rather than hard-bordered: a consumer marketplace
 * shows a grid of desirable objects, and soft cards read as product tiles while a thin
 * border reads as a data table. No default padding - pass it via className.
 */

/**
 * @param {object} props
 * @param {boolean} [props.interactive=false] For a card that is itself a link or a
 *        button. Adds the hover lift — and it is opt-in rather than automatic
 *        because a panel that rises when the pointer crosses it, while doing
 *        nothing when clicked, is a promise the card does not keep.
 * @param {React.ReactNode} props.children
 */
export function Card({ interactive = false, className = "", children, ...rest }) {
  return (
    <div
      className={[
        "rounded-2xl border border-stone-200/80 bg-white shadow-sm",
        interactive
          ? "transition-all duration-200 hover:-translate-y-0.5 hover:border-stone-300 hover:shadow-lg hover:shadow-stone-900/5"
          : "",
        className,
      ].join(" ")}
      {...rest}
    >
      {children}
    </div>
  );
}

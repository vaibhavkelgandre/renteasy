/**
 * A white panel on the warm ground.
 *
 * Rounded generously and shadowed rather than hard-bordered: a consumer marketplace
 * shows a grid of desirable objects, and soft cards read as product tiles while a thin
 * border reads as a data table. No default padding - pass it via className.
 */

/**
 * @param {object} props
 * @param {React.ReactNode} props.children
 */
export function Card({ className = "", children, ...rest }) {
  return (
    <div
      className={["rounded-2xl border border-stone-200/80 bg-white shadow-sm", className].join(" ")}
      {...rest}
    >
      {children}
    </div>
  );
}

/**
 * "How it works" — three static steps, home page only.
 *
 * NO PROPS, NO DATA. This is pure copy explaining the shape of the product, so unlike
 * the hero's listing count or the category tiles, there is nothing here that can go
 * stale or fail to load.
 */

const STEPS = [
  {
    title: "Find something nearby",
    body: "Search by what you need and where you are — a camera, a drill, a bike — from people a few streets away.",
    icon: (
      <>
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" />
      </>
    ),
  },
  {
    title: "Reserve your dates",
    body: "Pick the days you need it and send a request. Nothing is charged until the owner accepts.",
    icon: (
      <>
        <rect x="4" y="5" width="16" height="15" rx="2" />
        <path d="M8 3v4M16 3v4M4 10h16" />
      </>
    ),
  },
  {
    title: "Pick it up, hand it back",
    body: "Message the owner to arrange handover, use it for as long as you booked, then return it — that's it.",
    icon: (
      <>
        <path d="M4 12a8 8 0 0 1 14.5-4.5M20 12a8 8 0 0 1-14.5 4.5" />
        <path d="M18.5 3v4.5H14M5.5 21v-4.5H10" />
      </>
    ),
  },
];

export function HowItWorksSection() {
  return (
    <section aria-labelledby="how-it-works" className="border-t border-line py-12">
      <h2
        id="how-it-works"
        className="mb-6 text-sm font-semibold uppercase tracking-[0.08em] text-muted"
      >
        How it works
      </h2>

      <ol className="grid gap-8 sm:grid-cols-3 sm:gap-6">
        {STEPS.map((step, index) => (
          <li key={step.title} className="flex flex-col gap-3">
            <div className="flex items-center gap-3">
              <span className="grid size-11 shrink-0 place-items-center rounded-xl border border-line bg-raised text-accent">
                <svg
                  className="size-6"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.75"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  {step.icon}
                </svg>
              </span>
              {/* The step number is decoration on top of the icon, not the only cue —
                  a screen reader already gets the order for free from `<ol>`. */}
              <span className="font-mono text-sm tabular text-faint" aria-hidden="true">
                {String(index + 1).padStart(2, "0")}
              </span>
              <h3 className="font-semibold text-ink">{step.title}</h3>
            </div>

            <p className="text-center leading-relaxed text-muted">{step.body}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

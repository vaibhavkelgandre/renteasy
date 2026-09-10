/**
 * The site header.
 *
 * LIGHT, NOT DARK, and that is the opposite choice from an internal tool. A dark app
 * bar says "you are inside a system"; a marketplace wants the opposite — the page
 * should feel like a shop window, and the chrome should get out of the way of the
 * things being rented.
 *
 * It renders for signed-out visitors too, because browsing needs no account. That is
 * why the right-hand side branches rather than assuming a user.
 *
 * WHAT WAS WRONG WITH THE FIRST VERSION, since "the nav doesn't look good" was the
 * specific complaint: it had no navigation in it. Signed out it was a logo and two
 * buttons; signed in it was a logo, one ghost button reading "Browse", and an avatar.
 * So the header never said where you were or what else there was, and two items
 * floating at opposite ends of 1440px read as unfinished rather than as minimal.
 */

import { Link, NavLink } from "react-router-dom";
import { Logo } from "../Logo.jsx";
import { Button } from "../ui/Button.jsx";
import { useAuth } from "../../context/AuthContext.jsx";
import { AccountMenu } from "./AccountMenu.jsx";

/**
 * The signed-in destinations.
 *
 * `end` on Browse because its path is `/`, which every other route also starts with
 * — without it NavLink marks it active everywhere and the highlight stops meaning
 * anything.
 */
const NAV = [
  { to: "/", label: "Browse", end: true },
  { to: "/listings/mine", label: "Your listings" },
  { to: "/bookings", label: "Bookings" },
];

/**
 * One nav destination.
 *
 * A PILL, not an underline. The current page has to be obvious at a glance on a light
 * bar, and an underline under a 15px label at the top of a busy page is not — a
 * filled pill is legible in peripheral vision, which is all a nav ever gets.
 */
function NavItem({ to, label, end }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        [
          "rounded-lg px-3 py-1.5 text-[15px] font-medium transition-colors",
          isActive
            ? "bg-white text-stone-900 shadow-sm"
            : "text-stone-600 hover:bg-white/70 hover:text-stone-900",
        ].join(" ")
      }
    >
      {label}
    </NavLink>
  );
}

export function Header() {
  // `logout` lives in AccountMenu now, so this only needs to know IF there is a user.
  const { user } = useAuth();

  return (
    // Sticky, with a translucent background: scrolling a long grid of listings should
    // never lose the way out, and the blur keeps it feeling light rather than like a
    // solid bar clamped over the content. Deliberately not a solid fill — content
    // moving faintly beneath a sticky bar is what stops it looking pasted on.
    <header className="sticky top-0 z-40 border-b border-stone-200/70 bg-stone-50/80 backdrop-blur-lg">
      <div className="mx-auto flex h-16 max-w-content items-center gap-3 px-5 lg:px-8">
        <Link to="/" aria-label="RentEasy home" className="shrink-0">
          <Logo size="sm" />
        </Link>

        {user && (
          // Hidden below `md`, where three pills plus a CTA plus an avatar do not fit.
          // Every route stays reachable from the page itself and from the account
          // menu; a nav that wraps onto a second line is worse than one that waits.
          //
          // The tinted trough is what makes the active pill read as *selected* rather
          // than as merely a white box — it needs something to sit on.
          <nav
            aria-label="Main"
            className="ml-2 hidden items-center gap-1 rounded-xl bg-stone-200/50 p-1 md:flex"
          >
            {NAV.map((item) => (
              <NavItem key={item.to} {...item} />
            ))}
          </nav>
        )}

        {/* Pushes the account cluster to the right. A spacer rather than
            `justify-between` on the row, which would fight the nav for position now
            that there is something in the middle. */}
        <div className="flex-1" />

        <div className="flex items-center gap-2">
          {user ? (
            <>
              {/* THE PRIMARY ACTION, and it is the supply side. On a two-sided
                  marketplace the scarce side is people willing to lend, so listing is
                  what earns a filled button on every page. */}
              <Button as={Link} to="/listings/new" size="sm" className="hidden sm:inline-flex">
                List an item
              </Button>
              {/* ONE control for the account, not two. "Account" and "Sign out" used to
                  sit side by side, which spent twice the width of a phone header on
                  something used rarely - and left a destructive action one stray tap
                  away on every page. Both now live behind the initials. */}
              <AccountMenu />
            </>
          ) : (
            <>
              <Button as={Link} to="/login" variant="ghost" size="sm">
                Sign in
              </Button>
              {/* Same reasoning as "List an item": the wording leans toward supply
                  rather than a neutral "Sign up". */}
              <Button as={Link} to="/register" size="sm">
                Get started
              </Button>
            </>
          )}
        </div>
      </div>
    </header>
  );
}

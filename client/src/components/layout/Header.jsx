/**
 * The site header.
 *
 * DARK NOW, WHICH REVERSES THIS FILE'S ORIGINAL ARGUMENT. It used to say a light bar
 * was the opposite choice from an internal tool — that a dark app bar means "you are
 * inside a system" while a marketplace wants a shop window. That reasoning holds for a
 * dark bar over a LIGHT page, which is the arrangement it was arguing against. Here
 * the whole product is dark, so the bar is not a band across the top of anything: it
 * is the same surface as the page, separated by one hairline. What was true stays
 * true — the chrome gets out of the way of the things being rented — it is just
 * achieved by disappearing rather than by being pale.
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
import { SearchBox } from "./SearchBox.jsx";
import { NotificationBell } from "./NotificationBell.jsx";
import { useUnreadMessages } from "../../hooks/useUnreadMessages.js";

/**
 * The signed-in destinations.
 *
 * `end` on Browse because its path is `/`, which every other route also starts with
 * — without it NavLink marks it active everywhere and the highlight stops meaning
 * anything.
 */
const NAV = [
  { to: "/", label: "Browse", end: true },
  // "Listings", not "Your listings". A fourth pill arrived with messaging and the row
  // does not have room for the longer label — measured at `lg`, where the logo,
  // search, pills, CTA and avatar are already close. The possessive was doing no work
  // that the nav's context does not already supply.
  { to: "/listings/mine", label: "Listings" },
  { to: "/bookings", label: "Bookings" },
  { to: "/messages", label: "Messages", badge: "messages" },
];

/**
 * One nav destination.
 *
 * AN UNDERLINE, NOT A PILL — the opposite of the light build, and for a reason that
 * only applies on a dark ground. A filled pill needs a tinted trough behind the whole
 * nav to read as *selected* rather than as merely a box, and a trough plus five pills
 * is five rectangles of chrome in a bar whose job is to disappear. On near-black a 2px
 * accent rule under the active label is unmissable in peripheral vision and costs no
 * area at all.
 *
 * The rule is positioned against the header's own bottom border so it reads as the
 * tab being attached to the page below it.
 */
function NavItem({ to, label, end, unread = 0 }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        [
          "relative flex h-16 items-center px-3 text-[15px] font-medium transition-colors",
          // The pseudo-element is the indicator. `scale-x` rather than width so it
          // grows from the centre, and `origin-center` so it does not slide.
          "after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full",
          "after:origin-center after:transition-transform after:duration-200",
          isActive
            ? "text-ink after:scale-x-100 after:bg-accent"
            : "text-muted hover:text-ink after:scale-x-0 after:bg-line-strong hover:after:scale-x-100",
        ].join(" ")
      }
    >
      {label}
      {unread > 0 && (
        // A DOT, not a number. The bell already carries a count, and two counting
        // badges in one bar invites reading them as one figure. This only has to say
        // "something is waiting" — the inbox itself says how much.
        <span
          aria-label={`${unread} unread`}
          className="ml-1.5 size-1.5 rounded-full bg-accent"
        />
      )}
    </NavLink>
  );
}

export function Header() {
  // `logout` lives in AccountMenu now, so this only needs to know IF there is a user.
  const { user } = useAuth();
  const unreadMessages = useUnreadMessages(Boolean(user));

  return (
    // Sticky, translucent, blurred. Scrolling a long grid of listings should never
    // lose the way out, and content moving faintly beneath the bar is what stops it
    // looking pasted on. On a dark palette the blur matters MORE than it did on the
    // light one: a solid near-black bar over a near-black page is invisible as an
    // object, so the only thing telling you it is there is the photography sliding
    // under it.
    <header className="sticky top-0 z-40 border-b border-line bg-canvas/80 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-content items-center gap-3 px-5 lg:px-8">
        <Link to="/" aria-label="RentEasy home" className="shrink-0">
          {/* The mark alone below `sm`. The wordmark is ~90px, which on a 375px screen
              is most of what the search bar needs — and the mark still identifies the
              site and still goes home. */}
          <Logo size="sm" wordmarkClassName="hidden sm:inline" />
        </Link>

        {/* THE SEARCH BAR, in the header rather than in the browse hero so the grid
            gets that vertical space back. It works from every page, which it did not
            before: searching from a booking meant navigating to browse first.

            CAPPED at `max-w-lg`, and the cap is what creates the gap to its right.
            Left to `flex-1` alone the form grows until it touches the nav, so the
            Search button and the first destination sit against each other and read as
            one crowded cluster. Wider than the old `max-w-md` because the bar now
            holds two segments instead of one. */}
        <SearchBox className="max-w-lg" />

        {/* ONE right-hand group, and `ml-auto` on it rather than on the nav and the
            actions separately — with it on both, the slack splits between them and the
            nav drifts into the middle of the bar as the window widens. */}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {user && (
            // `lg`, not `md`. Measured: at 768px the logo, search, four destinations,
            // the CTA and the avatar want ~806px in a 728px row. Something has to
            // give, and the nav is the one whose destinations are all reachable from
            // the pages themselves, whereas the search bar is reachable from nowhere
            // else. A nav that wraps onto a second line is worse than one that waits
            // for the room.
            //
            // `self-stretch` so each item is the full 64px of the bar — that is what
            // lets the active indicator sit on the header's own bottom edge.
            <nav aria-label="Main" className="hidden self-stretch lg:flex">
              {NAV.map((item) => (
                <NavItem
                  key={item.to}
                  {...item}
                  unread={item.badge === "messages" ? unreadMessages : 0}
                />
              ))}
            </nav>
          )}

          <div className="flex items-center gap-2 pl-1">
            {user ? (
              <>
                {/* The bell is a thing that happens TO you, so it belongs with the
                    account cluster rather than among the destinations — and it stays
                    visible at every width, unlike "List an item", because missing a
                    booking request is worse than having to hunt for the button that
                    makes a listing. */}
                <NotificationBell />

                {/* THE PRIMARY ACTION, and it is the supply side. On a two-sided
                    marketplace the scarce side is people willing to lend, so listing
                    is what earns the one filled button on every page. */}
                <Button as={Link} to="/listings/new" size="sm" className="hidden sm:inline-flex">
                  List an item
                </Button>

                {/* ONE control for the account, not two. "Account" and "Sign out" used
                    to sit side by side, which spent twice the width of a phone header
                    on something used rarely — and left a destructive action one stray
                    tap away on every page. Both live behind the initials. */}
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
      </div>
    </header>
  );
}

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
 */

import { Link } from "react-router-dom";
import { Logo } from "../Logo.jsx";
import { Button } from "../ui/Button.jsx";
import { useAuth } from "../../context/AuthContext.jsx";
import { AccountMenu } from "./AccountMenu.jsx";

export function Header() {
  // `logout` lives in AccountMenu now, so this only needs to know IF there is a user.
  const { user } = useAuth();

  return (
    // Sticky, with a translucent background: scrolling a long grid of listings should
    // never lose the way out, and the blur keeps it feeling light rather than like a
    // solid bar clamped over the content.
    <header className="sticky top-0 z-40 border-b border-stone-200/80 bg-stone-50/90 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-content items-center justify-between gap-4 px-5 lg:px-8">
        <Link to="/" aria-label="RentEasy home">
          <Logo size="sm" />
        </Link>

        <div className="flex items-center gap-2">
          {user ? (
            <>
              <Button as={Link} to="/" variant="ghost" size="sm">
                Browse
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
              {/* The primary action for a visitor. On a two-sided marketplace the
                  scarce side is supply, so the wording leans toward listing rather
                  than a neutral "Sign up". */}
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

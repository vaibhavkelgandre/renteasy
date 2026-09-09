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

export function Header() {
  const { user, logout } = useAuth();

  return (
    // Sticky, with a translucent background: scrolling a long grid of listings should
    // never lose the way out, and the blur keeps it feeling light rather than like a
    // solid bar clamped over the content.
    <header className="sticky top-0 z-40 border-b border-stone-200/80 bg-stone-50/90 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-5">
        <Link to="/" aria-label="RentEasy home">
          <Logo size="sm" />
        </Link>

        <div className="flex items-center gap-2">
          {user ? (
            <>
              {/* The name is not shown — it eats width on a phone and says nothing
                  useful. The email is what confirms WHICH account you are in, which
                  matters on a shared device, and it lives on the account page. */}
              <Button as={Link} to="/" variant="ghost" size="sm">
                Browse
              </Button>
              {/* The only way into the account page. Labelled "Account" rather than
                  showing the name or email: the name eats width on a phone, and the
                  email is exactly the thing that should not be sitting in the chrome of
                  every page on a shared screen. It is on the account page itself, which
                  is where someone goes to check WHICH account they are in. */}
              <Button as={Link} to="/profile" variant="ghost" size="sm">
                Account
              </Button>
              <Button variant="outline" size="sm" onClick={logout}>
                Sign out
              </Button>
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

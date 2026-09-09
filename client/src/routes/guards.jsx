/**
 * Route guards.
 *
 * NEITHER OF THESE IS SECURITY. They stop someone seeing a page that would be empty or
 * broken; the server refuses every unauthorised request regardless. A hidden route is
 * not a permission - anyone can edit a URL.
 *
 * Note what is absent: there is no role guard. This is a marketplace, so "may I do
 * this?" is a question about a RELATIONSHIP to a record ("am I this listing's owner?"),
 * answered server-side next to the data. What DOES exist is a verification guard,
 * because that is a property of the person rather than of a record.
 */

import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";
import { Logo } from "../components/Logo.jsx";

/**
 * Shown while the session is still unknown.
 *
 * WHY IT EXISTS: on a hard refresh /auth/me has not answered yet, so we cannot tell a
 * signed-in visitor from a signed-out one. Rendering either outcome early is wrong -
 * guess "signed out" and an authenticated user is bounced to sign-in and back, which
 * flashes visibly and can lose their place.
 */
function SessionLoading() {
  return (
    <div className="grid min-h-full place-items-center bg-stone-50">
      <div className="animate-pulse">
        <Logo />
      </div>
      {/* Announced, not merely drawn - a pulsing logo tells a screen reader nothing. */}
      <span className="sr-only" role="status">
        Loading
      </span>
    </div>
  );
}

/**
 * Renders child routes only for a signed-in user, verified or not.
 *
 * @returns {JSX.Element}
 */
export function RequireAuth() {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) return <SessionLoading />;

  // `state.from` carries where they were headed; `replace` keeps the bounced-from URL
  // out of history so Back does not walk into the redirect again.
  if (!user) return <Navigate to="/login" replace state={{ from: location }} />;

  return <Outlet />;
}

/**
 * Renders child routes only for a visitor with no session.
 *
 * The SINGLE owner of post-sign-in navigation. LoginPage deliberately does not call
 * navigate() itself - if both did, two redirects would race and the loser would
 * occasionally win.
 *
 * @returns {JSX.Element}
 */
export function PublicOnlyRoute() {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) return <SessionLoading />;

  if (user) {
    // Back to wherever they were originally headed, so signing in from a deep link
    // lands on that link rather than the home page.
    return <Navigate to={location.state?.from?.pathname ?? "/"} replace />;
  }

  return <Outlet />;
}

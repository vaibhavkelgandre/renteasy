/**
 * Routes.
 *
 * Note the shape: the HOME page is public and sits inside the layout, because browsing
 * needs no account. That is the opposite of an internal tool, where everything lives
 * behind the front door - and it is why AppLayout must not assume a user.
 */

import { Routes, Route, Link } from "react-router-dom";
import { AppLayout } from "./components/layout/AppLayout.jsx";
import { PublicOnlyRoute, RequireAuth } from "./routes/guards.jsx";
import { HomePage } from "./pages/HomePage.jsx";
import { RegisterPage } from "./pages/RegisterPage.jsx";
import { CheckEmailPage } from "./pages/CheckEmailPage.jsx";
import { VerifyPage } from "./pages/VerifyPage.jsx";
import { LoginPage } from "./pages/LoginPage.jsx";
import { ForgotPasswordPage } from "./pages/ForgotPasswordPage.jsx";
import { ResetPasswordPage } from "./pages/ResetPasswordPage.jsx";
import { ProfilePage } from "./pages/ProfilePage.jsx";
import { PublicProfilePage } from "./pages/PublicProfilePage.jsx";
import { TermsPage } from "./pages/TermsPage.jsx";
import { MyListingsPage } from "./pages/MyListingsPage.jsx";
import { ListingFormPage } from "./pages/ListingFormPage.jsx";
import { ListingDetailPage } from "./pages/ListingDetailPage.jsx";
import { ListingAvailabilityPage } from "./pages/ListingAvailabilityPage.jsx";
import { BookingRequestPage } from "./pages/BookingRequestPage.jsx";
import { MyBookingsPage } from "./pages/MyBookingsPage.jsx";
import { BookingDetailPage } from "./pages/BookingDetailPage.jsx";
import { Button } from "./components/ui/Button.jsx";
import { Logo } from "./components/Logo.jsx";

export function App() {
  return (
    <Routes>
      {/* Public, inside the shell. Anyone can browse. */}
      <Route element={<AppLayout />}>
        <Route path="/" element={<HomePage />} />

        {/* Public deliberately: a listing has to be able to name who is offering it to
            a visitor with no account. */}
        <Route path="/u/:id" element={<PublicProfilePage />} />

        {/* Public. Browsing needs no account — a published listing is world-readable,
            and the API answers 404 for a draft to everyone but its owner. */}
        <Route path="/listings/:id" element={<ListingDetailPage />} />

        {/* Public, and outside every guard. It is linked from the registration form,
            which is read by someone who by definition has no account — and it is what
            they are agreeing to, so it must never be behind a sign-in. */}
        <Route path="/terms" element={<TermsPage />} />

        {/* THE FIRST AUTHENTICATED ROUTE IN THE APP, and so the first thing that has
            ever used RequireAuth. Nested inside AppLayout so the header stays put. */}
        <Route element={<RequireAuth />}>
          <Route path="/profile" element={<ProfilePage />} />

          {/* Owner-only screens. The guard is convenience, not security — every one of
              these calls an endpoint that checks ownership against the row itself. */}
          <Route path="/listings/mine" element={<MyListingsPage />} />
          <Route path="/listings/new" element={<ListingFormPage />} />
          <Route path="/listings/:id/edit" element={<ListingFormPage />} />
          <Route path="/listings/:id/availability" element={<ListingAvailabilityPage />} />

          {/* Booking. `/listings/:id/book` sits under listings because that is what it
              acts on, while the bookings themselves live at their own root — a booking
              outlives the browsing that produced it. */}
          <Route path="/listings/:id/book" element={<BookingRequestPage />} />
          <Route path="/bookings" element={<MyBookingsPage />} />
          <Route path="/bookings/:id" element={<BookingDetailPage />} />
        </Route>
      </Route>

      {/* Signed-out only. PublicOnlyRoute is the SINGLE owner of redirecting an
          authenticated visitor away - see routes/guards.jsx. */}
      <Route element={<PublicOnlyRoute />}>
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/login" element={<LoginPage />} />

        {/* Signed-out only: someone with a live session does not need this, and can
            change their password from their profile instead. */}
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      </Route>

      {/* Deliberately OUTSIDE PublicOnlyRoute.
          Someone often verifies in the same browser they are already signed into -
          they signed in unverified, hit the banner, then clicked the emailed link. If
          this sat behind PublicOnlyRoute they would be redirected away and the token
          would never be consumed. */}
      <Route path="/verify/:token" element={<VerifyPage />} />

      {/* Also outside: it is reached immediately after registering, when there is no
          session by design. */}
      <Route path="/check-email" element={<CheckEmailPage />} />

      {/* OUTSIDE PublicOnlyRoute, same reasoning as /verify/:token. Someone can be
          signed in on this browser and still be resetting the password — they may have
          an old session on a laptop and be recovering the account from an email. Behind
          the guard they would be bounced away and the link would look broken. */}
      <Route path="/reset-password/:token" element={<ResetPasswordPage />} />

      {/* A TOP-LEVEL catch-all. Nested inside the layout it would only cover paths
          under it, and every other unknown URL would match no route and render a blank
          page - which reads as a crash. */}
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}

/** 404. Standalone, so it works with or without a session. */
function NotFoundPage() {
  return (
    <div className="grid min-h-full place-items-center bg-stone-50 px-5">
      <div className="text-center">
        <div className="mb-8 flex justify-center">
          <Logo />
        </div>
        <p className="font-mono text-sm tabular text-stone-400">404</p>
        <h1 className="mt-2 text-xl font-semibold text-stone-900">Page not found</h1>
        <p className="mx-auto mt-2 max-w-sm leading-relaxed text-stone-500">
          That address does not exist. If you followed a confirmation link from an
          email, check it was copied in full.
        </p>
        <Button as={Link} to="/" variant="outline" className="mt-7">
          Back to RentEasy
        </Button>
      </div>
    </div>
  );
}

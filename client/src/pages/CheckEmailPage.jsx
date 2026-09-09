/**
 * "Check your inbox" — shown after registration.
 *
 * THE WORDING ON THIS PAGE IS THE FEATURE, not decoration, and it is the hardest thing
 * in the whole flow to get right.
 *
 * The API answers identically whether the address was new, already registered but
 * unverified, or already a live account (docs/features/01-public-registration.md §3.1).
 * So this page must be TRUE in all three cases while revealing which one happened in
 * none of them:
 *
 *   ❌ "Account created!"           — false when the address already had one
 *   ❌ "We've sent you a link"      — false for a verified address, which gets a
 *                                     "someone tried to sign up" notice instead
 *   ✅ "We've emailed <address> with what to do next"
 *
 * That last sentence is true in every case and distinguishes none of them. Anyone
 * editing this copy needs to keep that property — it is easy to "improve" the wording
 * into an enumeration oracle without noticing.
 */

import { Link, useLocation, Navigate } from "react-router-dom";
import { Card } from "../components/ui/Card.jsx";
import { Button } from "../components/ui/Button.jsx";
import { Logo } from "../components/Logo.jsx";

export function CheckEmailPage() {
  const location = useLocation();
  const email = location.state?.email;

  // Reached directly, with no state, this page has nothing to say. Send them to
  // register rather than rendering a hollow "check your email" for an address nobody
  // supplied.
  if (!email) return <Navigate to="/register" replace />;

  return (
    <div className="mx-auto w-full max-w-md px-5 py-10 sm:py-16">
      <div className="mb-8 flex justify-center">
        <Logo />
      </div>

      <Card className="p-8 text-center">
        <div className="mx-auto grid size-14 place-items-center rounded-full bg-brand-50">
          <svg
            className="size-7 text-brand-600"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="2" y="4" width="20" height="16" rx="2" />
            <path d="m2 7 10 6 10-6" />
          </svg>
        </div>

        <h1 className="mt-5 text-xl font-semibold tracking-tight text-stone-900">Check your inbox</h1>

        {/* The address is echoed back because the single most common failure here is a
            typo — and seeing it is what lets someone catch their own mistake. */}
        <p className="mt-3 leading-relaxed text-stone-600">
          We&rsquo;ve emailed{" "}
          <span className="font-medium text-stone-900">{email}</span> with what to do next.
        </p>

        <p className="mt-4 text-sm leading-relaxed text-stone-500">
          The link works once and expires in 24 hours. If it doesn&rsquo;t arrive in a
          few minutes, check your spam folder.
        </p>

        <div className="mt-7 space-y-3">
          <Button as={Link} to="/login" variant="outline" fullWidth>
            Go to sign in
          </Button>

          {/* No "resend" button here, and that is deliberate. Resending requires a
              session, because an unauthenticated resend would be an open
              email-sending endpoint pointed at any address a caller can type. Someone
              who never receives the mail signs in — which an unverified account can do
              — and resends from the banner there. */}
          <p className="text-sm text-stone-500">
            Wrong address?{" "}
            <Link to="/register" className="font-medium text-brand-700 underline underline-offset-2">
              Try again
            </Link>
          </p>
        </div>
      </Card>
    </div>
  );
}

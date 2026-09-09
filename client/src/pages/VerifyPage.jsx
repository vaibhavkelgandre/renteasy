/**
 * The page an emailed verification link lands on: `/verify/:token`.
 *
 * It reads the token from the URL and POSTs it. The token never reaches the API as a
 * query parameter, because a token in a URL the SERVER handles ends up in access logs
 * — this way it only ever exists in the browser's own history, which is the
 * recipient's own machine.
 */

import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Card } from "../components/ui/Card.jsx";
import { Button } from "../components/ui/Button.jsx";
import { Logo } from "../components/Logo.jsx";
import { api } from "../lib/api.js";
import { useAuth } from "../context/AuthContext.jsx";

export function VerifyPage() {
  const { token } = useParams();
  const { user, refresh } = useAuth();
  const [state, setState] = useState({ status: "working" });

  // StrictMode double-invokes effects in development, and this effect CONSUMES A
  // SINGLE-USE TOKEN. Without this guard the second run would find the token already
  // used and — correctly — report failure, so a perfectly good link would look broken
  // every time in development. A ref, not state, because it must not trigger a render.
  const attempted = useRef(false);

  useEffect(() => {
    if (attempted.current) return;
    attempted.current = true;

    // NO `cancelled` FLAG HERE, AND THAT ABSENCE IS DELIBERATE — it used to have one,
    // and combining it with the ref guard above span this page's loader forever in
    // development. The two guards are individually correct and deadlock together:
    //
    //   1. effect #1  → attempted = true, cancelled = false, request fires
    //   2. StrictMode → the cleanup runs → cancelled = true
    //   3. effect #2  → attempted is already true → EARLY RETURN, so no second
    //                   request and no fresh flag
    //   4. response   → `if (cancelled) return` is TRUE → setState never runs
    //
    // One request correctly made, its answer silently thrown away. The ref guard
    // suppressed the retry and the discarded pass's flag suppressed the result.
    //
    // Dropping the flag is safe rather than a trade: StrictMode remounts the SAME
    // component instance (which is why a ref survives to guard anything at all), so
    // this component is still mounted when the response lands. And React 18 removed
    // the "state update on an unmounted component" warning precisely because these
    // flags caused more bugs than they prevented — this was one of them.
    api
      .post("/auth/verify", { token })
      .then(async (data) => {
        setState({
          status: "ok",
          alreadyVerified: data.alreadyVerified,
          emailChanged: data.emailChanged,
        });

        // Re-read the session. Verification state is read from the database on every
        // request, so it takes effect immediately server-side — but this app is
        // holding a stale copy until it asks again. Someone verifying in the same
        // browser they are signed into would otherwise still see the "confirm your
        // email" banner.
        await refresh();
      })
      .catch((error) => {
        setState({ status: "failed", message: error.message });
      });
    // `refresh` is intentionally not a dependency: it is recreated on every render of
    // the provider, and depending on it would re-run this effect — consuming the token
    // again. The ref guard covers it either way, but the narrow list says why.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  return (
    <div className="mx-auto w-full max-w-md px-5 py-10 sm:py-16">
      <div className="mb-8 flex justify-center">
        <Logo />
      </div>

      <Card className="p-8 text-center">
        {state.status === "working" && (
          <>
            <div className="mx-auto grid size-14 place-items-center rounded-full bg-stone-100">
              <svg className="size-6 animate-spin text-stone-400" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.25" />
                <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
              </svg>
            </div>
            <h1 className="mt-5 text-xl font-semibold text-stone-900">Confirming your email…</h1>
            <p className="sr-only" role="status">
              Confirming your email address
            </p>
          </>
        )}

        {state.status === "ok" && (
          <>
            <div className="mx-auto grid size-14 place-items-center rounded-full bg-emerald-50">
              <svg className="size-7 text-emerald-600" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                <path
                  fillRule="evenodd"
                  d="M16.7 5.3a1 1 0 010 1.4l-8 8a1 1 0 01-1.4 0l-4-4a1 1 0 011.4-1.4L8 12.6l7.3-7.3a1 1 0 011.4 0z"
                  clipRule="evenodd"
                />
              </svg>
            </div>

            <h1 className="mt-5 text-xl font-semibold tracking-tight text-stone-900">
              {/* Three outcomes, not two. A second click is a success, not an error —
                  mail clients prefetch links, so that path is common rather than
                  exotic. And a link that completed an EMAIL CHANGE needs its own
                  wording: "Email confirmed" is misleading for someone who has just
                  moved their account and must now sign in with the new address. */}
              {state.alreadyVerified
                ? "Already confirmed"
                : state.emailChanged
                  ? "Email address updated"
                  : "Email confirmed"}
            </h1>

            <p className="mt-3 leading-relaxed text-stone-600">
              {state.alreadyVerified
                ? "This address was already confirmed. You're all set."
                : state.emailChanged
                  ? "This is now the address you sign in with, and where we send password resets."
                  : "You can now list your things and book from other people."}
            </p>

            <Button as={Link} to={user ? "/" : "/login"} size="lg" fullWidth className="mt-7">
              {user ? "Start browsing" : "Sign in"}
            </Button>
          </>
        )}

        {state.status === "failed" && (
          <>
            <div className="mx-auto grid size-14 place-items-center rounded-full bg-amber-50">
              <svg
                className="size-7 text-amber-600"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <path d="M12 8v5M12 16.5v.5" />
                <circle cx="12" cy="12" r="9" />
              </svg>
            </div>

            <h1 className="mt-5 text-xl font-semibold tracking-tight text-stone-900">
              This link no longer works
            </h1>

            {/* One message for every cause — expired, already used with a since-changed
                address, unknown, malformed. The API answers all of them identically so
                that guessing a token reveals nothing, and repeating that wording here
                is what keeps the guarantee intact at the last mile.

                So the copy explains what to DO rather than what went wrong, which is
                the only useful thing to say when we genuinely will not distinguish. */}
            <p className="mt-3 leading-relaxed text-stone-600">
              Links expire after 24 hours and can only be used once.
            </p>

            <p className="mt-4 text-sm leading-relaxed text-stone-500">
              Sign in and we&rsquo;ll send you a new one — you can sign in even before
              your email is confirmed.
            </p>

            <Button as={Link} to="/login" size="lg" fullWidth className="mt-7">
              Sign in to get a new link
            </Button>
          </>
        )}
      </Card>
    </div>
  );
}

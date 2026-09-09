/**
 * "Forgot your password" — ask for a reset link.
 *
 * THE WORDING ON THE CONFIRMATION PANEL IS THE FEATURE, exactly as it is on
 * CheckEmailPage, and for the same reason.
 *
 * The API answers identically whether the address has a live account, a suspended one,
 * no account at all, or a request already inside its cooldown
 * (docs/features/02-password-reset.md §3.1). So this page must be TRUE in all four
 * cases and reveal which one happened in none of them:
 *
 *   ❌ "We've sent you a link"         — false for an address with no account
 *   ❌ "Check your inbox"              — implies something was sent
 *   ✅ "If <address> has an account, we've emailed a reset link"
 *
 * That conditional is doing real work. It is very easy to "improve" it into a sentence
 * that confirms an account exists, which hands back exactly what the identical 202
 * withholds.
 */

import { useState } from "react";
import { Link } from "react-router-dom";
import { Card } from "../components/ui/Card.jsx";
import { Button } from "../components/ui/Button.jsx";
import { Field } from "../components/ui/Field.jsx";
import { Alert } from "../components/ui/Alert.jsx";
import { Logo } from "../components/Logo.jsx";
import { api } from "../lib/api.js";

export function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    setErrors({});
    setFormError("");
    setSubmitting(true);

    try {
      await api.post("/auth/forgot-password", { email });
      setSent(true);
    } catch (error) {
      // A 400 for a malformed address is the only field error this endpoint produces,
      // and it is safe to show: it is refused on shape alone, before any lookup.
      setErrors(error.errors ?? {});
      if (!error.errors || Object.keys(error.errors).length === 0) setFormError(error.message);
    } finally {
      setSubmitting(false);
    }
  }

  if (sent) {
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

          <h1 className="mt-5 text-xl font-semibold tracking-tight text-stone-900">
            Check your inbox
          </h1>

          {/* The conditional is deliberate — see the file header. The address is echoed
              because a typo is the most common reason nothing arrives, and seeing it is
              what lets someone catch their own mistake. */}
          <p className="mt-3 leading-relaxed text-stone-600">
            If <span className="font-medium text-stone-900">{email}</span> has a RentEasy
            account, we&rsquo;ve emailed a link to reset its password.
          </p>

          <p className="mt-4 text-sm leading-relaxed text-stone-500">
            The link works once and expires in an hour. If it doesn&rsquo;t arrive in a
            few minutes, check your spam folder.
          </p>

          <div className="mt-7 space-y-3">
            <Button as={Link} to="/login" variant="outline" fullWidth>
              Back to sign in
            </Button>

            {/* No "resend" button, deliberately. There is a 15-minute cooldown per
                account, so a second click would usually do nothing while appearing to
                work — and saying why would confirm the address has an account. Editing
                the address and submitting again is the honest affordance. */}
            <p className="text-sm text-stone-500">
              Wrong address?{" "}
              <button
                type="button"
                onClick={() => setSent(false)}
                className="font-medium text-brand-700 underline underline-offset-2"
              >
                Try another
              </button>
            </p>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-md px-5 py-10 sm:py-16">
      <div className="mb-8 flex justify-center">
        <Link to="/" aria-label="RentEasy home">
          <Logo />
        </Link>
      </div>

      <h1 className="text-center text-2xl font-semibold tracking-tight text-stone-900">
        Reset your password
      </h1>
      <p className="mt-3 text-center leading-relaxed text-stone-600">
        Enter the email you signed up with and we&rsquo;ll send you a link to set a new
        password.
      </p>

      <form onSubmit={handleSubmit} className="mt-8 space-y-5" noValidate>
        {formError && <Alert tone="error">{formError}</Alert>}

        <Field
          label="Email"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          error={errors.email}
          autoComplete="username"
          autoFocus
        />

        <Button type="submit" size="lg" fullWidth loading={submitting}>
          Send reset link
        </Button>
      </form>

      <p className="mt-6 text-center text-sm text-stone-500">
        Remembered it?{" "}
        <Link to="/login" className="font-medium text-brand-700 underline underline-offset-2">
          Sign in
        </Link>
      </p>
    </div>
  );
}

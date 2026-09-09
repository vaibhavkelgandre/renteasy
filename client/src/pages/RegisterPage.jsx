/**
 * Create an account.
 *
 * The form is ordinary. The important part is what happens on success: it navigates to
 * "check your email" rather than signing anyone in, because the API deliberately
 * issues no session (docs/features/01-public-registration.md §3.2) and deliberately
 * will not say whether an account was created (§3.1).
 */

import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "../components/ui/Button.jsx";
import { Field, Checkbox } from "../components/ui/Field.jsx";
import { Alert } from "../components/ui/Alert.jsx";
import { Logo } from "../components/Logo.jsx";
import { useAuth } from "../context/AuthContext.jsx";
import { api } from "../lib/api.js";

export function RegisterPage() {
  const { register } = useAuth();
  const navigate = useNavigate();

  const [form, setForm] = useState({ name: "", email: "", password: "", phone: "" });
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [terms, setTerms] = useState(null);
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // THE VERSION IS FETCHED, not hardcoded.
  //
  // The server refuses a stale version with a 409, and that refusal is the whole point
  // of the field: it means nobody can be recorded as agreeing to terms they were never
  // shown. Hardcoding a version here would defeat it — the constant would drift and
  // every signup would suddenly fail, or worse, keep succeeding against the wrong text.
  useEffect(() => {
    let cancelled = false;
    api
      .get("/auth/terms/current")
      .then((data) => !cancelled && setTerms(data))
      .catch(() => !cancelled && setTerms(null));
    return () => {
      cancelled = true;
    };
  }, []);

  const update = (field) => (event) => setForm({ ...form, [field]: event.target.value });

  async function handleSubmit(event) {
    event.preventDefault();
    setErrors({});
    setFormError("");

    // Checked here as well as server-side. Not duplication for its own sake: an
    // unchecked box is the one failure the user can see and fix without a round trip.
    if (!acceptedTerms) {
      setErrors({ acceptedTermsVersion: "Please accept the terms to continue." });
      return;
    }

    setSubmitting(true);
    try {
      await register({
        name: form.name,
        email: form.email,
        password: form.password,
        // Omitted entirely when blank. An empty string would fail the schema's minimum
        // length, while `undefined` is simply absent — which is what "optional" means.
        phone: form.phone.trim() || undefined,
        acceptedTermsVersion: terms?.version,
      });

      // The email travels in ROUTER STATE, not a query parameter. It is only there to
      // be displayed back ("we've emailed asha@…"), and an address in a URL ends up in
      // browser history and any Referer header the next page sends.
      navigate("/check-email", { replace: true, state: { email: form.email } });
    } catch (error) {
      setErrors(error.errors ?? {});
      if (!error.errors || Object.keys(error.errors).length === 0) setFormError(error.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-md px-5 py-10 sm:py-16">
      <div className="mb-8 flex justify-center">
        <Link to="/" aria-label="RentEasy home">
          <Logo />
        </Link>
      </div>

      <h1 className="text-center text-2xl font-semibold tracking-tight text-stone-900">
        Create your account
      </h1>
      <p className="mt-2 text-center text-stone-500">
        Rent what you need. Earn from what you already own.
      </p>

      <form onSubmit={handleSubmit} className="mt-8 space-y-5" noValidate>
        {formError && <Alert tone="error">{formError}</Alert>}

        <Field
          label="Full name"
          value={form.name}
          onChange={update("name")}
          error={errors.name}
          autoComplete="name"
          autoFocus
          hint="Shown to people you rent from or lend to."
        />

        <Field
          label="Email"
          type="email"
          value={form.email}
          onChange={update("email")}
          error={errors.email}
          autoComplete="email"
          placeholder="you@example.com"
        />

        <Field
          label="Password"
          type="password"
          value={form.password}
          onChange={update("password")}
          error={errors.password}
          // "new-password" tells a password manager to OFFER TO GENERATE one rather
          // than autofilling an existing credential.
          autoComplete="new-password"
          hint="At least 10 characters. Longer is better than complicated."
        />

        <Field
          label="Phone"
          type="tel"
          optional
          value={form.phone}
          onChange={update("phone")}
          error={errors.phone}
          autoComplete="tel"
          hint="Used later to unlock higher-value rentals. We never show it publicly."
        />

        <Checkbox
          checked={acceptedTerms}
          onChange={(event) => setAcceptedTerms(event.target.checked)}
          error={errors.acceptedTermsVersion}
          label={
            <>
              I agree to the{" "}
              <a
                href={terms?.url ?? "/terms"}
                target="_blank"
                rel="noreferrer"
                className="font-medium text-brand-700 underline underline-offset-2"
              >
                terms of service
              </a>{" "}
              and privacy policy.
            </>
          }
        />

        <Button
          type="submit"
          size="lg"
          fullWidth
          loading={submitting}
          // Until the version has loaded there is nothing valid to submit — the server
          // would answer 409. Disabled beats a button that can only fail.
          disabled={!terms}
        >
          Create account
        </Button>
      </form>

      <p className="mt-6 text-center text-sm text-stone-500">
        Already have an account?{" "}
        <Link to="/login" className="font-medium text-brand-700 underline underline-offset-2">
          Sign in
        </Link>
      </p>
    </div>
  );
}

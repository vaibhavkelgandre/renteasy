/**
 * Sign in.
 *
 * A centred card rather than a split layout, because on a marketplace this page is a
 * brief interruption to browsing — not, as it is in an internal tool, the front door.
 * Most visitors arrive already looking at something they want.
 */

import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { Button } from "../components/ui/Button.jsx";
import { Field } from "../components/ui/Field.jsx";
import { Alert } from "../components/ui/Alert.jsx";
import { Logo } from "../components/Logo.jsx";
import { useAuth } from "../context/AuthContext.jsx";

export function LoginPage() {
  const { login } = useAuth();
  const location = useLocation();

  // Carried here by ResetPasswordPage on success. Router state, not a query param:
  // this is a one-shot message, and a query param would survive a refresh and keep
  // claiming the password was just updated.
  const notice = location.state?.notice;

  const [form, setForm] = useState({ email: "", password: "" });
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const update = (field) => (event) => setForm({ ...form, [field]: event.target.value });

  async function handleSubmit(event) {
    event.preventDefault();
    setErrors({});
    setFormError("");
    setSubmitting(true);

    try {
      await login(form);
      // No navigate() here. PublicOnlyRoute owns redirecting a signed-in visitor away
      // from this page, so the session becoming non-null is what moves us — one owner
      // of post-login navigation instead of two racing each other.
    } catch (error) {
      setErrors(error.errors ?? {});
      if (!error.errors || Object.keys(error.errors).length === 0) setFormError(error.message);
    } finally {
      // In `finally`, not only in `catch`. On success this component stays mounted for
      // a moment while the redirect happens, and a button left spinning reads as a
      // hung request for something that already worked.
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
        Welcome back
      </h1>

      <form onSubmit={handleSubmit} className="mt-8 space-y-5" noValidate>
        {/* Before the error slot, and only one of the two ever shows: the notice is
            hidden the moment a submission fails, because "your password has been
            updated" above "incorrect email or password" reads as a contradiction. */}
        {notice && !formError && <Alert tone="success">{notice}</Alert>}
        {formError && <Alert tone="error">{formError}</Alert>}

        <Field
          label="Email"
          type="email"
          value={form.email}
          onChange={update("email")}
          error={errors.email}
          autoComplete="username"
          autoFocus
        />

        <Field
          label="Password"
          type="password"
          value={form.password}
          onChange={update("password")}
          error={errors.password}
          // "current-password", not "new-password": it tells a password manager to
          // offer a SAVED credential rather than generate a fresh one.
          autoComplete="current-password"
        />

        {/* FR-027. Right-aligned under the password field rather than buried at the
            bottom of the page: this is looked for at the exact moment a sign-in has
            just failed, and anywhere else means hunting for it.

            Before this existed the page promised help for an unconfirmed EMAIL and said
            nothing about a forgotten PASSWORD — which is the gap a user actually falls
            into, and was hit for real in development. */}
        <div className="-mt-1 text-right">
          <Link
            to="/forgot-password"
            className="text-sm font-medium text-brand-700 underline underline-offset-2"
          >
            Forgot your password?
          </Link>
        </div>

        <Button type="submit" size="lg" fullWidth loading={submitting}>
          Sign in
        </Button>
      </form>

      {/* Says the quiet part out loud. Signing in works BEFORE an email is confirmed —
          which is exactly how someone whose verification mail never arrived gets back
          to a resend button. Without this line they would assume they are locked out
          and give up. */}
      <p className="mt-6 text-center text-sm leading-relaxed text-stone-500">
        Haven&rsquo;t confirmed your email yet? You can still sign in — we&rsquo;ll send
        you a new link.
      </p>

      <p className="mt-6 text-center text-sm text-stone-500">
        New to RentEasy?{" "}
        <Link to="/register" className="font-medium text-brand-700 underline underline-offset-2">
          Create an account
        </Link>
      </p>
    </div>
  );
}

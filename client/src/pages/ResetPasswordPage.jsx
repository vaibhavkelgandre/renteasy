/**
 * The page an emailed reset link lands on: `/reset-password/:token`.
 *
 * IT DOES NOT POST ON MOUNT, and that is the one structural difference from
 * VerifyPage — which does, and needs a `useRef` guard because StrictMode
 * double-invokes effects on a single-use token.
 *
 * Here the token is only ever spent by a form submission. That is not merely
 * convenient, it is required: mail clients, link scanners and corporate security
 * gateways PREFETCH links, so a reset page that consumed its token on load would be
 * burned before the recipient had typed anything — and the recipient would be told
 * their perfectly good link had expired.
 *
 * So there is no effect here at all, and nothing to guard.
 */

import { useState } from "react";
import { Link, useParams, useNavigate } from "react-router-dom";
import { Card } from "../components/ui/Card.jsx";
import { Button } from "../components/ui/Button.jsx";
import { Field } from "../components/ui/Field.jsx";
import { Alert } from "../components/ui/Alert.jsx";
import { Logo } from "../components/Logo.jsx";
import { api } from "../lib/api.js";

export function ResetPasswordPage() {
  const { token } = useParams();
  const navigate = useNavigate();

  const [form, setForm] = useState({ password: "", confirm: "" });
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState("");
  const [dead, setDead] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const update = (field) => (event) => setForm({ ...form, [field]: event.target.value });

  async function handleSubmit(event) {
    event.preventDefault();
    setErrors({});
    setFormError("");

    // Checked here and NOT sent to the server, because it is not a server concern —
    // the API takes one password. This exists only to catch a typo in something the
    // user cannot see, which is the whole reason a confirm field exists.
    if (form.password !== form.confirm) {
      setErrors({ confirm: "The two passwords do not match" });
      return;
    }

    setSubmitting(true);

    try {
      await api.post("/auth/reset-password", { token, password: form.password });

      // Straight to sign-in, with a message carried in router state. The API sets no
      // cookie (FR-025), so there is no session to land anywhere else with — and
      // saying so is what stops "it worked but I'm not logged in" reading as a bug.
      navigate("/login", {
        replace: true,
        state: { notice: "Your password has been updated. Sign in with it below." },
      });
    } catch (error) {
      // 410 means the link is spent, expired, unknown, or the account moved on. The
      // API will not say which, so this swaps the form for an explanation rather than
      // leaving a form the user can only fail at again.
      if (error.status === 410) {
        setDead(true);
        return;
      }
      setErrors(error.errors ?? {});
      if (!error.errors || Object.keys(error.errors).length === 0) setFormError(error.message);
    } finally {
      setSubmitting(false);
    }
  }

  if (dead) {
    return (
      <div className="mx-auto w-full max-w-md px-5 py-10 sm:py-16">
        <div className="mb-8 flex justify-center">
          <Logo />
        </div>

        <Card className="p-8 text-center">
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

          {/* One message for every cause — expired, already used, unknown, or the
              account's address changed since it was sent. The API answers all of them
              identically so that guessing a token reveals nothing, and repeating that
              wording here is what keeps the guarantee intact at the last mile.

              So the copy explains what to DO rather than what went wrong, which is the
              only useful thing to say when we genuinely will not distinguish. */}
          <p className="mt-3 leading-relaxed text-stone-600">
            Reset links expire after an hour and can only be used once.
          </p>

          <Button as={Link} to="/forgot-password" size="lg" fullWidth className="mt-7">
            Request a new link
          </Button>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-md px-5 py-10 sm:py-16">
      <div className="mb-8 flex justify-center">
        <Logo />
      </div>

      <h1 className="text-center text-2xl font-semibold tracking-tight text-stone-900">
        Set a new password
      </h1>

      <form onSubmit={handleSubmit} className="mt-8 space-y-5" noValidate>
        {formError && <Alert tone="error">{formError}</Alert>}

        <Field
          label="New password"
          type="password"
          value={form.password}
          onChange={update("password")}
          error={errors.password}
          hint="At least 10 characters."
          // "new-password", not "current-password": it tells a password manager to
          // offer to GENERATE and save one rather than filling in the old one, which
          // is the opposite of what the sign-in form wants.
          autoComplete="new-password"
          autoFocus
        />

        <Field
          label="Confirm new password"
          type="password"
          value={form.confirm}
          onChange={update("confirm")}
          error={errors.confirm}
          autoComplete="new-password"
        />

        <Button type="submit" size="lg" fullWidth loading={submitting}>
          Update password
        </Button>
      </form>

      {/* Said out loud because the alternative reads as a bug. Every other credential
          flow people meet signs them in on success. */}
      <p className="mt-6 text-center text-sm leading-relaxed text-stone-500">
        You&rsquo;ll sign in with your new password afterwards — this link sets a
        password, it doesn&rsquo;t sign you in.
      </p>
    </div>
  );
}

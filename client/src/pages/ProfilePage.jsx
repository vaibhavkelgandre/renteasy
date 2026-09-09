/**
 * The signed-in user's own account page — FR-028 to FR-032, FR-034.
 *
 * THE FIRST AUTHENTICATED PAGE IN THE APP, which means it is also the first consumer of
 * `RequireAuth`. That guard had zero routes until now, so nothing had ever proved it
 * works in place.
 *
 * Four separate forms rather than one big Save, and that is deliberate. Name, email,
 * password and deletion have genuinely different rules — two of them need the current
 * password, one takes effect immediately and one does not take effect at all until a
 * link is clicked. A single form would have to explain all of that at once, and its
 * Save button could only report the vaguest possible outcome.
 */

import { useState } from "react";
import { Link } from "react-router-dom";
import { Card } from "../components/ui/Card.jsx";
import { Button } from "../components/ui/Button.jsx";
import { Field } from "../components/ui/Field.jsx";
import { Alert } from "../components/ui/Alert.jsx";
import { api } from "../lib/api.js";
import { useAuth } from "../context/AuthContext.jsx";

/** Formats a timestamp as a plain month and year — "member since" needs no more. */
function memberSince(iso) {
  return new Date(iso).toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

/**
 * A titled section with its own form, message and error state.
 *
 * Each section owns its own feedback because they succeed and fail independently —
 * a shared banner would report the last thing that happened wherever the reader
 * happens to be looking.
 */
function Section({ title, description, children }) {
  return (
    <Card className="p-6 sm:p-7">
      <h2 className="text-base font-semibold text-stone-900">{title}</h2>
      {description && <p className="mt-1 text-sm leading-relaxed text-stone-500">{description}</p>}
      <div className="mt-5">{children}</div>
    </Card>
  );
}

export function ProfilePage() {
  const { user, refresh, logout } = useAuth();

  return (
    <div className="mx-auto w-full max-w-2xl px-5 py-10 sm:py-14">
      <h1 className="text-2xl font-semibold tracking-tight text-stone-900">Your account</h1>
      <p className="mt-2 leading-relaxed text-stone-600">
        Member since {memberSince(user.created_at)}.{" "}
        <Link
          to={`/u/${user.id}`}
          className="font-medium text-brand-700 underline underline-offset-2"
        >
          See your public profile
        </Link>
      </p>

      <div className="mt-8 space-y-5">
        <DetailsSection user={user} onSaved={refresh} />
        <EmailSection user={user} onChanged={refresh} />
        <PasswordSection />
        <DangerSection onDeleted={logout} />
      </div>
    </div>
  );
}

/** FR-029 — name and phone. */
function DetailsSection({ user, onSaved }) {
  const [form, setForm] = useState({ name: user.name, phone: user.phone ?? "" });
  const [errors, setErrors] = useState({});
  const [message, setMessage] = useState("");
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);

  const update = (field) => (event) => setForm({ ...form, [field]: event.target.value });

  async function handleSubmit(event) {
    event.preventDefault();
    setErrors({});
    setMessage("");
    setFormError("");
    setSaving(true);

    try {
      await api.patch("/profile", {
        name: form.name,
        // "" is not a phone number and the schema would reject it on length. `null` is
        // how this API says "clear it", which is a different thing from omitting the
        // field — that would mean "leave it alone".
        phone: form.phone.trim() === "" ? null : form.phone.trim(),
      });
      await onSaved();
      setMessage("Saved.");
    } catch (error) {
      setErrors(error.errors ?? {});
      if (!error.errors || Object.keys(error.errors).length === 0) setFormError(error.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section title="Your details" description="Your name is shown to people you rent with.">
      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        {formError && <Alert tone="error">{formError}</Alert>}
        {message && <Alert tone="success">{message}</Alert>}

        <Field label="Name" value={form.name} onChange={update("name")} error={errors.name} />

        <Field
          label="Phone"
          type="tel"
          value={form.phone}
          onChange={update("phone")}
          error={errors.phone}
          optional
          hint="Not shown publicly. Verifying it is a separate step, and is not built yet."
        />

        <Button type="submit" loading={saving}>
          Save changes
        </Button>
      </form>
    </Section>
  );
}

/** FR-030, FR-031 — change email, with the old one working until the new is confirmed. */
function EmailSection({ user, onChanged }) {
  const [form, setForm] = useState({ newEmail: "", currentPassword: "" });
  const [errors, setErrors] = useState({});
  const [message, setMessage] = useState("");
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);

  const update = (field) => (event) => setForm({ ...form, [field]: event.target.value });

  async function handleSubmit(event) {
    event.preventDefault();
    setErrors({});
    setMessage("");
    setFormError("");
    setBusy(true);

    try {
      await api.patch("/profile/email", form);
      await onChanged();
      setForm({ newEmail: "", currentPassword: "" });

      // THE WORDING IS THE FEATURE, exactly as on the registration and reset flows.
      // The API answers identically whether the address is free, belongs to somebody
      // else, or is the caller's own — so this must be true in all three cases and
      // reveal which none of them. "We've sent you a link" would be false for an
      // address that already has an account.
      setMessage(
        "If that address is available, we've emailed it a confirmation link. Your current email keeps working until you use it."
      );
    } catch (error) {
      setErrors(error.errors ?? {});
      if (!error.errors || Object.keys(error.errors).length === 0) setFormError(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleCancel() {
    setBusy(true);
    try {
      await api.delete("/profile/email");
      await onChanged();
      setMessage("Email change cancelled.");
    } catch (error) {
      setFormError(error.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      title="Email address"
      description="You sign in with this address, and it is where password resets go."
    >
      <div className="mb-5 rounded-xl border border-stone-200 bg-stone-50 px-4 py-3">
        <p className="text-sm text-stone-500">Current</p>
        <p className="mt-0.5 font-medium text-stone-900">{user.email}</p>
        {!user.email_verified_at && (
          <p className="mt-1 text-sm text-amber-700">Not confirmed yet.</p>
        )}
      </div>

      {/* Without this, a change that was requested and never confirmed is invisible —
          the page would keep showing the old address with no hint that a link is
          sitting in another inbox, and no way to abandon it after a typo. */}
      {user.pending_email && (
        <Alert tone="warning" className="mb-5">
          <div>
            Waiting for confirmation of{" "}
            <span className="font-medium">{user.pending_email}</span>. Until you use the
            link we sent there, this account keeps using {user.email}.
            <button
              type="button"
              onClick={handleCancel}
              disabled={busy}
              className="mt-2 block font-medium underline underline-offset-2 disabled:opacity-50"
            >
              Cancel this change
            </button>
          </div>
        </Alert>
      )}

      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        {formError && <Alert tone="error">{formError}</Alert>}
        {message && <Alert tone="info">{message}</Alert>}

        <Field
          label="New email"
          type="email"
          value={form.newEmail}
          onChange={update("newEmail")}
          error={errors.newEmail}
          autoComplete="email"
        />

        <Field
          label="Your password"
          type="password"
          value={form.currentPassword}
          onChange={update("currentPassword")}
          error={errors.currentPassword}
          autoComplete="current-password"
          hint="Confirming it's you — a signed-in browser isn't proof on a shared machine."
        />

        <Button type="submit" loading={busy}>
          Send confirmation link
        </Button>
      </form>
    </Section>
  );
}

/** FR-032 — change password, requiring the current one. */
function PasswordSection() {
  const [form, setForm] = useState({ currentPassword: "", newPassword: "", confirm: "" });
  const [errors, setErrors] = useState({});
  const [message, setMessage] = useState("");
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);

  const update = (field) => (event) => setForm({ ...form, [field]: event.target.value });

  async function handleSubmit(event) {
    event.preventDefault();
    setErrors({});
    setMessage("");
    setFormError("");

    // Checked here and never sent: the API takes one new password. This exists only to
    // catch a typo in something the user cannot see.
    if (form.newPassword !== form.confirm) {
      setErrors({ confirm: "The two passwords do not match" });
      return;
    }

    setBusy(true);
    try {
      await api.patch("/profile/password", {
        currentPassword: form.currentPassword,
        newPassword: form.newPassword,
      });
      setForm({ currentPassword: "", newPassword: "", confirm: "" });
      setMessage("Password updated. You are still signed in here.");
    } catch (error) {
      setErrors(error.errors ?? {});
      if (!error.errors || Object.keys(error.errors).length === 0) setFormError(error.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="Password">
      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        {formError && <Alert tone="error">{formError}</Alert>}
        {message && <Alert tone="success">{message}</Alert>}

        <Field
          label="Current password"
          type="password"
          value={form.currentPassword}
          onChange={update("currentPassword")}
          error={errors.currentPassword}
          autoComplete="current-password"
        />

        <Field
          label="New password"
          type="password"
          value={form.newPassword}
          onChange={update("newPassword")}
          error={errors.newPassword}
          hint="At least 10 characters."
          autoComplete="new-password"
        />

        <Field
          label="Confirm new password"
          type="password"
          value={form.confirm}
          onChange={update("confirm")}
          error={errors.confirm}
          autoComplete="new-password"
        />

        <Button type="submit" loading={busy}>
          Update password
        </Button>
      </form>
    </Section>
  );
}

/** FR-034 — delete the account. */
function DangerSection({ onDeleted }) {
  const [confirming, setConfirming] = useState(false);
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleDelete(event) {
    event.preventDefault();
    setErrors({});
    setFormError("");
    setBusy(true);

    try {
      await api.post("/profile/deletion", { currentPassword: password });
      // The server has already cleared the cookie; this clears the client's copy of the
      // session and lands them on a page that still makes sense signed out.
      await onDeleted();
    } catch (error) {
      setErrors(error.errors ?? {});
      if (!error.errors || Object.keys(error.errors).length === 0) setFormError(error.message);
      setBusy(false);
    }
  }

  return (
    <Card className="border-rose-200 bg-rose-50/40 p-6 sm:p-7">
      <h2 className="text-base font-semibold text-rose-900">Delete your account</h2>

      {/* Both consequences stated BEFORE the button, not in a confirmation dialog
          afterwards. The second one in particular is surprising and permanent, and a
          person deserves to know it while they are still deciding. */}
      <p className="mt-1 text-sm leading-relaxed text-rose-800">
        This cannot be undone, and there is no way to restore it yourself. Your email
        address stays claimed by the deleted account, so you will not be able to sign up
        again with it.
      </p>

      <div className="mt-5">
        {!confirming ? (
          <Button variant="outline" onClick={() => setConfirming(true)}>
            Delete account
          </Button>
        ) : (
          <form onSubmit={handleDelete} className="space-y-4" noValidate>
            {formError && <Alert tone="error">{formError}</Alert>}

            <Field
              label="Your password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              error={errors.currentPassword}
              autoComplete="current-password"
              autoFocus
            />

            <div className="flex flex-wrap gap-3">
              <Button type="submit" variant="danger" loading={busy}>
                Permanently delete
              </Button>
              <Button type="button" variant="ghost" onClick={() => setConfirming(false)}>
                Keep my account
              </Button>
            </div>
          </form>
        )}
      </div>
    </Card>
  );
}

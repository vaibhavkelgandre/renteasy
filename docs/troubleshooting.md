# Troubleshooting

Solved problems, so nothing is diagnosed twice. Symptom, root cause, fix.

Newest first.

---

## EXIF was never stripped — a parameter that reads right and does something else

**Symptom.** None. Nothing failed, no test went red, and the images the app displays were clean.
Found by re-reading the upload options while diagnosing an unrelated 500.

**Root cause.** The upload passed `image_metadata: false`, with a comment stating it stripped EXIF.
It does not. That parameter controls whether the **API response includes** an asset's metadata — it
has no effect on what is stored.

Cloudinary *does* strip metadata from **derived** images, which is why this hid so well: every URL
the app hands out is derived (`w_400,…` and `w_1200,…`), so every image anyone actually saw was
clean. But the untransformed original stayed at `/image/upload/<public_id>`, GPS intact, and the
public_id is in the page's HTML. Anyone could take an owner's coordinates off a listing photo by
deleting the transformation from a URL.

**Fix.** An **incoming transformation**, which replaces the stored original rather than producing a
new derivative alongside it:

```js
transformation: [{ width: 2400, height: 2400, crop: "limit", quality: "auto:good", flags: "strip_profile" }]
```

**`quality: auto:good` is not tuning — it is the part that works.** `c_limit` only acts when an
image exceeds the bound, so anything already under 2400px would pass through untouched. The quality
directive forces the re-encode regardless of size, and metadata does not survive it.

**Why nothing caught it, which is the more useful half.** The suite runs with `NODE_ENV=test`, where
the uploader returns a deterministic fake and **never builds these options at all**. That guard is
right — it stops the suite writing into a real account — but it means every option in this object
was unasserted. The flag could have said anything.

Two things changed as a result:

- `listingUploadOptions()` is **extracted and exported** so `cloudinary.test.js` can assert on it,
  including an explicit regression test that `image_metadata` is absent.
- The claim was **verified against the real provider rather than reasoned about**: a JPEG carrying an
  Exif APP1 segment with GPS tags and a marker string went in at 246 bytes, and the re-downloaded
  stored original came back at 160 with neither the `Exif` header nor the marker.

**The general lesson.** A test-mode fake that short-circuits before the provider is reached leaves
everything past that point unverified, and a confident comment is not evidence. When a config value
is the whole of a safety control, assert it — and confirm the behaviour end to end at least once
against the real thing.

---

## "Confirming your email…" span forever — a ref guard and a `cancelled` flag deadlocked

**Symptom.** `/verify/:token` sat on its loading spinner indefinitely (minutes), never
reaching either the success or the failure state. **Development only.** The request was
made correctly and answered `200`; devtools showed nothing wrong.

**Root cause: two individually-correct guards that cancel each other out under
StrictMode.** `VerifyPage` had *both* a `useRef` guard (so a single-use token is not
consumed twice) and a `cancelled` flag in the effect cleanup (so state is not set after
unmount). React 18's StrictMode double-invokes effects in development:

```
1. effect #1  → attempted = true, cancelled₁ = false, request fires
2. StrictMode → cleanup₁ runs → cancelled₁ = true
3. effect #2  → attempted is already true → EARLY RETURN
                (no second request, and no fresh cancelled flag)
4. response   → `if (cancelled₁) return` is TRUE → setState never runs
```

One request correctly made, its answer silently discarded. The ref guard suppressed
the retry; the *discarded* first pass's flag suppressed the result.

**Fix.** Remove the `cancelled` flag; keep the ref guard. Safe rather than a trade-off:
StrictMode remounts the **same component instance** — which is why a ref survives to
guard anything at all — so the component is still mounted when the response lands. And
React 18 removed the "state update on an unmounted component" warning precisely because
these flags caused more bugs than they prevented.

**The rule: never combine a `useRef` run-once guard with a `cancelled` cleanup flag in
the same effect.** Either alone is fine. `AuthContext.jsx` and `RegisterPage.jsx` both
use a `cancelled` flag with **no** ref guard, so their effect #2 re-fires with a fresh
flag and sets state normally — those are correct and were left alone.

**Why the suite was green.** There *was* a test called *"consumes the token exactly
once, despite StrictMode"* — and it never rendered inside `StrictMode`. Its `renderApp`
helper wrapped the tree in `MemoryRouter` + `AuthProvider` only, so the double-invoke
never happened and the test passed by asserting a call count in a world where the bug
could not occur.

Two lessons, both now encoded:

- **A test that names a mode must actually enter it.** `renderApp` takes a
  `{ strict: true }` option and that test uses it, so it renders the way `main.jsx`
  really does. Verified the honest way: the test was changed *first* and watched to fail
  with `Unable to find role="heading"` — reproducing the spinner — before the fix was
  applied.
- **Asserting "the request happened once" is not asserting "the user saw an answer."**
  A guard that suppresses the retry is worthless if it also suppresses the result, and
  only a terminal-state assertion catches that. Every effect-driven page should assert
  it reaches success *or* failure, never just the call count.

---

## A verification link opened the WRONG APP's 404 page — Vite had silently taken another port

**Symptom.** Clicking the emailed verification link showed a "404 — Page not found"
page. The address bar said `localhost:5174`, which is RentEasy's configured port, and
`APP_URL` in `server/.env` was correct. But the 404 page was branded **"Service
Center"**, and devtools showed `:5174/api/auth/me` answering `401`.

**Root cause. `strictPort` was not set, so Vite silently moved each dev server onto the
next free port.** Vite's default when its configured port is busy is to **increment**,
announcing it once in a startup banner nobody rereads. The result:

| Port | Actually running | Configured for |
|---|---|---|
| 5173 | *nothing* | service-center client |
| **5174** | **service-center client** ← drifted up from 5173 | **RentEasy client** |
| **5175** | **RentEasy client** ← drifted, 5174 was taken | — |

Something held 5173 when service-center started, so it took 5174. RentEasy's client
then found 5174 taken and went to 5175. Whatever originally held 5173 had since exited,
leaving no evidence. Meanwhile every emailed link still pointed at `APP_URL`
(`http://localhost:5174`) — where a different application answered and, having no
`/verify/:token` route, correctly rendered its own 404.

**Nothing looked broken.** Both dev servers started clean, both apps rendered, and the
link in the email was exactly right.

**Fix.** `strictPort: true` in **both** projects' `client/vite.config.js`. The second
server to start now dies with `Port 5174 is already in use` instead of quietly
borrowing a neighbour's port. Restart both clients so each lands where it is
configured.

**How to recognise it next time — and the mistake made while diagnosing it.** The first
check run here was `curl -s -o /dev/null -w "%{http_code} %{size_download}"` against
`http://localhost:5174/verify/testtoken123`. It returned **200 and 1192 bytes**, which
was read as "the SPA fallback works, so the route is fine". **It proved nothing**: every
Vite app in this repo serves an `index.html` of roughly that size for any unmatched
path. It was the *other* app's index.html. Identify the responder, never just its
status:

```bash
curl -s http://localhost:5174/ | grep -i "<title>"
```

```bash
netstat -ano | grep ":5174" | grep LISTENING
```

Then resolve the PID to a command line, which names the project outright:

```bash
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter 'ProcessId=1234' | Select -Expand CommandLine"
```

**This is the second time a port clash has cost a debugging session here** (see the
entry below, where RentEasy's frontend proxied to service-center's *backend*). Same
root cause both times — relying on a port being free rather than asserting it. The
general rule now: **assign explicit ports AND make the process refuse to run on any
other one.** A dev server that quietly relocates is worse than one that will not start,
because the damage lands somewhere unrelated — in an email sent hours later.

---

## Mail: three failures carried over from another project, recorded before they happen again

**Not diagnosed here** — these were each paid for once on the other Brevo project on this machine,
and the code was written to absorb or name them. Listed so a 401 does not start from scratch.

**A 401 saying `Key not found` almost always means the wrong *kind* of key.** Brevo's *SMTP* tab
issues an `xsmtpsib-` credential for the SMTP relay; the HTTP API only accepts an `xkeysib-` key from
the *API Keys* tab. The message names the key rather than the scheme, which sends you looking for a
typo in a value that is perfectly correct.

**A quoted `MAIL_FROM` works locally and breaks in production.** dotenv strips one surrounding pair
of quotes from a `.env` *file*; a hosting dashboard stores the value verbatim, so the quotes become
part of the address. `mailer.js`'s `parseMailFrom` now absorbs both quoting mistakes
(`"Name <addr>"` and `"Name" <addr>`) — but enter it unquoted in a dashboard regardless.

**SMTP is not an alternative if the HTTP API misbehaves.** On the other project, Render blocks
outbound SMTP: ports 587 and 465 both fail with a TCP connect timeout before any TLS, and a silent
drop rather than `ECONNREFUSED` is the signature of a firewall. Before that surfaced it failed more
confusingly still — nodemailer resolves A and AAAA records separately and picks one *at random*, so
sends died with `ENETUNREACH` on an IPv6 address whenever the coin landed that way. HTTPS on 443 is
what works, and is why this project has no SMTP code at all.

---

## "Not able to register" — the frontend was talking to a different project's backend

**Symptom.** The registration form's **Create account** button appeared permanently
disabled, and registration was impossible. No error, no console message, nothing to
click.

**Root cause — two layers, and the second is what made it baffling.**

Another project on the same machine runs its API on **port 5000** and its dev server on
**5173** — the Express and Vite defaults. RentEasy used the same two. With the other
project's server already listening on 5000, RentEasy's frontend proxied `/api` straight
to **the wrong application**.

That backend has `/api/auth/login` and `/api/auth/me`, so it looked alive and
`/api/health` answered `200` — which is exactly why this did not look like a
port problem. But it has no `/api/auth/register` and no `/api/auth/terms/current`.

The missing terms endpoint is what actually disabled the button:

```
GET /api/auth/terms/current  →  404
     → the terms fetch fails, `terms` stays null
     → RegisterPage renders <Button disabled={!terms}>
     → the form can never be submitted
```

The button being disabled is *correct* behaviour — the server refuses a stale terms
version with a `409`, so a button that could only fail would be worse. It was doing its
job against a backend that could never answer.

**Fix.** RentEasy moved to **5001** (API) and **5174** (dev server), in
`server/.env`, `server/.env.example` and `client/vite.config.js`. `APP_URL` moved to
`http://localhost:5174` so verification links point at the right frontend.

**How to recognise it next time.** Ask the API for something only THIS project has:

```bash
curl -s http://localhost:5001/api/auth/terms/current
```

A `404` from an endpoint you know exists means you are talking to another application.
`/api/health` answering `200` proves nothing — every project here has one.

**The general lesson.** A port clash is one of the most misleading failures available: the
dev server starts, the page renders, requests get real HTTP responses — and they come
from somewhere else entirely. **Assign every project explicit, distinct ports rather than
taking the framework defaults.** Two projects both using 5000/5173 will collide the first
time you run them together, and the symptom will point anywhere but at the port.

## A guard that never fired — a BEFORE trigger cannot see a generated column

**Symptom.** FR-206 says a blackout may not cover a confirmed booking. The trigger enforcing it
was written, the migration applied cleanly, and blackouts over confirmed bookings were accepted
anyway. Nothing errored.

**Root cause.** The trigger was `BEFORE INSERT OR UPDATE`, and it compared `b.period && NEW.period`.
`period` is a **stored generated column**, and Postgres computes those *after* row-level BEFORE
triggers run — so `NEW.period` was `NULL`. `anything && NULL` is `NULL`, which is not true, so
`IF FOUND` never fired and the guard matched nothing.

**Fix.** `AFTER INSERT OR UPDATE`. The row is inserted and the exception rolls it back, which for a
validation trigger is equivalent — and it avoids re-deriving `tstzrange(starts_at, ends_at, '[)')`
inside the trigger, where it could drift from the column's own definition.

**Why this one is worth remembering.** It **failed open**. A guard that fails closed announces
itself on the first ordinary use; one that fails open looks like a working feature indefinitely.
The only reason it was caught before shipping is that the test suite tried to *defeat* the rule
rather than exercise the happy path. **Any guard that can fail open needs a test that attempts the
thing it forbids** — asserting the allowed case still works proves nothing about it.

Same family: a `NOT NULL` you forgot, a `CHECK` on a column that is always null, an `EXCLUDE` whose
`WHERE` never matches. All silent.

## Nine tests "failed" that pass alone — two suites sharing one test database

**Symptom.** A full server run reported 9 failures across 2 files. Re-running either file on its
own passed. So did the whole suite, a minute later.

**Root cause.** Two `vitest run` invocations were in flight against `renteasy_test` at once — one
left in the background, one started in the foreground. The suite truncates tables between tests, so
each run was deleting the other's fixtures mid-test.

**The tell.** Failures scattered across unrelated files, each one an assertion about data that
should exist and doesn't — a `200` that came back `404`, a count that came back short. A real
regression clusters around what changed; this pattern is a shared-resource collision.

**Rule.** **Never run two server suites at once on this machine.** Run one, wait, run the other.
Backgrounding a test run and then starting another is the easy way to do this by accident. The
client suite is safe to run alongside a server one — it touches no database — but a machine busy
with both is slow enough to produce timeout failures that look just as real.

# Troubleshooting

Solved problems, so nothing is diagnosed twice. Symptom, root cause, fix.

Newest first.

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

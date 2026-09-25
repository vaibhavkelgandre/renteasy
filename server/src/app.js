/**
 * The Express application.
 *
 * THE most important structural decision in the project, and the reason this file is
 * separate from server.js: this module builds and exports the app but NEVER calls
 * `app.listen()`.
 *
 * Why that matters: Supertest takes the app OBJECT and drives it in-process. So the
 * test suite makes real HTTP requests through real middleware and real routes without
 * binding a TCP port. That means:
 *   - tests never collide on a port, so they can run in parallel and in CI
 *   - there is no server to start and stop around each test
 *   - nothing has to guess when the server is "ready"
 *
 * If `listen()` lived here, importing this file inside a test would start a server as
 * a side effect - and two test files would then fight over port 5000. Every "why do my
 * API tests hang in CI?" question traces back to that mistake.
 *
 * server.js owns listening. This file owns what the app IS.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { env } from "./config/env.js";
import { healthRoutes } from "./routes/healthRoutes.js";
import { authRoutes } from "./routes/authRoutes.js";
import { profileRoutes, publicUserRoutes } from "./routes/profileRoutes.js";
import { listingRoutes } from "./routes/listingRoutes.js";
import { bookingRoutes } from "./routes/bookingRoutes.js";
import { notificationRoutes } from "./routes/notificationRoutes.js";
import { reviewRoutes } from "./routes/reviewRoutes.js";
import { sendError } from "./utils/response.js";

const app = express();

// Trust the first proxy hop. Needed once this runs behind Nginx or a platform load
// balancer, so `req.ip` is the real client address and not the proxy's. It is what
// makes per-IP rate limiting (step 2 onward) meaningful rather than counting every
// visitor as one key. Set now, while the reason is written down.
app.set("trust proxy", 1);

// Never advertise the framework. Free information for someone scanning for known
// Express vulnerabilities, and no benefit to anyone else.
app.disable("x-powered-by");

// Security headers. Helmet's defaults (HSTS, X-Content-Type-Options: nosniff,
// X-Frame-Options, a locked-down CSP, Referrer-Policy, etc.) are a reasonable
// baseline on their own — the only thing that has to be TAUGHT here is the handful of
// origins this app genuinely talks to, and app.js is the one place that already
// knows the deploy is single-origin (see the static-client block below).
//
// Three directives are widened past helmet's "same-origin only" default, each for a
// specific, load-bearing reason:
//   - imgSrc: public listing photos are served straight from Cloudinary
//     (config/cloudinary.js's `publicDeliveryUrl`, res.cloudinary.com), never proxied
//     through this app the way private booking/message photos are.
//   - styleSrc / fontSrc: client/index.html loads the one typeface (Manrope) from
//     Google Fonts — the stylesheet from fonts.googleapis.com, the font files
//     themselves from fonts.gstatic.com.
// connectSrc is left at the helmet default ('self') deliberately: the API and the
// Socket.IO handshake are same-origin by design (see app.js's own header comment on
// why one service serves both), so there is nothing else for the client to reach.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        "img-src": ["'self'", "data:", "https://res.cloudinary.com"],
        "style-src": ["'self'", "https://fonts.googleapis.com"],
        "font-src": ["'self'", "https://fonts.gstatic.com"],
      },
    },
    // require-corp would block the cross-origin Google Fonts stylesheet/files above
    // unless Google itself sends a matching Cross-Origin-Resource-Policy header — not
    // something this app controls, and not worth the fragility for a font. Nothing
    // here needs SharedArrayBuffer or the other isolation guarantees COEP exists for.
    crossOriginEmbedderPolicy: false,
  })
);

// Parse JSON request bodies. The size limit is deliberate: the default is 100kb, and
// nothing this API accepts as JSON is anywhere near that. File uploads (step 7) use
// multipart and are capped separately.
app.use(express.json({ limit: "100kb" }));

// Parses the Cookie header into `req.cookies`, which is where the session token
// arrives (utils/cookies.js). Express does not do this itself — without this line
// `req.cookies` is undefined and every authenticated request 401s, which reads as a
// broken login rather than a missing middleware.
//
// No secret is passed, deliberately: cookie-parser's signing feature would be
// redundant here. The cookie's VALUE is a JWT that is already signed and verified by
// utils/jwt.js, so a second signature layer adds a second secret to manage and
// protects nothing.
app.use(cookieParser());

// ---- Routes ----
// Everything lives under /api so a reverse proxy can route by prefix, and the
// frontend can be served from the same origin at "/". Same-origin is what lets the
// auth cookie be first-party rather than blocked as third-party by default.
app.use("/api/health", healthRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/profile", profileRoutes);
app.use("/api/users", publicUserRoutes);
app.use("/api/listings", listingRoutes);
app.use("/api/bookings", bookingRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/reviews", reviewRoutes);

// ---- The built client ----
//
// ONE SERVICE SERVES BOTH, and that is a deployment decision this application cannot
// opt out of. The client hardcodes `BASE = "/api"` and opens its socket with `io()`
// against the page's own origin; there is no VITE_API_URL and no CORS middleware
// anywhere, and the session cookie is `SameSite=Strict`. So the frontend and the API
// MUST be same-origin. Serving the build from here makes that true by construction,
// rather than by a proxy rule somebody has to get right.
//
// It is also what keeps the WebSocket working on Render: a web service supports an
// Upgrade natively, while a static site's rewrite rules do not proxy one — Socket.IO
// would silently fall back to long-polling and the transport would not be a socket at
// all.
//
// MOUNTED AFTER THE API, BEFORE THE 404, and both halves of that matter: earlier and
// a stray file could shadow an endpoint; later and every unmatched path would already
// have been answered with the JSON 404 below.
const clientDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../client/dist");
const clientIndex = path.join(clientDist, "index.html");

// Absent in development (Vite serves the client) and skipped under test, so the
// suite's 404 behaviour is exactly what it always was. Keyed on the build EXISTING
// rather than on NODE_ENV, so `npm start` after a local build behaves like production.
if (!env.isTest && existsSync(clientIndex)) {
  app.use(
    express.static(clientDist, {
      // The SPA fallback below owns "/", so static must not answer it and skip the
      // no-cache header that fallback needs.
      index: false,
      setHeaders(res, filePath) {
        // Vite fingerprints everything under assets/, so those filenames change
        // whenever their contents do and can be cached for a year. Everything else
        // served from here keeps a stable name (favicon and friends) and must be
        // revalidated instead.
        const fingerprinted = filePath.includes(`${path.sep}assets${path.sep}`);
        res.setHeader(
          "Cache-Control",
          fingerprinted ? "public, max-age=31536000, immutable" : "no-cache"
        );
      },
    })
  );

  app.use((req, res, next) => {
    // An unmatched /api path is a missing ENDPOINT and must answer the JSON 404, not
    // a page. Without this, a typo'd endpoint would return index.html with a 200 and
    // the client would fail on "Unexpected token <" instead of a readable error.
    if (req.path.startsWith("/api")) return next();

    // Every other path is a client route — /listings/:id, /bookings/:id — which the
    // router resolves in the browser. The server cannot know them and does not need
    // to.
    //
    // INDEX.HTML MUST NOT BE CACHED WITHOUT REVALIDATION: it is the one file whose
    // name never changes, so a stale copy after a deploy points the browser at
    // fingerprinted bundles that no longer exist. `sendFile` gives exactly that —
    // `public, max-age=0`, which permits caching but forces a revalidation on every
    // load — so nothing extra is needed here.
    //
    // Verified rather than assumed, because it is not obvious: `sendFile` sets that
    // header ITSELF and overrides anything set beforehand. Both `res.setHeader` and
    // `{ cacheControl: false }` were tried and neither changed the response.
    res.sendFile(clientIndex);
  });
}

// ---- 404 ----
// Reached only when no route above matched. Must come after every route and before
// the error handler; Express runs middleware in registration order, so putting this
// higher would swallow every request.
app.use((req, res) => {
  sendError(res, {
    status: 404,
    // Deliberately does not echo the requested path back. Reflecting user input into
    // a response is a habit worth not forming.
    message: "Not found",
  });
});

// ---- Error handler ----
// Express identifies an error handler by its ARITY: exactly four parameters. Drop
// `next` and Express silently treats it as ordinary middleware and never calls it on
// an error - a genuinely confusing bug, because the code looks correct. `next` is
// unused, hence the underscore.
//
// Express 5 (not 4) forwards a rejected promise from an async route here
// automatically. In Express 4 an async route that threw would hang the request
// forever with no response and no log. That improvement is why this project is on 5.
app.use((error, _req, res, _next) => {
  const status = error.status ?? 500;

  // LOG UNEXPECTED ERRORS ONLY, and this distinction matters more than it looks.
  //
  // A 401 from a wrong password or a 400 from a missing field is the application
  // WORKING — expected behaviour, deliberately thrown, already reported to the
  // caller. Logging a stack trace for each one produces two bad outcomes: in
  // production the log fills with noise and buries the real 500s, and in the test
  // suite every negative test prints a stack trace, so the one genuine failure is
  // invisible among twenty expected ones. (That is exactly how this was found.)
  //
  // 5xx is different: nobody threw it on purpose, so it is a bug and the stack is
  // the only way to find it.
  //
  // If failed logins ever need recording, that belongs in an explicit audit log with
  // a deliberate retention policy — not as a side effect of the generic error
  // handler.
  if (status >= 500) {
    console.error("[error]", error);
  }

  // Tell the client nothing about internals. A stack trace in a response body is
  // itself an information leak: it names file paths, dependencies and versions.
  //
  // `errors` must be forwarded, or the validator layer's field-level detail is built
  // and then silently dropped — the form shows a generic "Validation failed" banner
  // and cannot mark the offending input. Gated on `expose` for the same reason as
  // `message`: an unexpected error's properties are not ours to publish.
  sendError(res, {
    status,
    message: error.expose ? error.message : "Something went wrong",
    errors: error.expose ? (error.errors ?? {}) : {},
  });
});

export { app };

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

import express from "express";
import cookieParser from "cookie-parser";
import { healthRoutes } from "./routes/healthRoutes.js";
import { authRoutes } from "./routes/authRoutes.js";
import { profileRoutes, publicUserRoutes } from "./routes/profileRoutes.js";
import { listingRoutes } from "./routes/listingRoutes.js";
import { bookingRoutes } from "./routes/bookingRoutes.js";
import { notificationRoutes } from "./routes/notificationRoutes.js";
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

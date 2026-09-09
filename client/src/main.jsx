/**
 * Entry point.
 *
 * Provider order matters: BrowserRouter must be OUTSIDE AuthProvider, because the
 * guards inside call useLocation. Reversed, they render before a router exists and throw.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { AuthProvider } from "./context/AuthContext.jsx";
import { App } from "./App.jsx";
import "./index.css";

createRoot(document.getElementById("root")).render(
  // StrictMode double-invokes effects in DEVELOPMENT ONLY. It is not a bug and not
  // something to work around by removing this: it surfaces effects that are unsafe to
  // run twice. It found a real one here - VerifyPage consumes a single-use token, so
  // the second invocation would have reported a perfectly good link as broken. That
  // component now guards with a ref. Production runs each effect once.
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>
);

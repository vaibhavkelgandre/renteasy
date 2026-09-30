/**
 * The last line of defence against a blank screen.
 *
 * React has no hook equivalent for this — `getDerivedStateFromError` only exists on
 * a class component — so this is deliberately the one class component in an
 * otherwise all-function codebase.
 *
 * WRAPS THE WHOLE TREE, ABOVE THE ROUTER AND THE AUTH PROVIDER, not just `<App />`.
 * Either of those can throw too (a bad response shape, a context misuse), and a
 * boundary placed only inside them would not catch that — the point of this
 * component is to have nothing above it that can still fail silently.
 *
 * DOES NOT CATCH: errors in event handlers, async code, or the boundary's own
 * render — React's design, not an oversight here. Those already surface through
 * `try`/`catch` at the call site (see every service call in `lib/api.js`'s callers)
 * or the browser's own console; this component's job is only the render crash that
 * would otherwise unmount the entire app with no UI left to show.
 */

import { Component } from "react";
import { Card } from "./ui/Card.jsx";
import { Button } from "./ui/Button.jsx";

export class ErrorBoundary extends Component {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error, info) {
    // No error-reporting service is configured anywhere in this app (see
    // docs/1.status.md's known limitations) — the console is the only place this
    // is ever seen, same as every other uncaught path.
    console.error("[ErrorBoundary] a render crashed:", error, info);
  }

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div className="flex min-h-screen items-center justify-center bg-canvas p-6">
        <Card className="max-w-sm p-6 text-center">
          <h1 className="font-semibold text-ink">Something went wrong</h1>
          <p className="mt-2 text-sm text-muted">
            The page hit an error it could not recover from. Reloading usually fixes it.
          </p>
          <Button className="mt-4" onClick={() => window.location.reload()}>
            Reload
          </Button>
        </Card>
      </div>
    );
  }
}

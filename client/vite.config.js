/**
 * Vite configuration.
 *
 * THE PROXY IS LOAD-BEARING, not a convenience. Vite serves :5173 and the API runs on
 * :5000 - different ORIGINS to a browser. The session cookie is `SameSite=Strict`, so
 * without this proxy the browser would refuse to send it at all and every request
 * would 401 immediately after a sign-in that clearly succeeded.
 *
 * The proxy makes the browser believe there is one origin. In production Nginx does
 * the identical job, so development and production share one cookie model instead of
 * needing two configurations and a CORS policy that exists only locally.
 */

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  // Tailwind v4 is a VITE plugin, not a PostCSS one. There is no `tailwind.config.js`
  // and no `postcss.config.js` here on purpose - v4 configures itself from CSS. If you
  // follow a v3 tutorial you will go looking for both.
  plugins: [react(), tailwindcss()],

  server: {
    // 5174 and 5001, not the Vite/Express defaults of 5173 and 5000. Another project on
    // this machine already uses those, and a port clash fails in the most confusing way
    // possible: the dev server starts fine, the page loads fine, and every request is
    // quietly answered by a DIFFERENT application - so endpoints that exist return 404.
    port: 5174,

    // REFUSE TO START rather than take a different port, and this line is the whole
    // reason the clash described above is now detectable.
    //
    // Vite's default is to INCREMENT when its port is busy: 5174 -> 5175, announced
    // once in a startup banner nobody rereads. That is how this failed for real - the
    // other project on this machine drifted onto 5174, this one drifted to 5175, and
    // every emailed verification link kept pointing at 5174 (APP_URL) where a
    // DIFFERENT application answered and correctly 404'd. Nothing looked broken: both
    // dev servers started clean and both apps rendered.
    //
    // With strictPort the second one to start dies with "Port 5174 is already in
    // use" - a failure you can act on in five seconds.
    strictPort: true,

    proxy: { "/api": { target: "http://localhost:5001", changeOrigin: false } },
  },

  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/tests/setup.js"],
    // Well above vitest's 5s default: one `userEvent.type` of a sentence is dozens of
    // sequential React renders in jsdom, which is honestly slow. The default expires
    // on work that is progressing fine, which reads as a real failure.
    testTimeout: 15000,
  },
});

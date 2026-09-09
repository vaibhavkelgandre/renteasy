/**
 * The frame every page renders inside.
 *
 * Owns the header, the verification banner and the page width, so no page decides its
 * own. Without it one screen ends up 1152px wide and the next 1280px, and the whole
 * app feels like it shifts under you as you navigate.
 *
 * Wraps PUBLIC pages too - browsing needs no account, so the layout must not assume a
 * user. VerifyBanner and Header each handle the signed-out case themselves.
 */

import { Outlet } from "react-router-dom";
import { Header } from "./Header.jsx";
import { VerifyBanner } from "../VerifyBanner.jsx";

export function AppLayout() {
  return (
    <div className="flex min-h-full flex-col">
      <Header />
      <VerifyBanner />
      {/* max-w-6xl (1152px), narrower than an admin tool's. A grid of product cards
          reads better in a slightly tighter column than a data table does. */}
      <main className="mx-auto w-full max-w-6xl flex-1 px-5 py-8">
        <Outlet />
      </main>
    </div>
  );
}

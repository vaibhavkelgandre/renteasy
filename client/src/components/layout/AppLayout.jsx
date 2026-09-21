/**
 * The frame every page renders inside.
 *
 * Owns the header, the verification banner and the page width, so no page decides its
 * own. Without it one screen ends up 1152px wide and the next 1280px, and the whole
 * app feels like it shifts under you as you navigate.
 *
 * Wraps PUBLIC pages too — browsing needs no account, so the layout must not assume a
 * user. VerifyBanner and Header each handle the signed-out case themselves.
 */

import { Outlet } from "react-router-dom";
import { Header } from "./Header.jsx";
import { VerifyBanner } from "../VerifyBanner.jsx";

export function AppLayout() {
  return (
    // `bg-glow` is on the frame rather than on any page, so the warm wash at the top of
    // the window is a property of the product and not of one screen. It is anchored to
    // the top and given a fixed height in index.css — read the comment there before
    // moving this class, because on a tall page an unsized gradient stretches to the
    // whole scroll and stops being a glow at all. Far too soft to read as a shape: its
    // only job is stopping the top of a near-black page being a flat rectangle.
    <div className="flex min-h-full flex-col bg-glow">
      <Header />
      <VerifyBanner />
      {/* `max-w-content` (1440px) — defined once in index.css, because the header and
          the verification banner have to end at the same place this does.

          The gutter grows with the screen (`px-5` → `px-8`): at 1440px of content a
          five-pixel margin looks like the page is about to fall off the edge, while on
          a phone anything more eats width the content actually needs.

          ASYMMETRIC PADDING, DELIBERATELY. `py-8` put 32px above the first thing on
          every page, on top of a 64px sticky header and the title block's own margin —
          around 215px of nothing before any content on a short page, which made
          screens scroll that have no business scrolling. Space at the BOTTOM costs
          nothing, because it is below the last thing rather than above the first. */}
      <main className="mx-auto w-full max-w-content flex-1 px-5 pb-16 pt-6 lg:px-8">
        <Outlet />
      </main>
    </div>
  );
}

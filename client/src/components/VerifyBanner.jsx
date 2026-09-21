/**
 * "Confirm your email" — the visible half of the verification gate.
 *
 * WHY A PERSISTENT BANNER AND NOT A BLOCKING SCREEN: an unverified user can browse the
 * whole marketplace, and should. Blocking them behind a wall would hide the thing that
 * makes confirming worth doing. So the banner nags without obstructing, and the actual
 * refusal happens at the moment they try to list or book — where the reason is obvious
 * because they just clicked the button it applies to.
 *
 * Renders nothing for a verified user, or nobody.
 */

import { useState } from "react";
import { Button } from "./ui/Button.jsx";
import { useAuth } from "../context/AuthContext.jsx";
import { api } from "../lib/api.js";

export function VerifyBanner() {
  const { user, isVerified } = useAuth();
  const [state, setState] = useState("idle");

  if (!user || isVerified) return null;

  async function resend() {
    setState("sending");
    try {
      await api.post("/auth/verify/resend");
    } catch {
      // Deliberately ignored. The endpoint answers 202 whether it sent, was inside the
      // cooldown, or the account was already verified — there is nothing to report
      // except the same instruction, and an error here would be the client inventing a
      // failure the server did not report.
    }
    setState("sent");
  }

  return (
    // A TINTED STRIP, NOT A FILLED BAND. On the light build this was a solid amber bar;
    // on near-black the same treatment is the brightest thing on any page, permanently,
    // for a message that is a nudge rather than an error. The dark wash plus an amber
    // rule at the top carries it without shouting.
    <div className="border-b border-accent-line bg-accent-soft">
      <div className="mx-auto flex max-w-content flex-col gap-3 px-5 py-2.5 sm:flex-row sm:items-center sm:justify-between lg:px-8">
        <p className="flex items-start gap-2.5 text-sm leading-relaxed text-ink-soft">
          <svg
            className="mt-0.5 size-4 shrink-0 text-accent"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="2" y="4" width="20" height="16" rx="2" />
            <path d="m22 7-10 6L2 7" />
          </svg>

          <span>
            {state === "sent" ? (
              <>
                {/* The SAME message regardless of what actually happened server-side —
                    sent, too soon, already verified. It mirrors the API's own single
                    answer, and it is honest: in every case the next step really is
                    "check your inbox". */}
                <span className="font-semibold text-ink">Check your inbox.</span> We&rsquo;ve
                sent a confirmation link to {user.email}.
              </>
            ) : (
              <>
                <span className="font-semibold text-ink">Confirm your email</span> to start
                listing your things or booking from others.
              </>
            )}
          </span>
        </p>

        {state !== "sent" && (
          <Button
            size="sm"
            variant="outline"
            loading={state === "sending"}
            onClick={resend}
            className="shrink-0 self-start border-accent-line text-accent hover:border-accent hover:bg-accent/10 hover:text-accent sm:self-auto"
          >
            Resend link
          </Button>
        )}
      </div>
    </div>
  );
}

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
    <div className="border-b border-amber-200 bg-amber-50">
      <div className="mx-auto flex max-w-content flex-col gap-3 px-5 py-3 sm:flex-row sm:items-center sm:justify-between lg:px-8">
        <p className="text-sm leading-relaxed text-amber-900">
          {state === "sent" ? (
            <>
              {/* The SAME message regardless of what actually happened server-side —
                  sent, too soon, already verified. It mirrors the API's own single
                  answer, and it is honest: in every case the next step really is
                  "check your inbox". */}
              <span className="font-medium">Check your inbox.</span> We&rsquo;ve sent a
              confirmation link to {user.email}.
            </>
          ) : (
            <>
              <span className="font-medium">Confirm your email</span> to start listing
              your things or booking from others.
            </>
          )}
        </p>

        {state !== "sent" && (
          <Button
            size="sm"
            variant="outline"
            loading={state === "sending"}
            onClick={resend}
            className="shrink-0 self-start border-amber-300 bg-white/60 hover:bg-white sm:self-auto"
          >
            Resend link
          </Button>
        )}
      </div>
    </div>
  );
}

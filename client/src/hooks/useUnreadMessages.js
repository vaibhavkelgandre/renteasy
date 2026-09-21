/**
 * How many messages are waiting, for the nav's dot.
 *
 * SEPARATE FROM THE BELL'S COUNT, deliberately. A notification and an unread message
 * are different things — you can have read every notification and still owe somebody
 * a reply — so merging them into one number would make both less meaningful.
 *
 * 60 seconds, matching the bell. The thread page polls at 3s while it is open; this
 * only has to say "something is waiting" from anywhere else in the app.
 */

import { useEffect, useState } from "react";
import { api } from "../lib/api.js";

const POLL_MS = 60_000;

/**
 * @param {boolean} enabled False when signed out — there is nobody to count for.
 * @returns {number}
 */
export function useUnreadMessages(enabled) {
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    if (!enabled) {
      // Reset rather than leave the last number behind: signing out must not leave
      // a dot on a nav the next person sees.
      setUnread(0);
      return undefined;
    }

    // Silent on failure. A dot that cannot be refreshed should show the last thing
    // it knew, not interrupt a page.
    const load = () =>
      api
        .get("/bookings/messages/unread-count")
        .then((data) => setUnread(data.total))
        .catch(() => {});

    load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [enabled]);

  return unread;
}

/**
 * Every legal move a booking can make — FR-505, FR-506.
 *
 * ONE PLACE, AND THIS IS THE PLACE. The requirement is explicit that the map lives
 * somewhere a reader can find rather than being implied by conditionals scattered
 * through handlers, and the reason is practical: "can this booking be cancelled?" is
 * asked by the service, by the client deciding which buttons to render, and by anyone
 * reviewing whether the rules are right. Three copies of that answer become three
 * different answers.
 *
 * Nothing here touches a database or a request. It is a lookup table and two functions
 * over it, so the whole rule set can be read in one screen and tested exhaustively.
 */

/**
 * The states, and what each one means.
 *
 * REQUESTED  the renter has asked; the owner has not answered. Holds no dates.
 * ACCEPTED   the owner has committed. HOLDS THE DATES (see migration 006).
 * ACTIVE     the renter physically has the item. Still holds the dates.
 * RETURNED   the item is back; money and condition not yet settled.
 * COMPLETED  finished.
 * DECLINED   the owner said no.
 * CANCELLED  either party pulled out before handover.
 * EXPIRED    the owner never answered in time (FR-508).
 */
export const BOOKING_STATES = [
  "REQUESTED",
  "ACCEPTED",
  "ACTIVE",
  "RETURNED",
  "COMPLETED",
  "DECLINED",
  "CANCELLED",
  "EXPIRED",
];

/** States from which nothing further can happen. */
export const TERMINAL_STATES = ["COMPLETED", "DECLINED", "CANCELLED", "EXPIRED"];

/**
 * Actions, each with the states it is legal from, where it leads, and who may do it.
 *
 * `actor` is a ROLE IN THIS BOOKING — "owner" means the owner of the listing, not a
 * platform role. This product has no role hierarchy; every permission is a
 * relationship to a record.
 *
 * `system` is the expiry sweep, which has no human actor. Recording the owner as
 * having expired their own request would put a false action in an append-only trail
 * whose entire value is that it is true.
 */
export const BOOKING_ACTIONS = {
  ACCEPT: {
    from: ["REQUESTED"],
    to: "ACCEPTED",
    actors: ["owner"],
    // Only on the way INTO a dates-holding state does the overlap question arise.
    // Several people may hold REQUESTED bookings for one weekend; accepting is the
    // moment that has to become exactly one.
    claimsDates: true,
  },

  DECLINE: {
    from: ["REQUESTED"],
    to: "DECLINED",
    actors: ["owner"],
  },

  /**
   * FR-509. The renter pulling out.
   *
   * Legal from ACCEPTED as well as REQUESTED — "before handover" is the requirement,
   * and handover is what moves a booking to ACTIVE. Once the renter physically has the
   * item, the way out is to return it, not to cancel.
   */
  CANCEL: {
    from: ["REQUESTED", "ACCEPTED"],
    to: "CANCELLED",
    actors: ["renter"],
  },

  /**
   * FR-510. The owner pulling out of a commitment they already made.
   *
   * A SEPARATE ACTION FROM `CANCEL`, not the same one with a different actor, and that
   * is deliberate: FR-510 says an owner cancellation "counts against their
   * reliability". Two actions means the audit trail records which of the two happened
   * without anyone having to infer it from the actor id later — and a reliability
   * score can be computed by counting rows rather than by joining to work out who each
   * actor was.
   *
   * Not legal from REQUESTED: refusing a request is DECLINE, which costs an owner
   * nothing. Only breaking a promise counts.
   */
  CANCEL_AS_OWNER: {
    from: ["ACCEPTED"],
    to: "CANCELLED",
    actors: ["owner"],
    countsAgainstOwner: true,
  },

  /** FR-508. No actor — see the note on `system` above. */
  EXPIRE: {
    from: ["REQUESTED"],
    to: "EXPIRED",
    actors: ["system"],
  },

  // ---- Step 8 (FR-700s) wires the three below. They are declared now because the
  // map is supposed to be the whole truth about what a booking can do; leaving them
  // out would make it a partial answer that reads like a complete one.
  START: {
    from: ["ACCEPTED"],
    to: "ACTIVE",
    actors: ["owner"],
    claimsDates: true,
  },
  RETURN: {
    from: ["ACTIVE"],
    to: "RETURNED",
    actors: ["owner"],
  },
  COMPLETE: {
    from: ["RETURNED"],
    to: "COMPLETED",
    actors: ["owner", "system"],
  },
};

/**
 * Which role a user holds in a booking, if any.
 *
 * @param {object} booking Must carry `renter_id` and `owner_id`.
 * @param {object|null} actor
 * @returns {"renter"|"owner"|null}
 */
export function roleInBooking(booking, actor) {
  if (!actor) return null;
  if (booking.renter_id === actor.id) return "renter";
  if (booking.owner_id === actor.id) return "owner";
  return null;
}

/**
 * Whether an action is legal, and if not, why.
 *
 * RETURNS A REASON RATHER THAN A BOOLEAN, because the two ways it can fail need
 * different HTTP answers and different words. "You are not allowed to do that" and
 * "that cannot be done to a cancelled booking" are not the same message, and telling
 * somebody the wrong one sends them looking in the wrong place.
 *
 * @param {object} input
 * @param {string} input.action
 * @param {string} input.status Current status.
 * @param {"renter"|"owner"|"system"|null} input.role
 * @returns {{ ok: true, to: string } | { ok: false, reason: "UNKNOWN_ACTION"|"WRONG_ACTOR"|"ILLEGAL_TRANSITION", to?: string }}
 */
export function checkTransition({ action, status, role }) {
  const rule = BOOKING_ACTIONS[action];
  if (!rule) return { ok: false, reason: "UNKNOWN_ACTION" };

  // ACTOR FIRST, STATE SECOND, and the order matters. Checking the state first would
  // tell a stranger that a booking they have nothing to do with is "already
  // cancelled" — a fact about somebody else's arrangement, disclosed for free.
  if (!rule.actors.includes(role)) return { ok: false, reason: "WRONG_ACTOR" };

  if (!rule.from.includes(status)) return { ok: false, reason: "ILLEGAL_TRANSITION", to: rule.to };

  return { ok: true, to: rule.to };
}

/**
 * Every action a given role may take on a booking right now.
 *
 * Exists so the client can render exactly the buttons that will work. A UI offering a
 * control the server refuses reads as a broken app; one that hides a control the
 * server would allow reads as a missing feature. Deriving both from this function
 * means neither can happen.
 *
 * @param {object} booking
 * @param {object|null} actor
 * @returns {string[]}
 */
export function availableActions(booking, actor) {
  const role = roleInBooking(booking, actor);
  if (!role) return [];

  return Object.keys(BOOKING_ACTIONS).filter(
    (action) => checkTransition({ action, status: booking.status, role }).ok
  );
}

/** Whether a status holds its dates against other bookings. Mirrors migration 006. */
export function holdsDates(status) {
  return status === "ACCEPTED" || status === "ACTIVE";
}

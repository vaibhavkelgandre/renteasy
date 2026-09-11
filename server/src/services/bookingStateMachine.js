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
 * REQUESTED    the renter has asked; the owner has not answered. Holds no dates.
 * ACCEPTED     the owner has committed. HOLDS THE DATES (see migration 006).
 * HANDED_OVER  the owner says they have given it over; the renter has not yet
 *              confirmed. HOLDS THE DATES — an unconfirmed handover is not a free
 *              item (migration 008 adds it to the exclusion constraint).
 * ACTIVE       the renter has confirmed they have it. Still holds the dates.
 * RETURNED     the renter says it is back; the owner has not yet confirmed condition.
 *              Deliberately does NOT hold the dates — the item is on the shelf, so an
 *              early return genuinely frees the remaining days.
 * COMPLETED  finished.
 * DECLINED   the owner said no.
 * CANCELLED  either party pulled out before handover.
 * EXPIRED    the owner never answered in time (FR-508).
 */
export const BOOKING_STATES = [
  "REQUESTED",
  "ACCEPTED",
  "HANDED_OVER",
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

  // ---- Step 8: handover, return and completion (FR-700 to FR-704, FR-708) ----
  //
  // THE RECEIVING PARTY CONFIRMS, AT BOTH ENDS. One side asserts the item moved and
  // the other side's confirmation is what advances the state:
  //
  //   owner asserts handover  -> HANDED_OVER -> renter confirms -> ACTIVE
  //   renter asserts return   -> RETURNED    -> owner confirms  -> COMPLETED
  //
  // Read literally, FR-700 says the owner's action makes a booking ACTIVE — which
  // would leave FR-701's "renter confirms receipt" doing nothing at all. Mirroring
  // the return side instead makes "you have my camera" something both people
  // asserted, which is the entire value of the record when it later goes wrong.

  /** FR-700. The owner says they have handed it over. Not yet agreed. */
  START: {
    from: ["ACCEPTED"],
    to: "HANDED_OVER",
    actors: ["owner"],
    claimsDates: true,
  },

  /**
   * FR-701. The renter agrees they have it.
   *
   * `system` is FR-708's timeout: a renter who never answers must not leave the
   * booking stuck forever holding dates. The sweep confirms on the strength of the
   * owner's assertion going unchallenged — recorded with no actor, so the trail never
   * claims the renter said something they did not.
   */
  CONFIRM_RECEIPT: {
    from: ["HANDED_OVER"],
    to: "ACTIVE",
    actors: ["renter", "system"],
    claimsDates: true,
  },

  /**
   * FR-703. THE RENTER marks it returned — and this is a correction.
   *
   * The first version of this map had `actors: ["owner"]`, which contradicted the
   * requirement outright. It also made no sense beside FR-704: if the owner both
   * declares the return and confirms it, the renter has no way to say "I gave it
   * back" and the two-sided record collapses to the owner's word.
   *
   * Legal from HANDED_OVER as well as ACTIVE. A renter who never got round to
   * confirming receipt but has now handed the thing back must not be stuck — and
   * returning it is a stronger admission of having had it than confirming receipt
   * would have been.
   */
  RETURN: {
    from: ["HANDED_OVER", "ACTIVE"],
    to: "RETURNED",
    actors: ["renter"],
  },

  /**
   * FR-704. The owner confirms the condition it came back in.
   *
   * `system` is FR-708 again, from the other side: an owner who never inspects must
   * not leave a renter's booking — and eventually their deposit — open indefinitely.
   */
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

/**
 * The statuses that hold their dates against other bookings.
 *
 * ONE DEFINITION, AND EVERY QUERY TAKES IT AS A PARAMETER. This list had been written
 * out by hand in five places — the exclusion constraint, the overlap pre-check, the
 * availability calendar, the browse date filter and the FR-206 blackout trigger — and
 * adding HANDED_OVER in step 8 found four of them still saying `('ACCEPTED',
 * 'ACTIVE')`. Three of those four were silent correctness bugs, not cosmetic:
 *
 *   the calendar would not have shown an item that was physically out
 *   "free between these dates" would have offered it
 *   an owner could have blacked out dates over a live handover
 *
 * Nothing errors in any of those cases. They just quietly answer wrong, which is why
 * the list is now a value passed into the SQL rather than a literal repeated in it.
 *
 * THE TWO PLACES THAT CANNOT TAKE A PARAMETER are the exclusion constraint and the
 * trigger, because a constraint cannot reference application code. Those are in
 * migration 008 with a comment pointing here, and there is a test that reads the
 * constraint out of the database and compares it against this array — which is the
 * only way the two can be kept honest.
 */
export const DATES_HELD_STATUSES = ["ACCEPTED", "HANDED_OVER", "ACTIVE"];

/**
 * Whether a status holds its dates against other bookings.
 *
 * @param {string} status
 * @returns {boolean}
 */
export function holdsDates(status) {
  return DATES_HELD_STATUSES.includes(status);
}

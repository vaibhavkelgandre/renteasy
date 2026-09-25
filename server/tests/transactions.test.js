/**
 * `withTransaction` (config/db.js) — the fix for booking writes that used to be two
 * independent statements with a gap between them.
 *
 * Two levels: the mechanism itself (commit, rollback, error propagation), proven
 * directly against a real table with no service layer in the way; then one
 * integration-level test through `actOnBooking` proving the actual bug this closes
 * — a failure writing the audit event must not leave the booking's status changed.
 */

import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { query, withTransaction } from "../src/config/db.js";
import * as bookingRepository from "../src/repositories/bookingRepository.js";
import { verifiedUser } from "./helpers/factories.js";

const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a" +
    "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA" +
    "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
  "base64"
);

const NEXT_MONTH = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
const iso = (days) => new Date(NEXT_MONTH.getTime() + days * 86_400_000).toISOString();

describe("withTransaction — config/db.js", () => {
  it("commits every write the callback makes when it resolves", async () => {
    const { user } = await verifiedUser(app);
    const newName = `Committed ${Date.now()}`;

    await withTransaction(async (tx) => {
      await tx(`UPDATE users SET name = $2 WHERE id = $1`, [user.id, newName]);
    });

    const { rows } = await query(`SELECT name FROM users WHERE id = $1`, [user.id]);
    expect(rows[0].name).toBe(newName);
  });

  it("rolls back every write the callback made once it throws", async () => {
    const { user } = await verifiedUser(app);
    const originalName = user.name;

    await expect(
      withTransaction(async (tx) => {
        await tx(`UPDATE users SET name = $2 WHERE id = $1`, [user.id, "Should not stick"]);
        throw new Error("simulated failure after the write");
      })
    ).rejects.toThrow("simulated failure after the write");

    // The write inside the failed transaction must be invisible — this is the whole
    // point of the helper, and the property a bare two-statement version could not
    // give: a crash between the two would have left the first one committed.
    const { rows } = await query(`SELECT name FROM users WHERE id = $1`, [user.id]);
    expect(rows[0].name).toBe(originalName);
  });

  it("rethrows the callback's own error, not a rollback error", async () => {
    // A ROLLBACK that itself fails must not replace the real error with a less
    // useful one — this pins that the ORIGINAL error object survives unchanged,
    // which is what lets a caller still branch on error.code exactly as it would
    // around a plain query() call (see actOnBooking's 23P01 handling).
    const marker = new Error("distinctive marker");
    marker.code = "CUSTOM_CODE";

    await expect(
      withTransaction(async () => {
        throw marker;
      })
    ).rejects.toBe(marker);
  });

  it("never leaves a client held — the pool is not exhausted by repeated failures", async () => {
    // If `release()` were skipped on the error path, ten failures would leak ten
    // connections and the pool (max: 10) would be exhausted, hanging every query
    // after. Running the pool's own default size worth of failed transactions and
    // then proving an ordinary query still answers is the cheapest real proof of
    // that.
    for (let i = 0; i < 10; i += 1) {
      await withTransaction(async () => {
        throw new Error(`failure ${i}`);
      }).catch(() => {});
    }

    await expect(query("SELECT 1")).resolves.toBeTruthy();
  });
});

describe("actOnBooking — the status change and its audit event are now atomic", () => {
  it("a failure recording the audit event leaves the booking's status UNCHANGED", async () => {
    const owner = await verifiedUser(app);
    const renter = await verifiedUser(app);

    const created = await owner.agent.post("/api/listings").send({
      title: "Canon EOS R6",
      description: "Full-frame mirrorless with two batteries.",
      category: "cameras",
      condition: "GOOD",
      dailyRatePaise: 80_000,
      locality: "Kothrud",
      city: "Pune",
    });
    const listingId = created.body.data.listing.id;
    await owner.agent.post(`/api/listings/${listingId}/photos`).attach("photos", JPEG, "p.jpg");
    await owner.agent.post(`/api/listings/${listingId}/publish`);

    const bookingId = (
      await renter.agent
        .post("/api/bookings")
        .send({ listingId, startsAt: iso(0), endsAt: iso(3) })
    ).body.data.booking.id;

    // Simulates the exact failure this fix exists for: `updateBookingStatus`
    // succeeds, and the very next statement — recording WHY the status changed —
    // fails. Before this fix, the status change would already be committed on its
    // own statement and would survive; the fix's whole claim is that it no longer
    // does.
    const spy = vi
      .spyOn(bookingRepository, "insertBookingEvent")
      .mockRejectedValueOnce(new Error("simulated crash writing the audit event"));

    const response = await owner.agent
      .post(`/api/bookings/${bookingId}/actions`)
      .send({ action: "ACCEPT" });

    expect(response.status).toBe(500);

    const { rows } = await query(`SELECT status FROM bookings WHERE id = $1`, [bookingId]);
    expect(rows[0].status).toBe("REQUESTED");

    // And no orphan event was written either — only the opening REQUESTED event
    // from creating the booking, never a second one for the failed ACCEPT.
    const events = await query(`SELECT to_status FROM booking_events WHERE booking_id = $1`, [
      bookingId,
    ]);
    expect(events.rows.map((r) => r.to_status)).toEqual(["REQUESTED"]);

    spy.mockRestore();

    // The booking is still genuinely actionable afterwards — the failure did not
    // leave it wedged in some in-between state a retry cannot recover from.
    const retry = await owner.agent
      .post(`/api/bookings/${bookingId}/actions`)
      .send({ action: "ACCEPT" });
    expect(retry.status).toBe(200);
    expect(retry.body.data.booking.status).toBe("ACCEPTED");
  });
});

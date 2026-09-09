/**
 * Profile routes.
 *
 * Read top to bottom, this file answers "what URLs exist and who may call them?".
 * Middleware order in each line is execution order.
 *
 * Everything under `/profile` acts on the CALLER's own record, taken from the session.
 * There is no `/profile/:id`, deliberately: with no such route there is no chance of an
 * authorization check being forgotten on it. Reading somebody ELSE's profile is a
 * different, deliberately tiny thing — see publicProfileRoutes below.
 */

import { Router } from "express";
import {
  getMyProfile,
  patchMyProfile,
  patchMyEmail,
  deleteMyPendingEmail,
  patchMyPassword,
  postAccountDeletion,
  getPublicUserProfile,
} from "../controllers/profileController.js";
import {
  updateProfileSchema,
  changeEmailSchema,
  changePasswordSchema,
  deleteAccountSchema,
  publicProfileParamsSchema,
} from "../validators/profileValidator.js";
import { validateBody, validateParams } from "../validators/validate.js";
import { requireAuth } from "../middlewares/authMiddleware.js";

const router = Router();

// Every route below needs a session. Applied once at the top rather than repeated per
// line, so a route added later cannot be left unguarded by omission - the failure mode
// of the per-line style.
router.use(requireAuth);

router.get("/", getMyProfile);

router.patch("/", validateBody(updateProfileSchema), patchMyProfile);

// Deliberately NOT gated on a verified email. Someone whose address was mistyped at
// signup is exactly who needs this most, and requireVerifiedEmail here would trap them
// permanently: unable to confirm the wrong address, and unable to change it.
router.patch("/email", validateBody(changeEmailSchema), patchMyEmail);
router.delete("/email", deleteMyPendingEmail);

router.patch("/password", validateBody(changePasswordSchema), patchMyPassword);

// POST, not DELETE on /profile. DELETE would read as "remove this resource" and imply
// the row is gone; this is a soft delete with a body (the password confirmation), and
// DELETE with a body is poorly supported by enough clients to be worth avoiding.
router.post("/deletion", validateBody(deleteAccountSchema), postAccountDeletion);

/**
 * The public read, mounted separately because it is the one route in this file that
 * takes NO session — a listing has to name its owner to a visitor who has no account.
 *
 * It lives here rather than in a users router of its own because the projection it
 * returns is defined by the profile feature, and splitting them would make it easy to
 * widen one without noticing the other.
 */
const publicRouter = Router();

publicRouter.get(
  "/:id/public",
  // Shape-checks the id before it reaches SQL, and answers 404 - not 400 - for a
  // malformed one. From outside, "that is not a UUID" and "no such person" are the
  // same answer, and the message must match the service's own 404 exactly or the pair
  // becomes an oracle.
  validateParams(publicProfileParamsSchema, "Profile not found"),
  getPublicUserProfile
);

export { router as profileRoutes, publicRouter as publicUserRoutes };

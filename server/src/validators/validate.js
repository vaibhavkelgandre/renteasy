/**
 * Generic request validation middleware.
 *
 * One implementation for body, query and params, so every endpoint reports a
 * validation failure in the same shape and no route hand-rolls its own checking.
 */

import { badRequest, notFound } from "../utils/errors.js";

/**
 * Flattens a Zod error into `{ field: message }`.
 *
 * One message per field — the first — because a form showing three errors under one
 * box is noise, and the first is the one that needs fixing.
 *
 * @param {import("zod").ZodError} error
 * @returns {Record<string, string>}
 */
function flatten(error) {
  const errors = {};
  for (const issue of error.issues) {
    // `_` for a whole-object refinement (e.g. "provide at least one of…"), which has
    // an empty path and belongs to no single field.
    const field = issue.path.join(".") || "_";
    if (!errors[field]) errors[field] = issue.message;
  }
  return errors;
}

/**
 * Validates `req.body` and REPLACES it with the parsed result.
 *
 * Replacing matters: Zod strips unknown keys and applies transforms like `.trim()`
 * and `.toLowerCase()`, so downstream code receives exactly the declared shape. Left
 * as-is, a service would still see whatever extra fields the client sent.
 *
 * @param {import("zod").ZodTypeAny} schema
 * @returns {import("express").RequestHandler}
 */
export function validateBody(schema) {
  return (req, _res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) return next(badRequest("Validation failed", flatten(result.error)));
    req.body = result.data;
    next();
  };
}

/**
 * Validates the query string, exposing the result as `req.validatedQuery`.
 *
 * IT DOES NOT ASSIGN TO `req.query`, AND IT CANNOT. In Express 5 `req.query` became a
 * getter with no setter — assigning to it throws `Cannot set property query of #<...>
 * which has only a getter`. This is a real change from Express 4, where reassigning
 * it was the ordinary pattern and is what every older tutorial shows.
 *
 * So handlers read `req.validatedQuery`, which is also honest: `req.query` still holds
 * the raw strings, and the coerced, defaulted, capped version is a different object.
 *
 * @param {import("zod").ZodTypeAny} schema
 * @returns {import("express").RequestHandler}
 */
export function validateQuery(schema) {
  return (req, _res, next) => {
    const result = schema.safeParse(req.query);
    if (!result.success) return next(badRequest("Invalid query parameters", flatten(result.error)));
    req.validatedQuery = result.data;
    next();
  };
}

/**
 * Validates route params, exposing the result as `req.validatedParams`.
 *
 * The important job here is shape-checking an id BEFORE it reaches SQL. A non-UUID
 * passed to `WHERE id = $1` arrives at Postgres as an invalid uuid literal and raises
 * 22P02, which no error branch handles — so `/employees/banana` would answer 500 with
 * a stack trace instead of a clean 404.
 *
 * Deliberately NOT solved by mapping 22P02 in the error handler: that code arriving
 * from anywhere else is a genuine server-side bug and should keep surfacing as a 500.
 *
 * @param {import("zod").ZodTypeAny} schema
 * @param {string} [notFoundMessage="Not found"] MUST match the message the service
 *        uses for a genuinely absent record. If they differ, the pair becomes an
 *        oracle: "Not found" versus "Employee not found" tells a caller their id was
 *        the wrong *shape* rather than merely absent — which is precisely the
 *        distinction this handler exists to hide. There is a test asserting the two
 *        responses are byte-identical.
 * @returns {import("express").RequestHandler}
 */
export function validateParams(schema, notFoundMessage = "Not found") {
  return (req, _res, next) => {
    const result = schema.safeParse(req.params);

    // 404, NOT 400, and the errors are dropped rather than returned.
    //
    // From outside, "that id is the wrong shape" and "no employee has that id" are
    // the same answer: there is no such employee. Distinguishing them tells a caller
    // that ids are UUIDs and hands back nothing in return. A field-level message
    // naming the expected format would do the same.
    //
    // This holds while every route param in the app is an opaque id. A param that is
    // genuinely user-facing input (a date range in a path, say) would want 400 —
    // revisit here rather than papering over it at the call site.
    if (!result.success) return next(notFound(notFoundMessage));

    req.validatedParams = result.data;
    next();
  };
}

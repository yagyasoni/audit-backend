// ─────────────────────────────────────────────────────────────
// FILE: src/middleware/body.js
//
// How much JSON a request may carry.
//
//   default      100 KB   every route, read before any login check
//   large        25 MB    only the routes listed below, and only AFTER
//                         their own login check
//
// Why two steps: a body parser placed on a route cannot raise the limit once
// the app-wide parser has already refused the request. So the app-wide
// parser SKIPS the large routes, and each of those routes adds `largeJson`
// right after its login check.
//
// When a new route needs large JSON:
//   1) add it to LARGE_JSON_ROUTES
//   2) put `largeJson` on the route (or router) after the login check
// ─────────────────────────────────────────────────────────────
import express from "express";

export const largeJson = express.json({ limit: "25mb" });

const smallJson = express.json({ limit: "100kb" });

// [method or null for any, path pattern]
const LARGE_JSON_ROUTES = [
  // Admin area (master sheet save and other admin imports). The whole router
  // is behind the admin login; it adds largeJson right after that check.
  [null, /^\/admin(\/|$)/],
  // Creating / editing a post (content can carry inline images)
  ["POST", /^\/post\/posts\/?$/],
  ["PUT", /^\/post\/posts\/[^/]+\/?$/],
  // Sharing a report with a group (one row per drug)
  [
    "POST",
    /^\/api\/inventory-view\/groups\/[^/]+\/reports(\/[^/]+\/contribute)?\/?$/,
  ],
];

const isLargeJsonRoute = (req) =>
  LARGE_JSON_ROUTES.some(
    ([method, pattern]) =>
      (!method || method === req.method) && pattern.test(req.path),
  );

export function smallJsonUnlessLarge(req, res, next) {
  if (isLargeJsonRoute(req)) return next();
  return smallJson(req, res, next);
}

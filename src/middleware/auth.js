// ─────────────────────────────────────────────────────────────
// FILE: src/middleware/auth.js
//
// ONE place for all authentication. Every route file imports
// from here instead of defining its own guard.
//
//   requireAuth     → CLIENT token only   (JWT_SECRET)
//   requireAdmin    → ADMIN token only    (ADMIN_JWT_SECRET + role === "admin")
//   requireAnyAuth  → EITHER token        (for endpoints both sides read)
//
// Client tokens are signed with JWT_SECRET.
// Admin  tokens are signed with ADMIN_JWT_SECRET.
// Because the secrets differ, a client token can NEVER pass
// requireAdmin and an admin token can NEVER pass requireAuth.
// That separation is the whole point.
// ─────────────────────────────────────────────────────────────

import jwt from "jsonwebtoken";
import { pool } from "../config/db.js";

// Pull the raw token out of "Authorization: Bearer <token>"
function getBearerToken(req) {
  const header = req.headers.authorization || "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : null;
}

// ── CLIENT-ONLY ──────────────────────────────────────────────
// Use on any route a logged-in pharmacy should reach.
// Success → req.user = { userId, role }
export function requireAuth(req, res, next) {
  const token = getBearerToken(req);
  if (!token)
    return res.status(401).json({ message: "Authorization token missing" });

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (err) {
    if (err.name === "TokenExpiredError")
      return res.status(401).json({ message: "Token expired" });
    return res.status(401).json({ message: "Invalid token" });
  }
}

// ── PLAN GATE ────────────────────────────────────────────────
// Use AFTER requireAuth. Refuses with 403 unless the user's subscription
// has the given access flag (or full_access).
//   router.use(requireAuth, requirePlan("inventory_reports_access"))
const PLAN_FLAGS = [
  "inventory_reports_access",
  "inventory_view_access",
  "drug_lookup_access",
  "leads_access",
];

export function requirePlan(accessKey) {
  if (!PLAN_FLAGS.includes(accessKey))
    throw new Error(`requirePlan: unknown access key "${accessKey}"`);

  return async (req, res, next) => {
    try {
      const result = await pool.query(
        `SELECT ${accessKey} AS allowed, full_access
         FROM subscriptions WHERE user_id = $1`,
        [req.user.userId],
      );
      const sub = result.rows[0];
      if (!sub?.allowed && !sub?.full_access)
        return res
          .status(403)
          .json({ message: "Your plan does not include this feature" });
      next();
    } catch (err) {
      console.error("Plan check error:", err);
      return res.status(500).json({ message: "Failed to check subscription" });
    }
  };
}

// ── ADMIN-ONLY ───────────────────────────────────────────────
// Use on any admin-only route.
// Success → req.admin = { userId, role: "admin" }
export function requireAdmin(req, res, next) {
  const token = getBearerToken(req);
  if (!token)
    return res.status(401).json({ message: "Authorization token missing" });

  try {
    const decoded = jwt.verify(token, process.env.ADMIN_JWT_SECRET);
    if (decoded.role !== "admin")
      return res.status(403).json({ message: "Admin access only" });
    req.admin = decoded;
    next();
  } catch (err) {
    if (err.name === "TokenExpiredError")
      return res.status(401).json({ message: "Admin token expired" });
    return res.status(401).json({ message: "Invalid or expired admin token" });
  }
}

// ── EITHER SIDE ──────────────────────────────────────────────
// Use ONLY on routes both a client AND an admin legitimately read
// (e.g. GET a post chat thread, GET engagement counts).
// Tries the client secret first, then the admin secret.
// Success → req.user = decoded token,  req.role = "user" | "admin"
//           (req.admin is also set when the caller is an admin)
export function requireAnyAuth(req, res, next) {
  const token = getBearerToken(req);
  if (!token)
    return res.status(401).json({ message: "Authorization token missing" });

  // 1) Try as a client token
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    req.role = decoded.role || "user";
    return next();
  } catch (_) {
    // not a client token — fall through
  }

  // 2) Try as an admin token
  try {
    const decoded = jwt.verify(token, process.env.ADMIN_JWT_SECRET);
    req.user = decoded;
    req.admin = decoded;
    req.role = "admin";
    return next();
  } catch (_) {
    return res.status(401).json({ message: "Invalid or expired token" });
  }
}

// ── FEATURE GATE (plan OR admin) ─────────────────────────────
// Use on feature routes the client app reads/writes and an admin may
// also moderate. Accepts either token. Admins pass straight through;
// clients must hold the given access flag (or full_access) — the same
// rule as requirePlan, which it reuses.
//   router.use(requireFeature("inventory_view_access"))
export function requireFeature(accessKey) {
  const planCheck = requirePlan(accessKey); // validates accessKey up front

  return (req, res, next) =>
    requireAnyAuth(req, res, () => {
      if (req.role === "admin") return next();
      return planCheck(req, res, next);
    });
}

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

// ── ACCOUNT DELETED ──────────────────────────────────────────
// A browser can still be signed in when an admin deletes the account it
// belongs to. Wherever the server notices that the account is gone it
// answers with this one reply. The website looks for the code
// "ACCOUNT_DELETED" and shows its "Account No Longer Exists" popup
// (components/inactiveAccount.tsx, lib/api.ts in the frontend).
//   403 on normal requests: the website shows the popup and keeps the page.
//   401 from the session-renew route: there is no session to renew.
export const ACCOUNT_DELETED_CODE = "ACCOUNT_DELETED";

export function sendAccountDeleted(res, status = 403) {
  return res.status(status).json({
    code: ACCOUNT_DELETED_CODE,
    message: "This account no longer exists. Please contact support.",
  });
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
      const [account, result] = await Promise.all([
        pool.query(`SELECT status FROM users WHERE id = $1`, [
          req.user.userId,
        ]),
        pool.query(
          `SELECT ${accessKey} AS allowed, full_access
           FROM subscriptions WHERE user_id = $1`,
          [req.user.userId],
        ),
      ]);

      // The login is still valid but the account behind it was deleted (an
      // admin removed it while the user was signed in). Say exactly that, so
      // the website can show "account no longer exists" instead of a
      // subscription or "inactive" message.
      if (account.rows.length === 0) return sendAccountDeleted(res);

      // An account the admin has marked inactive cannot use the paid
      // features. The website already shows its "Account Inactive" popup
      // for anything but "active"; this makes the server say the same, so
      // the popup cannot be skipped with direct requests. Login, the token
      // refresh and the status/subscription checks are not behind this
      // gate, so the popup itself keeps working.
      if (account.rows[0]?.status !== "active")
        return res.status(403).json({
          code: "ACCOUNT_INACTIVE",
          message: "Your account is inactive. Please contact support.",
        });

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
export async function requireAdmin(req, res, next) {
  const token = getBearerToken(req);
  if (!token)
    return res.status(401).json({ message: "Authorization token missing" });

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.ADMIN_JWT_SECRET);
  } catch (err) {
    if (err.name === "TokenExpiredError")
      return res.status(401).json({ message: "Admin token expired" });
    return res.status(401).json({ message: "Invalid or expired admin token" });
  }

  if (decoded.role !== "admin")
    return res.status(403).json({ message: "Admin access only" });

  // Re-check the database, so an admin who was removed or is no longer an
  // admin is refused at once, not when the token runs out. A database
  // failure here is a server error, not "your login is invalid": answering
  // 401 would log a working admin out.
  let rows;
  try {
    ({ rows } = await pool.query(`SELECT role FROM users WHERE id = $1`, [
      decoded.userId,
    ]));
  } catch (err) {
    console.error("Admin check error:", err);
    return res.status(500).json({ message: "Failed to check admin access" });
  }
  if (!rows.length || rows[0].role !== "admin")
    return res.status(403).json({ message: "Admin access revoked" });

  req.admin = decoded;
  next();
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

  // 1) Try as a client token — role is always "user" regardless of token payload
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    req.role = "user";
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

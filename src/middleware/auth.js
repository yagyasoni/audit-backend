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

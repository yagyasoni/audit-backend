// ─────────────────────────────────────────────────────────────
// FILE: src/services/emailOtp.service.js
//
// One place for the 6-digit email codes (sign-up and admin login).
//
// The rules live in the SQL, so they hold when requests arrive in parallel:
//   • one code per email + purpose (a new code replaces the old one)
//   • a code is valid for OTP_TTL_MINUTES
//   • a code stops working after OTP_MAX_ATTEMPTS wrong tries
//   • a new code can be requested once per OTP_RESEND_COOLDOWN_SECONDS
//
// Needs migration 20261112_email_otp_limits.sql (attempts, purpose and
// created_at columns, unique index on email + purpose).
// ─────────────────────────────────────────────────────────────

import crypto from "crypto";
import jwt from "jsonwebtoken";
import { pool } from "../config/db.js";
import generateOTP from "../utils/otp.js";

export const OTP_PURPOSE = Object.freeze({
  SIGNUP: "signup",
  ADMIN_LOGIN: "admin_login",
});

export const OTP_TTL_MINUTES = 5;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_COOLDOWN_SECONDS = 60;

// ── ISSUE ────────────────────────────────────────────────────
// Create a new code for email + purpose, replacing any earlier one.
//
//   force: true   the step that STARTS a flow (sign-up, admin password step).
//                 Always issues.
//   force: false  a RESEND. Refused while the cooldown is running. With
//                 allowWhenLocked: false it is also refused once the current
//                 code has used up its tries, so the flow has to be started
//                 again.
//
// Returns { ok: true, otp }
//      or { ok: false, reason: "cooldown", retryAfter }   seconds left
//      or { ok: false, reason: "locked" }
export async function issueOtp(
  email,
  purpose,
  { force = false, allowWhenLocked = true } = {},
) {
  const otp = generateOTP();

  // A single statement: the cooldown test and the write cannot be split by a
  // second request for the same email.
  const issued = await pool.query(
    `INSERT INTO email_otps (email, purpose, otp, expires_at, attempts, created_at)
     VALUES ($1, $2, $3, NOW() + ($4::int * INTERVAL '1 minute'), 0, NOW())
     ON CONFLICT (email, purpose) DO UPDATE
        SET otp        = EXCLUDED.otp,
            expires_at = EXCLUDED.expires_at,
            attempts   = 0,
            created_at = NOW()
      WHERE $5::boolean
         OR (
              email_otps.created_at <= NOW() - ($6::int * INTERVAL '1 second')
              AND ($7::boolean OR email_otps.attempts < $8::int)
            )
     RETURNING id`,
    [
      email,
      purpose,
      otp,
      OTP_TTL_MINUTES,
      force,
      OTP_RESEND_COOLDOWN_SECONDS,
      allowWhenLocked,
      OTP_MAX_ATTEMPTS,
    ],
  );

  if (issued.rowCount > 0) return { ok: true, otp };

  // Refused. Work out why, so the caller can tell the user.
  const state = await pool.query(
    `SELECT attempts,
            CEIL(EXTRACT(EPOCH FROM (
              created_at + ($3::int * INTERVAL '1 second') - NOW()
            )))::int AS wait
       FROM email_otps
      WHERE email = $1 AND purpose = $2`,
    [email, purpose, OTP_RESEND_COOLDOWN_SECONDS],
  );
  const row = state.rows[0];

  if (row && !allowWhenLocked && row.attempts >= OTP_MAX_ATTEMPTS)
    return { ok: false, reason: "locked" };

  return {
    ok: false,
    reason: "cooldown",
    retryAfter: Math.max(1, Number(row?.wait) || 1),
  };
}

// ── CHECK ────────────────────────────────────────────────────
// Check a submitted code. A correct code is used up by the check, so it works
// exactly once.
//
// Every check against a live code first takes one of its tries. The UPDATE
// holds the row lock and re-tests "attempts < max" for each request, so no
// more than OTP_MAX_ATTEMPTS guesses are ever compared against one code, no
// matter how many arrive at the same moment.
//
// Returns { ok: true }
//      or { ok: false, reason: "wrong", attemptsLeft }
//      or { ok: false, reason: "locked" }    tries used up
//      or { ok: false, reason: "expired" }   no live code for this email
//      or { ok: false, reason: "invalid" }   not a 6-digit code
export async function checkOtp(email, purpose, submitted) {
  const code = String(submitted ?? "").trim();
  if (!email || !/^\d{6}$/.test(code)) return { ok: false, reason: "invalid" };

  const claimed = await pool.query(
    `UPDATE email_otps
        SET attempts = attempts + 1
      WHERE email = $1
        AND purpose = $2
        AND expires_at > NOW()
        AND attempts < $3::int
      RETURNING otp, attempts`,
    [email, purpose, OTP_MAX_ATTEMPTS],
  );

  if (claimed.rowCount === 0) {
    const locked = await pool.query(
      `SELECT 1
         FROM email_otps
        WHERE email = $1
          AND purpose = $2
          AND expires_at > NOW()
          AND attempts >= $3::int`,
      [email, purpose, OTP_MAX_ATTEMPTS],
    );
    return { ok: false, reason: locked.rowCount > 0 ? "locked" : "expired" };
  }

  const { otp, attempts } = claimed.rows[0];

  if (!sameCode(otp, code)) {
    const attemptsLeft = OTP_MAX_ATTEMPTS - attempts;
    return attemptsLeft > 0
      ? { ok: false, reason: "wrong", attemptsLeft }
      : { ok: false, reason: "locked" };
  }

  // Correct: use the code up. If a parallel request with the same code got
  // here first there is nothing left to delete, and this one fails.
  const used = await pool.query(
    `DELETE FROM email_otps
      WHERE email = $1 AND purpose = $2 AND otp = $3
      RETURNING id`,
    [email, purpose, code],
  );
  return used.rowCount > 0 ? { ok: true } : { ok: false, reason: "expired" };
}

function sameCode(stored, submitted) {
  const a = Buffer.from(String(stored ?? ""));
  const b = Buffer.from(submitted);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── ADMIN LOGIN: PASSWORD-STEP TOKEN ─────────────────────────
// Handed out by the password step of an admin login and required by the code
// step. An admin code can therefore only be checked or re-sent by the browser
// that has just entered the correct password.
//
// It is signed with a key DERIVED from ADMIN_JWT_SECRET, never with the
// secret itself. requireAdmin and requireAnyAuth verify with ADMIN_JWT_SECRET,
// so this token can never be accepted as an access token.
const ADMIN_OTP_TOKEN_TTL = "10m";
const ADMIN_OTP_TOKEN_PURPOSE = "admin_otp";

function adminOtpTokenKey() {
  const secret = process.env.ADMIN_JWT_SECRET;
  if (!secret) throw new Error("ADMIN_JWT_SECRET is not set");
  return crypto
    .createHmac("sha256", secret)
    .update("admin-otp-token:v1")
    .digest();
}

export function signAdminOtpToken(userId) {
  return jwt.sign(
    { userId, purpose: ADMIN_OTP_TOKEN_PURPOSE },
    adminOtpTokenKey(),
    { algorithm: "HS256", expiresIn: ADMIN_OTP_TOKEN_TTL },
  );
}

// Returns the decoded token, or null when it is missing, expired, forged or
// not a password-step token.
export function readAdminOtpToken(token) {
  if (!token || typeof token !== "string") return null;
  try {
    const decoded = jwt.verify(token, adminOtpTokenKey(), {
      algorithms: ["HS256"],
    });
    return decoded?.purpose === ADMIN_OTP_TOKEN_PURPOSE && decoded.userId
      ? decoded
      : null;
  } catch {
    return null;
  }
}

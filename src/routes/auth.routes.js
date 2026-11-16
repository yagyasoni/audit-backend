import express from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { pool } from "../config/db.js";
import { Resend } from "resend";
import crypto from "crypto";
import multer from "multer";
import {
  requireAuth,
  requireAnyAuth,
  requireAdmin,
  sendAccountDeleted,
} from "../middleware/auth.js";
import {
  loginLimits,
  signupLimits,
  forgotPasswordLimits,
} from "../middleware/rateLimit.js";
import { getClientInfo, sendMetaEvent } from "../services/metaCapi.service.js";
import {
  OTP_PURPOSE,
  OTP_RESEND_COOLDOWN_SECONDS,
  issueOtp,
  checkOtp,
  signAdminOtpToken,
  readAdminOtpToken,
} from "../services/emailOtp.service.js";
import { sendGA4Event } from "../services/ga4mp.service.js";

const resend = new Resend(process.env.RESEND_API_KEY);

const router = express.Router();

// ── Emails are not case-sensitive ────────────────────────────
// "John@x.com" at sign-up and "john@x.com" at login are the same account.
// What the user typed is trimmed and lower-cased, and the lookup compares
// LOWER(email), so accounts that were stored with capital letters before
// this rule keep working without any change to the database. New accounts
// are stored in lower case.
const normalizeEmail = (value) =>
  typeof value === "string" ? value.trim().toLowerCase() : "";

// SQL: "the account with this email" ($1 = normalized email). If old data
// holds one address twice in different case, the verified account wins,
// then the older one.
const BY_EMAIL = `LOWER(email) = $1 ORDER BY is_verified DESC, created_at ASC LIMIT 1`;

// ── Session tokens ───────────────────────────────────────────
// Session (refresh) tokens carry a random "jti". Without it, two tokens made
// for the same user in the same second are the exact same text, so "use the
// old key up and hand out a new one" would hand out the old key again.

// The same password rule the sign-up page shows: at least 8 characters with
// an upper-case letter, a lower-case letter, a number and one of @$!%*?&#.
// (app/auth/AuthClient.tsx validatePassword and app/reset-password.)
const PASSWORD_RULE =
  /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&#])[A-Za-z\d@$!%*?&#]{8,}$/;
const PASSWORD_RULE_MESSAGE =
  "Password must be at least 8 characters and include an upper-case letter, a lower-case letter, a number and a special character (@$!%*?&#).";
const isValidPassword = (value) =>
  typeof value === "string" && PASSWORD_RULE.test(value);

// ── Replies shared by the email-code routes ──────────────────
// A failed code check (see checkOtp):
//   wrong    → 400, with the tries left
//   locked   → 429, the code has used up its tries
//   expired / invalid → 400
// flow is "signup" or "admin": after a locked code a sign-up asks for a new
// one, an admin goes back to the password step.
function sendOtpFailure(res, check, flow) {
  if (check.reason === "locked") {
    return res.status(429).json({
      code: "OTP_LOCKED",
      message:
        flow === "admin"
          ? "Too many wrong codes. Please log in again."
          : "Too many wrong codes. Please request a new code.",
    });
  }

  if (check.reason === "wrong") {
    const left = check.attemptsLeft;
    return res.status(400).json({
      code: "OTP_WRONG",
      message: `Incorrect code. ${left} ${left === 1 ? "try" : "tries"} left.`,
      attemptsLeft: left,
    });
  }

  return res
    .status(400)
    .json({ code: "OTP_EXPIRED", message: "Invalid or expired OTP" });
}

// A refused resend (see issueOtp): still inside the 60-second wait, or — admin
// only — the current code is locked.
function sendResendRefusal(res, issued) {
  if (issued.reason === "locked") {
    return res.status(429).json({
      code: "OTP_LOCKED",
      message: "Too many wrong codes. Please log in again.",
    });
  }

  res.set("Retry-After", String(issued.retryAfter));
  return res.status(429).json({
    code: "OTP_RESEND_COOLDOWN",
    message: `Please wait ${issued.retryAfter} seconds before requesting a new code.`,
    retryAfter: issued.retryAfter,
  });
}

// The admin code step is only open to the browser that has just passed the
// password step (it holds the token that step returned).
function sendAdminLoginExpired(res) {
  return res.status(401).json({
    code: "ADMIN_LOGIN_EXPIRED",
    message: "Your login has expired. Please log in again.",
  });
}

const storage = multer.memoryStorage();

// Pharmacy documents (licence, DEA, insurance, ...). These are scans and
// PDFs, so PDF, images and Word files are accepted; anything else (programs,
// scripts, archives) is refused. Both the type the browser reports and the
// file ending must be on the list.
const DOCUMENT_TYPES =
  /^(application\/pdf|image\/(jpeg|jpg|png|webp|gif|heic|heif)|application\/msword|application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document)$/i;
const DOCUMENT_ENDINGS = /\.(pdf|jpe?g|png|webp|gif|heic|heif|docx?)$/i;

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    if (
      DOCUMENT_TYPES.test(file.mimetype || "") &&
      DOCUMENT_ENDINGS.test(file.originalname || "")
    )
      return cb(null, true);
    cb(
      Object.assign(
        new Error("Only PDF, image (JPG, PNG) or Word files are allowed"),
        { status: 400, expose: true },
      ),
    );
  },
});

// const requireAdmin = (req, res, next) => {
//   const authHeader = req.headers.authorization;

//   if (!authHeader) {
//     return res.status(401).json({ message: "Authorization header missing" });
//   }

//   try {
//     const token = authHeader.split(" ")[1];
//     const decoded = jwt.verify(token, process.env.ADMIN_JWT_SECRET);

//     if (decoded.role !== "admin") {
//       return res.status(403).json({ message: "Admin access only" });
//     }

//     req.user = decoded;
//     next();
//   } catch {
//     return res.status(401).json({ message: "Invalid or expired token" });
//   }
// };

// Limited to 5 sign-ups per hour from one internet address.
router.post("/register", signupLimits, async (req, res) => {
  try {
    const { name, phone, password } = req.body;
    const email = normalizeEmail(req.body.email);

    if (!email) {
      return res.status(400).json({ message: "Email is required" });
    }

    const existing = await pool.query(
      `SELECT id, is_verified, role FROM users WHERE ${BY_EMAIL}`,
      [email],
    );
    const pending = existing.rows[0];

    // A finished account (or an admin account) is never touched.
    if (pending && (pending.is_verified || pending.role === "admin")) {
      return res.status(409).json({ message: "User already exists" });
    }

    if (!isValidPassword(password)) {
      return res.status(400).json({ message: PASSWORD_RULE_MESSAGE });
    }

    const hash = await bcrypt.hash(password, 10);

    let userResult;
    if (pending) {
      // The email was signed up before but the code step was never
      // finished. That used to be a dead end: login said "not verified" and
      // sign-up said "already exists". Signing up again now REPLACES the
      // unfinished sign-up (name, phone, password) and sends a new code.
      // Only the person who knows the new password AND receives the code
      // can finish it (see /verify-otp).
      userResult = await pool.query(
        `UPDATE users
            SET name = $1, phone = $2, password = $3
          WHERE id = $4 AND is_verified = false
          RETURNING id,name,email,phone,created_at`,
        [name, phone, hash, pending.id],
      );
      // Verified by another request in the meantime.
      if (userResult.rowCount === 0) {
        return res.status(409).json({ message: "User already exists" });
      }
    } else {
      // INSERT + RETURNING (safe way)
      userResult = await pool.query(
        `INSERT INTO users (name,email,phone,password)
         VALUES ($1,$2,$3,$4)
         RETURNING id,name,email,phone,created_at`,
        [name, email, phone, hash],
      );
    }

    const user = userResult.rows[0];

    // Start of the sign-up flow: always a fresh code.
    const { otp } = await issueOtp(email, OTP_PURPOSE.SIGNUP, { force: true });

    const { error: sendErr } = await resend.emails.send({
      from: process.env.EMAIL_FROM,
      to: email,
      subject: "Verify your account",
      // html: `<p>Your OTP is <b>${otp}</b></p>`,
      html: `
<div style="font-family: Arial, sans-serif; background-color:#f4f6f8; padding:20px;">
  <div style="max-width:600px; margin:auto; background:#ffffff; border-radius:8px; overflow:hidden;">
    
    <!-- Header -->
    <div style="background:#0f172a; color:#ffffff; padding:16px; text-align:center; font-size:18px; font-weight:600;">
      Verify Your Account
    </div>

    <!-- Body -->
    <div style="padding:24px; color:#1f2937;">
      <p style="margin-bottom:16px;">Hello,</p>
      <p style="margin-bottom:16px;">
        Use the OTP below to verify your account. This code is valid for 5 minutes.
      </p>

      <div style="text-align:center; margin:24px 0;">
        <span style="font-size:28px; font-weight:bold; letter-spacing:4px; color:#0f172a;">
          ${otp}
        </span>
      </div>

      <p style="margin-top:20px;">
        If you didn’t request this, you can safely ignore this email.
      </p>
    </div>

    <!-- Footer -->
    <div style="background:#f1f5f9; padding:16px; font-size:12px; text-align:center; color:#64748b;">
      © 2026 AuditProRx. All rights reserved.<br/>

    </div>

  </div>
</div>
`,
    });

    if (sendErr) {
      console.error("Verification email failed:", sendErr);
      return res.status(502).json({ message: "Failed to send verification email. Please try again." });
    }

    res.status(200).json({
      message: "OTP sent to email",
      user: user,
      // seconds until "Resend code" is allowed (the page shows it as a timer)
      resendAfter: OTP_RESEND_COOLDOWN_SECONDS,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
});

router.post("/verify-otp", async (req, res) => {
  try {
    const { otp, password, eventId, fbp, fbc } = req.body;
    const email = normalizeEmail(req.body.email);

    if (!email || !otp) {
      return res.status(400).json({ message: "Email and OTP are required" });
    }

    // Limited to 5 wrong tries per code; a correct code is used up here.
    const check = await checkOtp(email, OTP_PURPOSE.SIGNUP, otp);
    if (!check.ok) return sendOtpFailure(res, check, "signup");

    // The sign-up this code was sent for.
    const pendingRes = await pool.query(
      `SELECT id, password, is_verified FROM users WHERE ${BY_EMAIL}`,
      [email],
    );
    const pending = pendingRes.rows[0];

    // A correct code for an email with no account verifies nothing.
    if (!pending) {
      return res.status(400).json({
        code: "ACCOUNT_NOT_FOUND",
        message: "No account found for this email. Please sign up again.",
      });
    }

    // This step only finishes a sign-up. It never signs in an account that
    // is already verified.
    if (pending.is_verified) {
      return res.status(400).json({
        code: "ALREADY_VERIFIED",
        message: "This account is already verified. Please log in.",
      });
    }

    // The page sends the sign-up password together with the code. An
    // unfinished sign-up can be started again by anyone who types the email
    // (see /register), which replaces its password. This check makes sure
    // the person entering the code is the one whose password is saved: a
    // code that arrived for somebody else's attempt cannot finish yours.
    const samePassword =
      typeof password === "string" &&
      password.length > 0 &&
      (await bcrypt.compare(password, pending.password || ""));
    if (!samePassword) {
      return res.status(400).json({
        code: "SIGNUP_MISMATCH",
        message: "This code does not match your sign-up. Please sign up again.",
      });
    }

    const verified = await pool.query(
      `UPDATE users
       SET is_verified = true
       WHERE id = $1 AND is_verified = false
       RETURNING id, name, email, phone, role, status, is_verified`,
      [pending.id],
    );

    if (verified.rowCount === 0) {
      return res.status(400).json({
        code: "ALREADY_VERIFIED",
        message: "This account is already verified. Please log in.",
      });
    }

    // Meta CAPI — pairs with the browser sign_up Pixel event via eventId.
    // Not awaited: tracking must not slow down or break verification.
    const { ip, userAgent } = getClientInfo(req);
    sendMetaEvent({
      eventName: "CompleteRegistration",
      eventId,
      email,
      externalId: verified.rows[0]?.id,
      fbp,
      fbc,
      ip,
      userAgent,
      sourceUrl: "https://www.auditprorx.com/auth",
    });

    const user = verified.rows[0];

    // GA4 Measurement Protocol — qualify_lead fires on verified account creation.
    // clientId comes from the _ga cookie value sent by the frontend.
    const { clientId: ga4ClientId } = req.body;
    sendGA4Event({
      eventName: "qualify_lead",
      clientId: ga4ClientId,
      userId: user.id,
      params: { method: "email" },
    });

    // Admin accounts sign in through the admin login (password + emailed
    // code) only, never through this step.
    if (user.role === "admin") {
      return res.status(200).json({ message: "Account verified successfully" });
    }

    // The new user is signed in from here on, with the same tokens /login
    // issues. The rest of sign-up (pharmacy details, suppliers) needs a login.
    const accessToken = jwt.sign(
      { userId: user.id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "3h" },
    );
    const refreshToken = jwt.sign(
      { userId: user.id, jti: crypto.randomUUID() },
      process.env.JWT_REFRESH_SECRET,
      { expiresIn: "1d" },
    );
    await pool.query(
      `INSERT INTO refresh_tokens (user_id, token, expires_at)
       VALUES ($1,$2,NOW() + INTERVAL '1 day')`,
      [user.id, refreshToken],
    );

    return res.status(200).json({
      message: "Account verified successfully",
      accessToken,
      refreshToken,
      user,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
});

// Limited to 10 tries in 15 minutes for one email, and 20 in 15 minutes from
// one internet address.
router.post("/login", loginLimits, async (req, res) => {
  try {
    const { password } = req.body;
    const email = normalizeEmail(req.body.email);

    const result = await pool.query(
      `SELECT id, name, email, phone, password, role, status, is_verified
       FROM users WHERE ${BY_EMAIL}`,
      [email],
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ message: "Invalid email or password" });
    }

    const user = result.rows[0];

    if (!user.is_verified) {
      return res.status(401).json({ message: "Email not verified" });
    }

    const valid = await bcrypt.compare(password, user.password);

    if (!valid) {
      return res.status(401).json({ message: "Invalid email or password" });
    }

    // The password hash is not needed past this point and must never be
    // sent to the browser (the admin reply below used to include it).
    delete user.password;

    if (user.role === "admin") {
      // Password step passed: a fresh code (replaces any earlier one).
      const { otp } = await issueOtp(user.email, OTP_PURPOSE.ADMIN_LOGIN, {
        force: true,
      });

      const { error: adminOtpErr } = await resend.emails.send({
        from: process.env.EMAIL_FROM,
        to: user.email,
        subject: "Admin Login OTP",
        html: `<p>Your admin login OTP: <b>${otp}</b>. Valid for 5 minutes.</p>`,
      });

      if (adminOtpErr) {
        console.error("Admin OTP email failed:", adminOtpErr);
        return res.status(502).json({ message: "Failed to send OTP email. Please try again." });
      }

      return res.status(200).json({
        message: "OTP sent to admin email",
        requiresOtp: true, // frontend uses this flag to show OTP screen
        email: user.email,
        user,
        // Proof that the password step was passed. The code step
        // (/admin/verify-otp, /admin/resend-otp) refuses to work without it.
        otpToken: signAdminOtpToken(user.id),
        resendAfter: OTP_RESEND_COOLDOWN_SECONDS,
      });
    }

    const accessToken = jwt.sign(
      { userId: user.id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "3h" },
    );

    const refreshToken = jwt.sign(
      { userId: user.id, jti: crypto.randomUUID() },
      process.env.JWT_REFRESH_SECRET,
      { expiresIn: "1d" },
    );

    await pool.query(
      `INSERT INTO refresh_tokens (user_id, token, expires_at)
       VALUES ($1,$2,NOW() + INTERVAL '1 day')`,
      [user.id, refreshToken],
    );

    // ❌ remove password before sending response
    delete user.password;

    res.status(200).json({
      message: "Login successful",
      accessToken,
      refreshToken,
      user, // ✅ user added here
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
});

// router.post("/google", async (req, res) => {
//   const { credential } = req.body;

//   const ticket = await googleClient.verifyIdToken({
//     idToken: credential,
//     audience: process.env.GOOGLE_CLIENT_ID,
//   });

//   const payload = ticket.getPayload();

//   const email = payload.email;
//   const name = payload.name;
//   const googleId = payload.sub;

//   let user = await pool.query("SELECT * FROM users WHERE email=$1", [email]);

//   if (user.rows.length === 0) {
//     const newUser = await pool.query(
//       `INSERT INTO users (name,email,is_verified)
//        VALUES ($1,$2,true)
//        RETURNING *`,
//       [name, email],
//     );

//     await pool.query(
//       `INSERT INTO auth_providers
//        (user_id,provider,provider_user_id)
//        VALUES ($1,'google',$2)`,
//       [newUser.rows[0].id, googleId],
//     );

//     user = newUser;
//   }

//   const token = jwt.sign(
//     { userId: user.rows[0].id, role: user.rows[0].role },
//     process.env.JWT_SECRET,
//     { expiresIn: "15m" },
//   );

//   res.status(200).json({ token });
// });

// POST /auth/google was removed. The website has no Google button any more,
// and the route skipped the "email verified" and "account active" checks and
// gave an admin a login without the emailed code.

router.post("/resend-otp", async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);

    if (!email) {
      return res.status(400).json({ message: "Email is required" });
    }

    const user = await pool.query(`SELECT * FROM users WHERE ${BY_EMAIL}`, [
      email,
    ]);

    if (user.rows.length === 0) {
      return res.status(200).json({ message: "If that email is registered, a new OTP has been sent" });
    }

    if (user.rows[0].is_verified) {
      return res.status(400).json({ message: "Account already verified" });
    }

    // New code, at most once per 60 seconds for the same email. A refused
    // request sends no email and says how many seconds are left.
    const issued = await issueOtp(email, OTP_PURPOSE.SIGNUP);
    if (!issued.ok) return sendResendRefusal(res, issued);
    const otp = issued.otp;

    // send email
    const { error: resendOtpErr } = await resend.emails.send({
      from: process.env.EMAIL_FROM,
      to: email,
      subject: "Your new OTP",
      // html: `<p>Your new OTP is <b>${otp}</b></p>`,
      html: `
<div style="font-family: Arial, sans-serif; background-color:#f4f6f8; padding:20px;">
  <div style="max-width:600px; margin:auto; background:#ffffff; border-radius:8px; overflow:hidden;">
    
    <div style="background:#0f172a; color:#ffffff; padding:16px; text-align:center; font-size:18px; font-weight:600;">
      New OTP Request
    </div>

    <div style="padding:24px; color:#1f2937;">
      <p>Your new OTP is:</p>

      <div style="text-align:center; margin:24px 0;">
        <span style="font-size:28px; font-weight:bold; letter-spacing:4px; color:#0f172a;">
          ${otp}
        </span>
      </div>

      <p>This OTP will expire in 5 minutes.</p>
    </div>

    <div style="background:#f1f5f9; padding:16px; font-size:12px; text-align:center; color:#64748b;">
      © 2026 AuditProRx<br/>

    </div>

  </div>
</div>
`,
    });

    if (resendOtpErr) {
      console.error("Resend OTP email failed:", resendOtpErr);
      return res.status(502).json({ message: "Failed to send OTP email. Please try again." });
    }

    res.status(200).json({
      message: "OTP resent successfully",
      resendAfter: OTP_RESEND_COOLDOWN_SECONDS,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
});

router.get("/user-info", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return res.status(401).json({ message: "Authorization header missing" });
    }

    const token = authHeader.split(" ")[1];

    if (!token) {
      return res.status(401).json({ message: "Token missing" });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const userId = decoded.userId;

    const result = await pool.query(
      `SELECT id, name, email, phone, role, is_verified
       FROM users
       WHERE id=$1`,
      [userId],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    res.status(200).json({
      user: result.rows[0],
    });
  } catch (error) {
    console.error(error);

    if (error.name === "JsonWebTokenError") {
      return res.status(401).json({ message: "Invalid token" });
    }

    if (error.name === "TokenExpiredError") {
      return res.status(401).json({ message: "Token expired" });
    }

    res.status(500).json({ message: "Server error" });
  }
});

// Limited to 3 reset emails per hour for one email, and 5 per hour from one
// internet address.
router.post("/forgot-password", forgotPasswordLimits, async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);

    if (!email) {
      return res.status(400).json({ message: "Email is required" });
    }

    const user = await pool.query(`SELECT * FROM users WHERE ${BY_EMAIL}`, [
      email,
    ]);

    if (user.rows.length === 0) {
      return res.status(200).json({ message: "If that email is registered, a reset link has been sent" });
    }

    const token = crypto.randomBytes(32).toString("hex");

    // A new link cancels the older ones for this address; expired rows go too.
    await pool.query(`DELETE FROM password_resets WHERE LOWER(email) = $1`, [
      email,
    ]);
    await pool.query(`DELETE FROM password_resets WHERE expires_at <= NOW()`);

    await pool.query(
      `INSERT INTO password_resets (email, token, expires_at)
       VALUES ($1,$2,NOW() + INTERVAL '15 minutes')`,
      [email, token],
    );

    const resetLink = `https://www.auditprorx.com/reset-password?token=${token}`;

    // Send email using Resend
    const { error: forgotErr } = await resend.emails.send({
      from: process.env.EMAIL_FROM,
      to: email,
      subject: "Reset your password",
      // html: `
      //   <h3>Password Reset Request</h3>
      //   <p>Click the link below to reset your password:</p>
      //   <a href="${resetLink}">${resetLink}</a>
      //   <p>This link will expire in 15 minutes.</p>
      // `,
      html: `
<div style="font-family: Arial, sans-serif; background-color:#f4f6f8; padding:20px;">
  <div style="max-width:600px; margin:auto; background:#ffffff; border-radius:8px; overflow:hidden;">
    
    <div style="background:#0f172a; color:#ffffff; padding:16px; text-align:center; font-size:18px; font-weight:600;">
      Reset Your Password
    </div>

    <div style="padding:24px; color:#1f2937;">
      <p>You requested to reset your password.</p>

      <div style="text-align:center; margin:24px 0;">
        <a href="${resetLink}" 
           style="background:#0f172a; color:#ffffff; padding:12px 20px; text-decoration:none; border-radius:6px;">
          Reset Password
        </a>
      </div>

      <p>This link will expire in 15 minutes.</p>
      <p>If you didn’t request this, please ignore this email.</p>
    </div>

    <div style="background:#f1f5f9; padding:16px; font-size:12px; text-align:center; color:#64748b;">
      © 2026 AuditProRx<br/>

    </div>

  </div>
</div>
`,
    });

    if (forgotErr) {
      console.error("Forgot-password email failed:", forgotErr);
      return res.status(502).json({ message: "Failed to send reset email. Please try again." });
    }

    res.status(200).json({ message: "Password reset link sent to email" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
});

router.post("/reset-password", async (req, res) => {
  try {
    const { token, newPassword } = req.body;

    const result = await pool.query(
      `SELECT * FROM password_resets
       WHERE token=$1 AND expires_at > NOW()`,
      [token],
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ message: "Invalid or expired token" });
    }

    const email = result.rows[0].email;

    if (!isValidPassword(newPassword)) {
      return res.status(400).json({ message: PASSWORD_RULE_MESSAGE });
    }

    const hash = await bcrypt.hash(newPassword, 10);

    // LOWER() on both sides: the reset row holds the lower-case address, the
    // account may have been stored with capital letters.
    const updated = await pool.query(
      `UPDATE users SET password=$1 WHERE LOWER(email)=LOWER($2) RETURNING id`,
      [hash, email],
    );
    if (updated.rowCount === 0) {
      return res.status(400).json({ message: "Invalid or expired token" });
    }

    await pool.query(`DELETE FROM password_resets WHERE LOWER(email)=LOWER($1)`, [
      email,
    ]);

    // End every saved session of this account. Whoever was logged in before
    // the reset (on any device) can no longer renew their login and has to
    // sign in again with the new password.
    await pool.query(
      `DELETE FROM refresh_tokens
        WHERE user_id IN (SELECT id FROM users WHERE LOWER(email) = LOWER($1))`,
      [email],
    );

    // Send confirmation email using Resend
    await resend.emails.send({
      from: process.env.EMAIL_FROM,
      to: email,
      subject: "Password Reset Successful",
      // html: `
      //   <h3>Your password has been reset</h3>
      //   <p>If you did not perform this action, please contact support immediately.</p>
      // `,
      html: `
<div style="font-family: Arial, sans-serif; background-color:#f4f6f8; padding:20px;">
  <div style="max-width:600px; margin:auto; background:#ffffff; border-radius:8px; overflow:hidden;">
    
    <div style="background:#0f172a; color:#ffffff; padding:16px; text-align:center; font-size:18px; font-weight:600;">
      Password Updated
    </div>

    <div style="padding:24px; color:#1f2937;">
      <p>Your password has been successfully reset.</p>
      <p>If you did not perform this action, please contact support immediately.</p>
    </div>

    <div style="background:#f1f5f9; padding:16px; font-size:12px; text-align:center; color:#64748b;">
      © 2026 AuditProRx<br/>

    </div>

  </div>
</div>
`,
    });

    res.status(200).json({ message: "Password reset successful" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
});

// router.post(
//   "/pharmacy",
//   upload.fields([
//     { name: "licenseFile", maxCount: 1 },
//     { name: "deaFile", maxCount: 1 },
//     { name: "cdsFile", maxCount: 1 },
//     { name: "pharmacistFile", maxCount: 1 },
//     { name: "cmeaFile", maxCount: 1 },
//   ]),
//   async (req, res) => {
//     try {
//       const {
//         userId,
//         pharmacyName,
//         address,
//         phone,
//         fax,
//         ncpdpNumber,
//         npiNumber,
//         pharmacyLicenseNumber,
//         licenseExpiryDate,
//         deaNumber,
//         deaExpiryDate,
//         cdsNumber,
//         cdsExpiry,
//         pharmacistName,
//         pharmacistLicenseNumber,
//         pharmacistExpiration,
//         cmeaExpiry,
//       } = req.body;

//       const licenseFile = req.files?.licenseFile?.[0]?.buffer || null;
//       const deaFile = req.files?.deaFile?.[0]?.buffer || null;
//       const cdsFile = req.files?.cdsFile?.[0]?.buffer || null;
//       const pharmacistFile = req.files?.pharmacistFile?.[0]?.buffer || null;
//       const cmeaFile = req.files?.cmeaFile?.[0]?.buffer || null;

//       const result = await pool.query(
//         `INSERT INTO pharmacy_details (
//           user_id,
//           pharmacy_name,
//           address,
//           phone,
//           fax,
//           ncpdp_number,
//           npi_number,
//           pharmacy_license_number,
//           license_expiry_date,
//           license_file,
//           dea_number,
//           dea_expiry_date,
//           dea_file,
//           cds_number,
//           cds_expiry,
//           cds_file,
//           pharmacist_name,
//           pharmacist_license_number,
//           pharmacist_expiration,
//           pharmacist_file,
//           cmea_expiry,
//           cmea_file
//         )
//         VALUES (
//           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
//           $11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22
//         )
//         RETURNING *`,
//         [
//           userId,
//           pharmacyName,
//           address,
//           phone,
//           fax,
//           ncpdpNumber,
//           npiNumber,
//           pharmacyLicenseNumber,
//           licenseExpiryDate,
//           licenseFile,
//           deaNumber,
//           deaExpiryDate,
//           deaFile,
//           cdsNumber,
//           cdsExpiry,
//           cdsFile,
//           pharmacistName,
//           pharmacistLicenseNumber,
//           pharmacistExpiration,
//           pharmacistFile,
//           cmeaExpiry,
//           cmeaFile,
//         ],
//       );

//       res.status(200).json({
//         message: "Pharmacy details saved successfully",
//         data: result.rows[0],
//       });
//     } catch (error) {
//       console.error(error);
//       res.status(500).json({
//         message: "Server error",
//       });
//     }
//   },
// );

// router.get("/pharmacy-details", async (req, res) => {
//   try {
//     const authHeader = req.headers.authorization;

//     if (!authHeader) {
//       return res.status(401).json({ message: "Authorization header missing" });
//     }

//     const token = authHeader.split(" ")[1];

//     if (!token) {
//       return res.status(401).json({ message: "Token missing" });
//     }

//     const decoded = jwt.verify(token, process.env.JWT_SECRET);

//     const userId = decoded.userId;

//     const result = await pool.query(
//       `SELECT
//         id,
//         user_id,
//         pharmacy_name,
//         address,
//         phone,
//         fax,
//         ncpdp_number,
//         npi_number,
//         pharmacy_license_number,
//         license_expiry_date,
//         dea_number,
//         dea_expiry_date,
//         cds_number,
//         cds_expiry,
//         pharmacist_name,
//         pharmacist_license_number,
//         pharmacist_expiration,
//         cmea_expiry
//        FROM pharmacy_details
//        WHERE user_id=$1`,
//       [userId],
//     );

//     if (result.rows.length === 0) {
//       return res.status(404).json({
//         message: "Pharmacy details not found",
//       });
//     }

//     res.status(200).json({
//       pharmacy: result.rows[0],
//     });
//   } catch (error) {
//     console.error(error);

//     if (error.name === "JsonWebTokenError") {
//       return res.status(401).json({ message: "Invalid token" });
//     }

//     if (error.name === "TokenExpiredError") {
//       return res.status(401).json({ message: "Token expired" });
//     }

//     res.status(500).json({ message: "Server error" });
//   }
// });

// Needs a user login. requireAuth runs BEFORE the upload middleware, so a
// request without a login is refused before any file is read into memory.
router.post(
  "/pharmacy",
  requireAuth,
  upload.fields([
    { name: "licenseFile", maxCount: 1 },
    { name: "deaFile", maxCount: 1 },
    { name: "cdsFile", maxCount: 1 },
    { name: "pharmacistFile", maxCount: 1 },
    { name: "cmeaFile", maxCount: 1 },

    { name: "einFile", maxCount: 5 },
    { name: "liabilityInsuranceFile", maxCount: 1 },
    { name: "workersCompFile", maxCount: 1 },
    { name: "suretyBondFile", maxCount: 1 },
    { name: "voidedChequeFile", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      // The details are saved for the logged-in user. A userId sent in the
      // form is ignored.
      const userId = req.user.userId;

      const {
        pharmacyName,
        address,
        phone,
        fax,
        ncpdpNumber,
        npiNumber,

        pharmacyLicenseNumber,
        licenseExpiryDate,

        deaNumber,
        deaExpiryDate,

        cdsNumber,
        cdsExpiry,

        pharmacistName,
        pharmacistLicenseNumber,
        pharmacistExpiration,

        cmeaExpiry,

        einNumber,
        insuranceExpiration,
        workersCompExpiration,
        suretyBondExpiration,
      } = req.body;

      const licenseFile = req.files?.licenseFile?.[0]?.buffer || null;
      const deaFile = req.files?.deaFile?.[0]?.buffer || null;
      const cdsFile = req.files?.cdsFile?.[0]?.buffer || null;
      const pharmacistFile = req.files?.pharmacistFile?.[0]?.buffer || null;
      const cmeaFile = req.files?.cmeaFile?.[0]?.buffer || null;

      const einFile = req.files?.einFile?.[0]?.buffer || null;
      const liabilityInsuranceFile =
        req.files?.liabilityInsuranceFile?.[0]?.buffer || null;
      const workersCompFile = req.files?.workersCompFile?.[0]?.buffer || null;
      const suretyBondFile = req.files?.suretyBondFile?.[0]?.buffer || null;
      const voidedChequeFile = req.files?.voidedChequeFile?.[0]?.buffer || null;

      // One value per column, in the order used by both statements below.
      const detailValues = [
        userId,
        pharmacyName,
        address,
        phone,
        fax,
        ncpdpNumber,
        npiNumber,

        pharmacyLicenseNumber,
        licenseExpiryDate,
        licenseFile,

        deaNumber,
        deaExpiryDate,
        deaFile,

        cdsNumber,
        cdsExpiry,
        cdsFile,

        pharmacistName,
        pharmacistLicenseNumber,
        pharmacistExpiration,
        pharmacistFile,

        cmeaExpiry,
        cmeaFile,

        einNumber,
        einFile,

        liabilityInsuranceFile,
        insuranceExpiration,

        workersCompFile,
        workersCompExpiration,

        suretyBondFile,
        suretyBondExpiration,

        voidedChequeFile,
      ];

      // Sending the form again updates the pharmacy's details instead of
      // adding a second row. This is done with a look-up first, not with
      // "ON CONFLICT (user_id)": that needs a unique rule on user_id, which
      // the table does not have, and the save would fail for everyone.
      // A document that is not sent again keeps the one already stored.
      const existingDetails = await pool.query(
        `SELECT id FROM pharmacy_details
          WHERE user_id = $1
          ORDER BY created_at DESC
          LIMIT 1`,
        [userId],
      );

      let result;
      if (existingDetails.rows.length > 0) {
        result = await pool.query(
          `UPDATE pharmacy_details SET
             pharmacy_name             = $2,
             address                   = $3,
             phone                     = $4,
             fax                       = $5,
             ncpdp_number              = $6,
             npi_number                = $7,
             pharmacy_license_number   = $8,
             license_expiry_date       = $9,
             license_file              = COALESCE($10, license_file),
             dea_number                = $11,
             dea_expiry_date           = $12,
             dea_file                  = COALESCE($13, dea_file),
             cds_number                = $14,
             cds_expiry                = $15,
             cds_file                  = COALESCE($16, cds_file),
             pharmacist_name           = $17,
             pharmacist_license_number = $18,
             pharmacist_expiration     = $19,
             pharmacist_file           = COALESCE($20, pharmacist_file),
             cmea_expiry               = $21,
             cmea_file                 = COALESCE($22, cmea_file),
             ein_number                = $23,
             ein_file                  = COALESCE($24, ein_file),
             liability_insurance_file  = COALESCE($25, liability_insurance_file),
             insurance_expiration      = $26,
             workers_comp_file         = COALESCE($27, workers_comp_file),
             workers_comp_expiration   = $28,
             surety_bond_file          = COALESCE($29, surety_bond_file),
             surety_bond_expiration    = $30,
             voided_cheque_file        = COALESCE($31, voided_cheque_file)
           WHERE id = $32 AND user_id = $1
           RETURNING *`,
          [...detailValues, existingDetails.rows[0].id],
        );
      } else {
        result = await pool.query(
          `INSERT INTO pharmacy_details(
            user_id,
            pharmacy_name,
            address,
            phone,
            fax,
            ncpdp_number,
            npi_number,

            pharmacy_license_number,
            license_expiry_date,
            license_file,

            dea_number,
            dea_expiry_date,
            dea_file,

            cds_number,
            cds_expiry,
            cds_file,

            pharmacist_name,
            pharmacist_license_number,
            pharmacist_expiration,
            pharmacist_file,

            cmea_expiry,
            cmea_file,

            ein_number,
            ein_file,

            liability_insurance_file,
            insurance_expiration,

            workers_comp_file,
            workers_comp_expiration,

            surety_bond_file,
            surety_bond_expiration,

            voided_cheque_file
          )
          VALUES(
            $1,$2,$3,$4,$5,$6,$7,
            $8,$9,$10,
            $11,$12,$13,
            $14,$15,$16,
            $17,$18,$19,$20,
            $21,$22,
            $23,$24,
            $25,$26,
            $27,$28,
            $29,$30,
            $31
          )
          RETURNING *`,
          detailValues,
        );
      }

      const emailResult = await pool.query(
        `SELECT email FROM users WHERE id = $1`,
        [userId],
      );

      const email = emailResult.rows[0]?.email;

      // Notify the AuditProRx inbox that a pharmacy completed registration.
      // Fire-and-forget: a failure here must never affect the user's flow.
      resend.emails
        .send({
          from: process.env.EMAIL_FROM,
          to: "auditprorx@gmail.com",
          subject: `New pharmacy registered: ${pharmacyName || email || userId}`,
          html: `
<div style="font-family: Arial, sans-serif; background-color:#f4f6f8; padding:20px;">
  <div style="max-width:600px; margin:auto; background:#ffffff; border-radius:8px; overflow:hidden;">
    <div style="background:#0f172a; color:#ffffff; padding:16px; text-align:center; font-size:18px; font-weight:600;">
      New Pharmacy Registered
    </div>
    <div style="padding:24px; color:#1f2937;">
      <p><b>Pharmacy:</b> ${pharmacyName || "-"}</p>
      <p><b>Address:</b> ${address || "-"}</p>
      <p><b>Phone:</b> ${phone || "-"}</p>
      <p><b>Fax:</b> ${fax || "-"}</p>
      <p><b>NCPDP:</b> ${ncpdpNumber || "-"}</p>
      <p><b>NPI:</b> ${npiNumber || "-"}</p>
      <p><b>User email:</b> ${email || "-"}</p>
      <p><b>User ID:</b> ${userId || "-"}</p>
      <p><b>Registered at:</b> ${new Date().toISOString()}</p>
    </div>
    <div style="background:#f1f5f9; padding:16px; font-size:12px; text-align:center; color:#64748b;">
      © 2026 AuditProRx. All rights reserved.
    </div>
  </div>
</div>
`,
        })
        .catch((err) =>
          console.error(
            "Pharmacy registration notice email failed:",
            err?.message || err,
          ),
        );

      if (email) {
        try {
          await resend.emails.send({
            from: process.env.EMAIL_FROM,
            to: email,
            subject: "Account Created Successfully",
            html: `
<div style="font-family: Arial, sans-serif; background-color:#f4f6f8; padding:20px;">
  <div style="max-width:600px; margin:auto; background:#ffffff; border-radius:8px; overflow:hidden;">
    
    <!-- Header -->
    <div style="background:#0f172a; color:#ffffff; padding:16px; text-align:center; font-size:18px; font-weight:600;">
      Account Created Successfully
    </div>

    <!-- Body -->
    <div style="padding:24px; color:#1f2937;">
      <p style="margin-bottom:16px;">Hello,</p>
      <p style="margin-bottom:16px;">
        Your account has been created successfully for the AuditProRx platform.
      </p>

      <div style="text-align:center; margin:24px 0;">
        <span style="font-size:28px; font-weight:bold; letter-spacing:4px; color:#0f172a;">
          A U D I T P R O R X
        </span>
      </div>

      <p style="margin-bottom:16px;">
       If you did not create this account, please ignore this email or contact support.
      </p>
    </div>

    <!-- Footer -->
    <div style="background:#f1f5f9; padding:16px; font-size:12px; text-align:center; color:#64748b;">
      © 2026 AuditProRx. All rights reserved.<br/>

    </div>

  </div>
</div>
`,
          });
        } catch (err) {
          console.error("Email failed:", err);
        }
      }

      res.status(200).json({
        message: "Pharmacy details saved successfully",
        data: result.rows[0],
      });
    } catch (error) {
      console.error(error);
      res.status(500).json({ message: "Server error" });
    }
  },
);

const FILE_COLUMN_MAP = {
  licenseFile:          "license_file",
  deaFile:              "dea_file",
  cdsFile:              "cds_file",
  pharmacistFile:       "pharmacist_file",
  cmeaFile:             "cmea_file",
  einFile:              "ein_file",
  liabilityInsuranceFile: "liability_insurance_file",
  workersCompFile:      "workers_comp_file",
  suretyBondFile:       "surety_bond_file",
  voidedChequeFile:     "voided_cheque_file",
};

// Replace one or more stored documents. The login is checked BEFORE the
// upload, so a request without a login is refused before any file is read
// into memory. The documents belong to the logged-in user.
router.put(
  "/pharmacy",
  requireAuth,
  upload.fields(Object.keys(FILE_COLUMN_MAP).map((name) => ({ name, maxCount: 1 }))),
  async (req, res) => {
    try {
      const userId = req.user.userId;

      const setClauses = [];
      const values = [];

      for (const [fieldName, column] of Object.entries(FILE_COLUMN_MAP)) {
        const buf = req.files?.[fieldName]?.[0]?.buffer;
        if (buf) {
          values.push(buf);
          setClauses.push(`"${column}" = $${values.length}`);
        }
      }

      if (setClauses.length === 0) {
        return res.status(400).json({ message: "No files provided" });
      }

      values.push(userId);
      const result = await pool.query(
        `UPDATE pharmacy_details SET ${setClauses.join(", ")} WHERE user_id = $${values.length} RETURNING *`,
        values,
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ message: "Pharmacy details not found" });
      }

      res.status(200).json({ message: "Files updated successfully", data: result.rows[0] });
    } catch (error) {
      console.error(error);
      res.status(500).json({ message: "Server error" });
    }
  },
);

router.get("/pharmacy-details", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return res.status(401).json({ message: "Authorization header missing" });
    }

    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const userId = decoded.userId;

    const result = await pool.query(
      `SELECT
        id,
        user_id,
        pharmacy_name,
        address,
        phone,
        fax,
        ncpdp_number,
        npi_number,

        pharmacy_license_number,
        license_expiry_date,

        dea_number,
        dea_expiry_date,

        cds_number,
        cds_expiry,

        pharmacist_name,
        pharmacist_license_number,
        pharmacist_expiration,

        cmea_expiry,

        ein_number,

        insurance_expiration,
        workers_comp_expiration,
        surety_bond_expiration

      FROM pharmacy_details
      WHERE user_id=$1`,
      [userId],
    );

    res.status(200).json({
      pharmacy: result.rows[0],
    });
  } catch (error) {
    console.error(error);
    if (error.name === "TokenExpiredError" || error.name === "JsonWebTokenError")
      return res.status(401).json({ message: "Not logged in" });
    res.status(500).json({ message: "Server error" });
  }
});

// All valid file columns from your schema
const ALLOWED_FILE_COLUMNS = new Set([
  "license_file",
  "dea_file",
  "cds_file",
  "pharmacist_file",
  "cmea_file",
  "ein_file",
  "liability_insurance_file",
  "workers_comp_file",
  "surety_bond_file",
  "voided_cheque_file",
]);

function detectMimeType(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    buffer = Buffer.from(buffer.replace(/^\\x/, ""), "hex");
  }

  const b = buffer;

  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46)
    return { mime: "application/pdf", ext: "pdf" };

  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)
    return { mime: "image/jpeg", ext: "jpg" };

  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47)
    return { mime: "image/png", ext: "png" };

  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46)
    return { mime: "image/gif", ext: "gif" };

  if (b[0] === 0x42 && b[1] === 0x4d) return { mime: "image/bmp", ext: "bmp" };

  if (b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04)
    return {
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ext: "docx",
    };

  return { mime: "application/octet-stream", ext: "bin" };
}

router.get("/pharmacy-file/:type", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ message: "Authorization header missing" });
    }

    let decoded;
    try {
      decoded = jwt.verify(authHeader.split(" ")[1], process.env.JWT_SECRET);
    } catch (jwtErr) {
      return res.status(401).json({ message: "Not logged in" });
    }
    const userId = decoded.userId;
    const { type } = req.params;

    // Whitelist check — only allow actual file columns
    if (!ALLOWED_FILE_COLUMNS.has(type)) {
      return res.status(400).json({ message: "Invalid file type requested" });
    }

    const result = await pool.query(
      `SELECT "${type}" FROM pharmacy_details WHERE user_id = $1`,
      [userId],
    );

    if (!result.rows.length || !result.rows[0][type]) {
      return res.status(404).json({ message: "File not found" });
    }

    let file = result.rows[0][type];

    // Convert Postgres BYTEA hex string → Buffer
    if (typeof file === "string") {
      file = Buffer.from(file.replace(/^\\x/, ""), "hex");
    }

    const { mime, ext } = detectMimeType(file);
    const filename = `${type}.${ext}`;

    res.setHeader("Content-Type", mime);
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Length", file.length);

    res.send(file);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
});

// POST /auth/refresh-token
router.post("/refresh-token", async (req, res) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(401).json({ message: "Refresh token missing" });
    }

    // Verify the refresh token signature
    let decoded;
    try {
      decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
    } catch {
      return res
        .status(401)
        .json({ message: "Invalid or expired refresh token" });
    }

    // The account behind this session was deleted: there is nothing to
    // renew. The reply carries the "account deleted" code so the website
    // can explain it instead of just returning to the sign-in page.
    const owner = await pool.query(`SELECT 1 FROM users WHERE id = $1`, [
      decoded.userId,
    ]);
    if (owner.rows.length === 0) return sendAccountDeleted(res, 401);

    // Check it exists in DB and hasn't expired
    const result = await pool.query(
      `SELECT * FROM refresh_tokens
       WHERE token = $1 AND user_id = $2 AND expires_at > NOW()`,
      [refreshToken, decoded.userId],
    );

    if (!result.rows.length) {
      return res
        .status(401)
        .json({ message: "Refresh token revoked or expired" });
    }

    // Issue new access token
    const newAccessToken = jwt.sign(
      { userId: decoded.userId, role: decoded.role },
      process.env.JWT_SECRET,
      { expiresIn: "3h" },
    );

    // Rotate refresh token atomically — delete old and insert new in one transaction
    const newRefreshToken = jwt.sign(
      { userId: decoded.userId, jti: crypto.randomUUID() },
      process.env.JWT_REFRESH_SECRET,
      { expiresIn: "1d" },
    );

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const deleted = await client.query(
        `DELETE FROM refresh_tokens WHERE token = $1 AND expires_at > NOW() RETURNING id`,
        [refreshToken],
      );
      if (deleted.rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(401).json({ message: "Refresh token already used or expired" });
      }
      await client.query(
        `INSERT INTO refresh_tokens (user_id, token, expires_at)
         VALUES ($1, $2, NOW() + INTERVAL '1 day')`,
        [decoded.userId, newRefreshToken],
      );
      await client.query("COMMIT");
    } catch (txErr) {
      await client.query("ROLLBACK");
      throw txErr;
    } finally {
      client.release();
    }

    res.status(200).json({
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
});

// POST /auth/admin/refresh-token
router.post("/admin/refresh-token", async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      return res.status(401).json({ message: "Refresh token missing" });
    }

    let decoded;
    try {
      decoded = jwt.verify(refreshToken, process.env.ADMIN_JWT_REFRESH_SECRET);
    } catch {
      return res
        .status(401)
        .json({ message: "Invalid or expired refresh token" });
    }

    const result = await pool.query(
      `SELECT * FROM refresh_tokens
       WHERE token = $1 AND user_id = $2 AND expires_at > NOW()`,
      [refreshToken, decoded.userId],
    );
    if (!result.rows.length) {
      return res
        .status(401)
        .json({ message: "Refresh token revoked or expired" });
    }

    // Re-check DB: refuse if admin was removed or deactivated since login
    const adminCheck = await pool.query(
      `SELECT role FROM users WHERE id = $1`,
      [decoded.userId],
    );
    if (!adminCheck.rows.length || adminCheck.rows[0].role !== "admin") {
      return res.status(403).json({ message: "Admin access revoked" });
    }

    const newAccessToken = jwt.sign(
      { userId: decoded.userId, role: "admin" },
      process.env.ADMIN_JWT_SECRET,
      { expiresIn: "3h" },
    );
    const newRefreshToken = jwt.sign(
      { userId: decoded.userId, role: "admin", jti: crypto.randomUUID() },
      process.env.ADMIN_JWT_REFRESH_SECRET,
      { expiresIn: "12h" },
    );

    const adminClient = await pool.connect();
    try {
      await adminClient.query("BEGIN");
      const adminDeleted = await adminClient.query(
        `DELETE FROM refresh_tokens WHERE token = $1 AND expires_at > NOW() RETURNING id`,
        [refreshToken],
      );
      if (adminDeleted.rowCount === 0) {
        await adminClient.query("ROLLBACK");
        return res.status(401).json({ message: "Refresh token already used or expired" });
      }
      await adminClient.query(
        `INSERT INTO refresh_tokens (user_id, token, expires_at)
         VALUES ($1, $2, NOW() + INTERVAL '12 hours')`,
        [decoded.userId, newRefreshToken],
      );
      await adminClient.query("COMMIT");
    } catch (txErr) {
      await adminClient.query("ROLLBACK");
      throw txErr;
    } finally {
      adminClient.release();
    }

    res
      .status(200)
      .json({ accessToken: newAccessToken, refreshToken: newRefreshToken });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
});

// POST /auth/logout — revoke refresh token
router.post("/logout", async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (refreshToken) {
      await pool.query(`DELETE FROM refresh_tokens WHERE token = $1`, [
        refreshToken,
      ]);
    }
    res.status(200).json({ message: "Logged out successfully" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
});

router.post("/admin/verify-otp", async (req, res) => {
  try {
    const { otp, otpToken } = req.body ?? {};

    // 1. Only the browser that has just passed the password step may check a
    //    code: it must present the token that step returned. The admin is
    //    taken from that token, not from the request.
    const passwordStep = readAdminOtpToken(otpToken);
    if (!passwordStep) return sendAdminLoginExpired(res);

    // 2. Verify the user is actually an admin
    const userResult = await pool.query(
      `SELECT id, name, email, role FROM users WHERE id = $1 AND role = 'admin'`,
      [passwordStep.userId],
    );

    if (!userResult.rows.length) {
      return res.status(403).json({ message: "Not authorized" });
    }

    const user = userResult.rows[0];

    // 3. Validate OTP: 5 wrong tries cancel the code, and a correct code is
    //    used up by the check.
    const check = await checkOtp(user.email, OTP_PURPOSE.ADMIN_LOGIN, otp);
    if (!check.ok) return sendOtpFailure(res, check, "admin");

    // 4. Issue tokens (same pattern as your existing login)
    const accessToken = jwt.sign(
      { userId: user.id, role: "admin" },
      process.env.ADMIN_JWT_SECRET,
      { expiresIn: "3h" },
    );

    const refreshToken = jwt.sign(
      { userId: user.id, role: "admin", jti: crypto.randomUUID() },
      process.env.ADMIN_JWT_REFRESH_SECRET,
      { expiresIn: "12h" },
    );

    await pool.query(
      `INSERT INTO refresh_tokens (user_id, token, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '12 hours')`,
      [user.id, refreshToken],
    );

    res.status(200).json({
      message: "Admin login successful",
      accessToken,
      refreshToken,
      user,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
});

router.get("/admin/dashboard", requireAdmin, (req, res) => {
  res.json({ message: "Welcome, Admin" });
});

// ── ROUTE 1: GET /auth/users
// Fetches all registered users for the admin dashboard list
// ─────────────────────────────────────────────────────────────
// router.get("/users", requireAnyAuth, async (req, res) => {
//   try {
//     const result = await pool.query(
//       `SELECT id, name, email, phone, created_at AS "createdAt",status
//        FROM users
//        ORDER BY created_at DESC`,
//     );
//     res.status(200).json(result.rows);
//   } catch (error) {
//     console.error("Error fetching users:", error);
//     res.status(500).json({ message: "Server error" });
//   }
// });
router.get("/users", requireAnyAuth, async (req, res) => {
  try {
    // Admins (admin token) get every user. Anyone else gets only their own
    // row: this route used to return all users' contact, license and DEA
    // details to any logged-in pharmacy. inactiveAccount.tsx calls it to
    // find the current user's status, which still works with one row.
    const isAdmin = Boolean(req.admin);
    const ownId = req.user?.userId;

    if (!isAdmin && !ownId) {
      return res.status(401).json({ message: "Not authenticated" });
    }

    // Paging is used only when the request asks for it (?page= or ?limit=).
    // With neither, every user is returned as a plain list, as before: the
    // admin dashboard shows all pharmacies on one screen and does not page
    // yet, so a silent default limit would hide everyone after the first 50.
    const wantsPaging =
      req.query.page !== undefined || req.query.limit !== undefined;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const offset = (page - 1) * limit;

    const whereClause = isAdmin ? "" : "WHERE u.id = $1";
    const params = isAdmin ? [] : [ownId];
    const pagingClause = wantsPaging
      ? `LIMIT $${params.length + 1} OFFSET $${params.length + 2}`
      : "";
    const queryParams = wantsPaging ? [...params, limit, offset] : params;

    const result = await pool.query(
      `SELECT
         u.id,
         u.name,
         u.email,
         u.phone,
         u.status,
         u.created_at     AS "createdAt",
         pd.pharmacy_name           AS "pharmacyName",
         pd.pharmacy_license_number AS "pharmacyLicenseNumber",
         pd.license_expiry_date     AS "licenseExpiryDate",
         pd.dea_number              AS "deaNumber",
         pd.dea_expiry_date         AS "deaExpiryDate"
       FROM users u
       LEFT JOIN LATERAL (
         SELECT
           pharmacy_name,
           pharmacy_license_number,
           license_expiry_date,
           dea_number,
           dea_expiry_date
         FROM pharmacy_details
         WHERE user_id = u.id
         ORDER BY created_at DESC
         LIMIT 1
       ) pd ON true
       ${whereClause}
       ORDER BY u.created_at DESC
       ${pagingClause}`,
      queryParams,
    );

    // A pharmacy asks for its own row (this is what the paywall popup polls).
    // No row means the account was deleted while this login was still open:
    // say so, instead of an empty list the page cannot explain.
    if (!isAdmin && result.rows.length === 0 && (!wantsPaging || offset === 0)) {
      return sendAccountDeleted(res);
    }

    if (!wantsPaging) return res.status(200).json(result.rows);

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM users u ${whereClause}`,
      params,
    );
    const total = parseInt(countResult.rows[0].count, 10);
    res.status(200).json({ users: result.rows, total, page, limit });
  } catch (error) {
    console.error("Error fetching users:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// ── ROUTE 2: POST /auth/impersonate
// Admin clicks "View as Pharmacy" → this generates a real
// accessToken + refreshToken for that user → frontend stores
// them and redirects directly to /Mainpage. No login needed.
// ─────────────────────────────────────────────────────────────
router.post("/impersonate", requireAdmin, async (req, res) => {
  try {
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ message: "userId is required" });
    }

    // Fetch the user
    const result = await pool.query(
      `SELECT id, name, email, phone, role, status
       FROM users
       WHERE id = $1`,
      [userId],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    const user = result.rows[0];

    // Generate tokens exactly like normal login
    const accessToken = jwt.sign(
      { userId: user.id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "3h" },
    );

    const refreshToken = jwt.sign(
      { userId: user.id, jti: crypto.randomUUID() },
      process.env.JWT_REFRESH_SECRET,
      { expiresIn: "1d" },
    );

    // Store refresh token in DB
    await pool.query(
      `INSERT INTO refresh_tokens (user_id, token, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '1 day')`,
      [user.id, refreshToken],
    );

    pool.query(
      `INSERT INTO admin_impersonation_log (admin_id, pharmacy_user_id, created_at)
       VALUES ($1, $2, NOW())`,
      [req.admin.userId, user.id],
    ).catch((err) => console.error("Impersonation log failed:", err?.message));

    res.status(200).json({
      accessToken,
      refreshToken,
      user,
    });
  } catch (error) {
    console.error("Impersonation error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

router.put("/user-status/:id", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    // Validate input
    if (!["active", "inactive"].includes(status)) {
      return res.status(400).json({
        message: "Invalid status value",
      });
    }

    const result = await pool.query(
      `UPDATE users
       SET status = $1
       WHERE id = $2
       RETURNING id, name, email, status`,
      [status, id],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        message: "User not found",
      });
    }

    const user = result.rows[0];

    // Email content based on status
    const isActive = status === "active";

    await resend.emails.send({
      from: process.env.EMAIL_FROM,
      to: user.email,
      subject: isActive
        ? "Your AuditProRx Profile Has Been Verified"
        : "Your AuditProRx Profile Has Been Unverified",

      html: `
<div style="font-family: Arial, sans-serif; background-color:#f4f6f8; padding:20px;">
  <div style="max-width:600px; margin:auto; background:#ffffff; border-radius:8px; overflow:hidden;">

    <div style="background:#0f172a; color:#ffffff; padding:16px; text-align:center; font-size:18px; font-weight:600;">
      ${isActive ? "Profile Verified" : "Profile Unverified"}
    </div>

    <div style="padding:24px; color:#1f2937; line-height:1.6;">
      <p>Hi ${user.name || "User"},</p>

      ${
        isActive
          ? `
            <p>Your AuditProRx profile has now been successfully <strong>verified</strong>.</p>

            <p>You can now access and use all the available features and services on the AuditProRx platform.</p>

            <p>We’re glad to have you onboard.</p>
          `
          : `
            <p>Your AuditProRx profile has currently been marked as <strong>inactive</strong>.</p>

            <p>You will temporarily not be able to access platform features and services.</p>

            <p>Please reach out to our support team for assistance. Reactivation may take approximately <strong>24 to 48 hours</strong> after review.</p>
          `
      }

      <p style="margin-top:24px;">
        Regards,<br/>
        AuditProRx Team
      </p>
    </div>

    <div style="background:#f1f5f9; padding:16px; font-size:12px; text-align:center; color:#64748b;">
      © 2026 AuditProRx. All rights reserved.
    </div>

  </div>
</div>`,
    });

    res.status(200).json({
      message: `User ${status} successfully`,
      user,
    });
  } catch (error) {
    console.error("Status update error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// POST /auth/admin/resend-otp
router.post("/admin/resend-otp", async (req, res) => {
  try {
    const { otpToken } = req.body ?? {};

    // Same rule as /admin/verify-otp: a code is only re-sent to an admin who
    // has just passed the password step. The address comes from that admin's
    // account, never from the request.
    const passwordStep = readAdminOtpToken(otpToken);
    if (!passwordStep) return sendAdminLoginExpired(res);

    const userResult = await pool.query(
      `SELECT email FROM users WHERE id = $1 AND role = 'admin'`,
      [passwordStep.userId],
    );

    if (!userResult.rows.length) {
      return res.status(403).json({ message: "Not authorized" });
    }

    const email = userResult.rows[0].email;

    // At most once per 60 seconds, and never to replace a code that was
    // cancelled for too many wrong tries (that needs the password again).
    const issued = await issueOtp(email, OTP_PURPOSE.ADMIN_LOGIN, {
      allowWhenLocked: false,
    });
    if (!issued.ok) return sendResendRefusal(res, issued);
    const otp = issued.otp;

    const { error: adminResendErr } = await resend.emails.send({
      from: process.env.EMAIL_FROM,
      to: email,
      subject: "Admin Login OTP (Resent)",
      html: `
<div style="font-family: Arial, sans-serif; background-color:#f4f6f8; padding:20px;">
  <div style="max-width:600px; margin:auto; background:#ffffff; border-radius:8px; overflow:hidden;">

    <div style="background:#0f172a; color:#ffffff; padding:16px; text-align:center; font-size:18px; font-weight:600;">
      Admin Login OTP
    </div>

    <div style="padding:24px; color:#1f2937;">
      <p>Your new admin login OTP is:</p>

      <div style="text-align:center; margin:24px 0;">
        <span style="font-size:28px; font-weight:bold; letter-spacing:4px; color:#0f172a;">
          ${otp}
        </span>
      </div>

      <p>This OTP will expire in 5 minutes.</p>
      <p>If you did not request this, please ignore this email.</p>
    </div>

    <div style="background:#f1f5f9; padding:16px; font-size:12px; text-align:center; color:#64748b;">
      © 2026 AuditProRx. All rights reserved.<br/>

    </div>

  </div>
</div>`,
    });

    if (adminResendErr) {
      console.error("Admin resend OTP email failed:", adminResendErr);
      return res.status(502).json({ message: "Failed to send OTP email. Please try again." });
    }

    res.status(200).json({
      message: "Admin OTP resent successfully",
      resendAfter: OTP_RESEND_COOLDOWN_SECONDS,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
});

export default router;

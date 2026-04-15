import express from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { pool } from "../config/db.js";
import generateOTP from "../utils/otp.js";
import { Resend } from "resend";
import { OAuth2Client } from "google-auth-library";
import crypto from "crypto";
import multer from "multer";

const resend = new Resend(process.env.RESEND_API_KEY);

const router = express.Router();
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const storage = multer.memoryStorage();

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

const requireAdmin = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({ message: "Authorization header missing" });
  }

  try {
    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (decoded.role !== "admin") {
      return res.status(403).json({ message: "Admin access only" });
    }

    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ message: "Invalid or expired token" });
  }
};

router.post("/register", async (req, res) => {
  try {
    const { name, email, phone, password } = req.body;

    const existing = await pool.query("SELECT 1 FROM users WHERE email=$1", [
      email,
    ]);

    if (existing.rowCount > 0) {
      return res.status(409).json({ message: "User already exists" });
    }

    const hash = await bcrypt.hash(password, 10);

    // INSERT + RETURNING (safe way)
    const userResult = await pool.query(
      `INSERT INTO users (name,email,phone,password)
       VALUES ($1,$2,$3,$4)
       RETURNING id,name,email,phone,created_at`,
      [name, email, phone, hash],
    );

    const user = userResult.rows[0];

    const otp = generateOTP();

    await pool.query(
      `INSERT INTO email_otps (email,otp,expires_at)
       VALUES ($1,$2,NOW() + INTERVAL '5 minutes')`,
      [email, otp],
    );

    await resend.emails.send({
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
      <a href="#" style="color:#64748b; text-decoration:underline;">Unsubscribe</a>
    </div>

  </div>
</div>
`,
    });

    res.status(200).json({
      message: "OTP sent to email",
      user: user,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
});

router.post("/verify-otp", async (req, res) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return res.status(400).json({ message: "Email and OTP are required" });
    }

    const result = await pool.query(
      `SELECT * FROM email_otps
       WHERE email = $1
       AND otp = $2
       AND expires_at > NOW()`,
      [email, otp.toString()],
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ message: "Invalid or Expired OTP" });
    }

    await pool.query(
      `UPDATE users
       SET is_verified = true
       WHERE email = $1`,
      [email],
    );

    await pool.query(
      `DELETE FROM email_otps
       WHERE email = $1`,
      [email],
    );

    return res.status(200).json({ message: "Account verified successfully" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
});

// router.post("/login", async (req, res) => {
//   const { email, password } = req.body;

//   const result = await pool.query("SELECT * FROM users WHERE email=$1", [
//     email,
//   ]);

//   if (result.rows.length === 0) {
//     return res.status(401).json({ message: "Invalid email" });
//   }

//   const user = result.rows[0];

//   if (!user.is_verified) {
//     return res.status(401).json({ message: "Email not verified" });
//   }

//   const valid = await bcrypt.compare(password, user.password);

//   if (!valid) {
//     return res.status(401).json({ message: "Invalid password" });
//   }

//   const accessToken = jwt.sign(
//     { userId: user.id, role: user.role },
//     process.env.JWT_SECRET,
//     { expiresIn: "15m" },
//   );

//   const refreshToken = jwt.sign(
//     { userId: user.id },
//     process.env.JWT_REFRESH_SECRET,
//     { expiresIn: "7d" },
//   );

//   await pool.query(
//     `INSERT INTO refresh_tokens
//      (user_id,token,expires_at)
//      VALUES ($1,$2,NOW() + INTERVAL '7 days')`,
//     [user.id, refreshToken],
//   );

//   res.status(200).json({
//     accessToken,
//     refreshToken,
//   });
// });

router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const result = await pool.query(
      `SELECT id, name, email, phone, password, role, status, is_verified
       FROM users WHERE email=$1`,
      [email],
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ message: "Invalid email" });
    }

    const user = result.rows[0];

    if (!user.is_verified) {
      return res.status(401).json({ message: "Email not verified" });
    }

    const valid = await bcrypt.compare(password, user.password);

    if (!valid) {
      return res.status(401).json({ message: "Invalid password" });
    }

    if (user.role === "admin") {
      const otp = generateOTP();

      await pool.query(
        `DELETE FROM email_otps WHERE email = $1`,
        [user.email], // clear old
      );

      await pool.query(
        `INSERT INTO email_otps (email, otp, expires_at)
     VALUES ($1, $2, NOW() + INTERVAL '5 minutes')`,
        [user.email, otp],
      );

      await resend.emails.send({
        from: process.env.EMAIL_FROM,
        to: user.email,
        subject: "Admin Login OTP",
        html: `<p>Your admin login OTP: <b>${otp}</b>. Valid for 5 minutes.</p>`,
      });

      return res.status(200).json({
        message: "OTP sent to admin email",
        requiresOtp: true, // frontend uses this flag to show OTP screen
        email: user.email,
        user,
      });
    }

    const accessToken = jwt.sign(
      { userId: user.id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "15m" },
    );

    const refreshToken = jwt.sign(
      { userId: user.id },
      process.env.JWT_REFRESH_SECRET,
      { expiresIn: "7d" },
    );

    await pool.query(
      `INSERT INTO refresh_tokens (user_id, token, expires_at)
       VALUES ($1,$2,NOW() + INTERVAL '7 days')`,
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

router.post("/google", async (req, res) => {
  const { credential } = req.body;

  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();

    const email = payload.email;
    const name = payload.name;
    const googleId = payload.sub;

    // Check if user already exists
    let user = await pool.query("SELECT * FROM users WHERE email=$1", [email]);

    // ❌ If user does NOT exist -> block login
    if (user.rows.length === 0) {
      return res.status(400).json({
        message:
          "Account does not exist. Please register first before using Google Sign In.",
      });
    }

    // Optional: ensure google provider record exists
    const provider = await pool.query(
      `SELECT * FROM auth_providers 
       WHERE user_id=$1 AND provider='google'`,
      [user.rows[0].id],
    );

    if (provider.rows.length === 0) {
      await pool.query(
        `INSERT INTO auth_providers
         (user_id,provider,provider_user_id)
         VALUES ($1,'google',$2)`,
        [user.rows[0].id, googleId],
      );
    }

    const token = jwt.sign(
      { userId: user.rows[0].id, role: user.rows[0].role },
      process.env.JWT_SECRET,
      { expiresIn: "15m" },
    );

    res.status(200).json({ token });
  } catch (error) {
    console.error("Google auth error:", error);
    res.status(500).json({ message: "Google authentication failed" });
  }
});

router.post("/resend-otp", async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ message: "Email is required" });
    }

    const user = await pool.query("SELECT * FROM users WHERE email=$1", [
      email,
    ]);

    if (user.rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    if (user.rows[0].is_verified) {
      return res.status(400).json({ message: "Account already verified" });
    }

    // generate new OTP
    const otp = generateOTP();

    // delete old OTP
    await pool.query("DELETE FROM email_otps WHERE email=$1", [email]);

    // insert new OTP
    await pool.query(
      `INSERT INTO email_otps (email, otp, expires_at)
       VALUES ($1,$2,NOW() + INTERVAL '5 minutes')`,
      [email, otp],
    );

    // send email
    await resend.emails.send({
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
      <a href="#" style="color:#64748b;">Unsubscribe</a>
    </div>

  </div>
</div>
`,
    });

    res.status(200).json({ message: "OTP resent successfully" });
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

router.post("/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ message: "Email is required" });
    }

    const user = await pool.query("SELECT * FROM users WHERE email=$1", [
      email,
    ]);

    if (user.rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    const token = crypto.randomBytes(32).toString("hex");

    await pool.query(
      `INSERT INTO password_resets (email, token, expires_at)
       VALUES ($1,$2,NOW() + INTERVAL '15 minutes')`,
      [email, token],
    );

    const resetLink = `https://www.auditprorx.com/reset-password?token=${token}`;

    // Send email using Resend
    await resend.emails.send({
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
      <a href="#" style="color:#64748b;">Unsubscribe</a>
    </div>

  </div>
</div>
`,
    });

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

    const hash = await bcrypt.hash(newPassword, 10);

    await pool.query(`UPDATE users SET password=$1 WHERE email=$2`, [
      hash,
      email,
    ]);

    await pool.query(`DELETE FROM password_resets WHERE email=$1`, [email]);

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
      <a href="#" style="color:#64748b;">Unsubscribe</a>
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

router.post(
  "/pharmacy",
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
      const {
        userId,
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

      const result = await pool.query(
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
        [
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
        ],
      );

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

    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
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
      { expiresIn: "15m" },
    );

    // Rotate refresh token — delete old, insert new
    const newRefreshToken = jwt.sign(
      { userId: decoded.userId },
      process.env.JWT_REFRESH_SECRET,
      { expiresIn: "7d" },
    );

    await pool.query(`DELETE FROM refresh_tokens WHERE token = $1`, [
      refreshToken,
    ]);

    await pool.query(
      `INSERT INTO refresh_tokens (user_id, token, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '7 days')`,
      [decoded.userId, newRefreshToken],
    );

    res.status(200).json({
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
    });
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
    const { email, otp } = req.body;

    // 1. Verify the user is actually an admin
    const userResult = await pool.query(
      `SELECT id, name, email, role FROM users WHERE email = $1 AND role = 'admin'`,
      [email],
    );

    if (!userResult.rows.length) {
      return res.status(403).json({ message: "Not authorized" });
    }

    // 2. Validate OTP
    const otpResult = await pool.query(
      `SELECT * FROM email_otps
       WHERE email = $1 AND otp = $2 AND expires_at > NOW()`,
      [email, otp.toString()],
    );

    if (!otpResult.rows.length) {
      return res.status(400).json({ message: "Invalid or expired OTP" });
    }

    // 3. Clear OTP
    await pool.query(`DELETE FROM email_otps WHERE email = $1`, [email]);

    const user = userResult.rows[0];

    // 4. Issue tokens (same pattern as your existing login)
    const accessToken = jwt.sign(
      { userId: user.id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "15m" },
    );

    const refreshToken = jwt.sign(
      { userId: user.id },
      process.env.JWT_REFRESH_SECRET,
      { expiresIn: "7d" },
    );

    await pool.query(
      `INSERT INTO refresh_tokens (user_id, token, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '7 days')`,
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
router.get("/users", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, email, phone, created_at AS "createdAt",status
       FROM users
       ORDER BY created_at DESC`,
    );
    res.status(200).json(result.rows);
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
router.post("/impersonate", async (req, res) => {
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
      { expiresIn: "15m" },
    );

    const refreshToken = jwt.sign(
      { userId: user.id },
      process.env.JWT_REFRESH_SECRET,
      { expiresIn: "7d" },
    );

    // Store refresh token in DB
    await pool.query(
      `INSERT INTO refresh_tokens (user_id, token, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '7 days')`,
      [user.id, refreshToken],
    );

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

// PUT /auth/user-status/:id
router.put("/user-status/:id", async (req, res) => {
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

    res.status(200).json({
      message: `User ${status} successfully`,
      user: result.rows[0],
    });
  } catch (error) {
    console.error("Status update error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// POST /auth/admin/resend-otp
router.post("/admin/resend-otp", async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ message: "Email is required" });
    }

    const otp = generateOTP();

    await pool.query(`DELETE FROM email_otps WHERE email = $1`, [email]);

    await pool.query(
      `INSERT INTO email_otps (email, otp, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '5 minutes')`,
      [email, otp],
    );

    await resend.emails.send({
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
      <a href="#" style="color:#64748b; text-decoration:underline;">Unsubscribe</a>
    </div>

  </div>
</div>`,
    });

    res.status(200).json({ message: "Admin OTP resent successfully" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
});

export default router;

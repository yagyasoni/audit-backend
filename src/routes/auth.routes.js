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
      html: `<p>Your OTP is <b>${otp}</b></p>`,
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

router.post("/login", async (req, res) => {
  const { email, password } = req.body;

  const result = await pool.query("SELECT * FROM users WHERE email=$1", [
    email,
  ]);

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
    `INSERT INTO refresh_tokens
     (user_id,token,expires_at)
     VALUES ($1,$2,NOW() + INTERVAL '7 days')`,
    [user.id, refreshToken],
  );

  res.status(200).json({
    accessToken,
    refreshToken,
  });
});

router.post("/google", async (req, res) => {
  const { credential } = req.body;

  const ticket = await googleClient.verifyIdToken({
    idToken: credential,
    audience: process.env.GOOGLE_CLIENT_ID,
  });

  const payload = ticket.getPayload();

  const email = payload.email;
  const name = payload.name;
  const googleId = payload.sub;

  let user = await pool.query("SELECT * FROM users WHERE email=$1", [email]);

  if (user.rows.length === 0) {
    const newUser = await pool.query(
      `INSERT INTO users (name,email,is_verified)
       VALUES ($1,$2,true)
       RETURNING *`,
      [name, email],
    );

    await pool.query(
      `INSERT INTO auth_providers
       (user_id,provider,provider_user_id)
       VALUES ($1,'google',$2)`,
      [newUser.rows[0].id, googleId],
    );

    user = newUser;
  }

  const token = jwt.sign(
    { userId: user.rows[0].id, role: user.rows[0].role },
    process.env.JWT_SECRET,
    { expiresIn: "15m" },
  );

  res.status(200).json({ token });
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
      html: `<p>Your new OTP is <b>${otp}</b></p>`,
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

    const resetLink = `http://localhost:3000/reset-password?token=${token}`;

    // Send email using Resend
    await resend.emails.send({
      from: process.env.EMAIL_FROM,
      to: email,
      subject: "Reset your password",
      html: `
        <h3>Password Reset Request</h3>
        <p>Click the link below to reset your password:</p>
        <a href="${resetLink}">${resetLink}</a>
        <p>This link will expire in 15 minutes.</p>
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
      html: `
        <h3>Your password has been reset</h3>
        <p>If you did not perform this action, please contact support immediately.</p>
      `,
    });

    res.status(200).json({ message: "Password reset successful" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
});

router.post(
  "/pharmacy",
  upload.fields([
    { name: "licenseFile", maxCount: 1 },
    { name: "deaFile", maxCount: 1 },
    { name: "cdsFile", maxCount: 1 },
    { name: "pharmacistFile", maxCount: 1 },
    { name: "cmeaFile", maxCount: 1 },
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
      } = req.body;

      const licenseFile = req.files?.licenseFile?.[0]?.buffer || null;
      const deaFile = req.files?.deaFile?.[0]?.buffer || null;
      const cdsFile = req.files?.cdsFile?.[0]?.buffer || null;
      const pharmacistFile = req.files?.pharmacistFile?.[0]?.buffer || null;
      const cmeaFile = req.files?.cmeaFile?.[0]?.buffer || null;

      const result = await pool.query(
        `INSERT INTO pharmacy_details (
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
          cmea_file
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
          $11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22
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
        ],
      );

      res.status(200).json({
        message: "Pharmacy details saved successfully",
        data: result.rows[0],
      });
    } catch (error) {
      console.error(error);
      res.status(500).json({
        message: "Server error",
      });
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

    if (!token) {
      return res.status(401).json({ message: "Token missing" });
    }

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
        cmea_expiry
       FROM pharmacy_details
       WHERE user_id=$1`,
      [userId],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        message: "Pharmacy details not found",
      });
    }

    res.status(200).json({
      pharmacy: result.rows[0],
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

export default router;

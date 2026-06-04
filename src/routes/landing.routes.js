// routes/landing.routes.js

import express from "express";
import { pool } from "../config/db.js";
import { Resend } from "resend";

const router = express.Router();

const resend = new Resend(process.env.RESEND_API_KEY);

// ============================================================
// LANDING PAGE STATS
// GET /api/landing/stats
// ============================================================

router.get("/stats", async (req, res) => {
  try {
    const [audits, users, masterSheet] = await Promise.all([
      pool.query(`
        SELECT COUNT(*)::INTEGER AS count
        FROM audits
      `),

      pool.query(`
        SELECT COUNT(*)::INTEGER AS count
        FROM users
        WHERE status = 'active'
      `),

      pool.query(`
        SELECT COUNT(*)::INTEGER AS count
        FROM master_sheet
      `),
    ]);

    res.json({
      success: true,

      stats: {
        audits_generated: audits.rows[0].count,

        active_pharmacies: users.rows[0].count,

        master_sheet_entries: masterSheet.rows[0].count,
      },
    });
  } catch (err) {
    console.error("Stats error:", err);

    res.status(500).json({
      success: false,
      message: "Failed to fetch stats",
    });
  }
});

// ============================================================
// CONSULTATION REQUEST
// POST /api/landing/consultation
// ============================================================

router.post("/consultation", async (req, res) => {
  try {
    const { name, email } = req.body;

    if (!name || !email) {
      return res.status(400).json({
        success: false,
        message: "Name and email are required",
      });
    }

    // ============================================================
    // SEND MAIL TO ADMIN
    // ============================================================

    await resend.emails.send({
      from: process.env.EMAIL_FROM,

      to: [process.env.EMAIL_FROM],

      subject: "New Consultation Request",

      html: `
        <p>New consultation request received.</p>

        <p><strong>Name:</strong> ${name}</p>

        <p><strong>Email:</strong> ${email}</p>
      `,
    });

    // ============================================================
    // SEND CONFIRMATION MAIL TO USER
    // ============================================================

    await resend.emails.send({
      from: process.env.EMAIL_FROM,

      to: [email],

      subject: "Consultation Request Confirmed",

      html: `
        <p>Hello ${name},</p>

        <p>Your consultation request has been received successfully.</p>

        <p>Please use the Google Calendar link to schedule your consultation.</p>

        <p>Thank you,</p>

        <p>AuditProRx Team</p>
      `,
    });

    res.json({
      success: true,
      message: "Consultation request submitted successfully",
    });
  } catch (err) {
    console.error("Consultation error:", err);

    res.status(500).json({
      success: false,
      message: "Failed to send consultation request",
    });
  }
});

export default router;

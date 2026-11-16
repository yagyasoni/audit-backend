// routes/landing.routes.js

import express from "express";
import { pool } from "../config/db.js";

const router = express.Router();

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

// The public POST /landing/consultation route was removed: consultations are
// booked through the Google Calendar form, the website never called this
// route, and it emailed any address typed into it.

export default router;

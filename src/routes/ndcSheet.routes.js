// ─────────────────────────────────────────────────────────────
// FILE: src/routes/ndcSheet.routes.js
// ─────────────────────────────────────────────────────────────

import express from "express";
import { pool } from "../config/db.js";

const router = express.Router();

// ──────────────────────────────────────────────────────────────
// GET /api/ndc-sheet
// Returns all NDC rows with their drug_name and status.
// One row per NDC (NDC is UNIQUE in the table).
// ──────────────────────────────────────────────────────────────
router.get("/ndc-sheet", async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        id,
        ndc,
        drug_name,
        status,
        created_at,
        updated_at
      FROM ndc_sheet
      ORDER BY created_at DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error("NDC fetch error:", err);
    res.status(500).json({ error: "Failed to fetch NDC sheet" });
  }
});

// ──────────────────────────────────────────────────────────────
// PUT /api/ndc-sheet/:id
// Updates drug_name and/or status for a single ndc_sheet row.
// Body: { drug_name?: string, status?: 'pending' | 'reviewed' }
// ──────────────────────────────────────────────────────────────
router.put("/ndc-sheet/:id", async (req, res) => {
  const { id } = req.params;
  const { drug_name, status } = req.body;

  try {
    if (status && !["pending", "reviewed"].includes(status)) {
      return res.status(400).json({ error: "Invalid status" });
    }

    const result = await pool.query(
      `
      UPDATE ndc_sheet
      SET
        drug_name = COALESCE($1, drug_name),
        status = COALESCE($2, status),
        updated_at = NOW()
      WHERE id = $3
      RETURNING *
      `,
      [drug_name?.trim(), status, id],
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "NDC entry not found" });
    }

    res.json({
      message: "NDC updated successfully",
      data: result.rows[0],
    });
  } catch (err) {
    console.error("NDC update error:", err);
    res.status(500).json({ error: "Failed to update NDC" });
  }
});

// ──────────────────────────────────────────────────────────────
// DELETE /api/ndc-sheet/:id
// ──────────────────────────────────────────────────────────────
router.delete("/ndc-sheet/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(`DELETE FROM ndc_sheet WHERE id = $1`, [
      id,
    ]);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Entry not found" });
    }

    res.json({ message: "Deleted successfully" });
  } catch (err) {
    console.error("Delete error:", err);
    res.status(500).json({ error: "Failed to delete" });
  }
});

export default router;

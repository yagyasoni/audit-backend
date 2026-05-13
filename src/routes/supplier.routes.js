import express from "express";
import { pool } from "../config/db.js";
import crypto from "crypto";
import { Resend } from "resend";

const router = express.Router();
const resend = new Resend(process.env.RESEND_API_KEY);

const STANDARD_FIELDS = [
  "ndc_number",
  "invoice_date",
  "item_description",
  "quantity",
  "unit_price",
  "total_price",
];

const REQUIRED_FIELDS = [
  "ndc_number",
  "invoice_date",
  "item_description",
  "quantity",
];

// ─────────────────────────────────────────────────────────────
// ROUTE 1: GET /api/suppliers
// Returns the master list of all supplier names
// ─────────────────────────────────────────────────────────────
router.get("/suppliers", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        s.id,
        s.name,
        s.email,
        s.phone_number,
        s.created_at,
        sm.mappings
      FROM suppliers s
      LEFT JOIN supplier_mappings sm
        ON s.id = sm.supplier_id
      ORDER BY s.name ASC
    `);

    res.status(200).json(result.rows);
  } catch (error) {
    console.error("Error fetching suppliers:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────
// ROUTE 2: GET /api/user-suppliers/:userId
// Returns the suppliers selected by a specific user
// ─────────────────────────────────────────────────────────────
router.get("/user-suppliers/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const result = await pool.query(
      `SELECT s.id, s.name
       FROM user_suppliers us
       JOIN suppliers s ON us.supplier_id = s.id
       WHERE us.user_id = $1
       ORDER BY s.name ASC`,
      [userId],
    );
    res.status(200).json(result.rows);
  } catch (error) {
    console.error("Error fetching user suppliers:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────
// ROUTE 3: POST /api/user-suppliers/:userId
// Saves/replaces a user's selected suppliers
// Body: { supplierNames: ["AXIA", "MCKESSON"] }
// ─────────────────────────────────────────────────────────────
router.post("/user-suppliers/:userId", async (req, res) => {
  const client = await pool.connect();
  try {
    const { userId } = req.params;
    const { supplierNames } = req.body;

    if (!Array.isArray(supplierNames)) {
      return res
        .status(400)
        .json({ message: "supplierNames must be an array" });
    }

    await client.query("BEGIN");

    // Delete old selections for this user
    await client.query("DELETE FROM user_suppliers WHERE user_id = $1", [
      userId,
    ]);

    // Insert new selections
    let insertedCount = 0;
    for (const name of supplierNames) {
      const result = await client.query(
        `INSERT INTO user_suppliers (id, user_id, supplier_id)
         SELECT gen_random_uuid(), $1, s.id
         FROM suppliers s
         WHERE s.name = $2
         ON CONFLICT (user_id, supplier_id) DO NOTHING`,
        [userId, name],
      );
      insertedCount += result.rowCount;
    }

    await client.query("COMMIT");

    //     const emailResult = await pool.query(
    //       `SELECT email FROM users WHERE id = $1`,
    //       [userId],
    //     );

    //     const email = emailResult.rows[0]?.email;

    //     if (email) {
    //       try {
    //         await resend.emails.send({
    //           from: process.env.EMAIL_FROM,
    //           to: email,
    //           subject: "Account Created Successfully",
    //           html: `
    // <div style="font-family: Arial, sans-serif; background-color:#f4f6f8; padding:20px;">
    //   <div style="max-width:600px; margin:auto; background:#ffffff; border-radius:8px; overflow:hidden;">

    //     <!-- Header -->
    //     <div style="background:#0f172a; color:#ffffff; padding:16px; text-align:center; font-size:18px; font-weight:600;">
    //       Account Created Successfully
    //     </div>

    //     <!-- Body -->
    //     <div style="padding:24px; color:#1f2937;">
    //       <p style="margin-bottom:16px;">Hello,</p>
    //       <p style="margin-bottom:16px;">
    //         Your account has been created successfully for the AuditProRx platform.
    //       </p>

    //       <div style="text-align:center; margin:24px 0;">
    //         <span style="font-size:28px; font-weight:bold; letter-spacing:4px; color:#0f172a;">
    //           A U D I T P R O R X
    //         </span>
    //       </div>

    //       <p style="margin-bottom:16px;">
    //        If you did not create this account, please ignore this email or contact support.
    //       </p>
    //     </div>

    //     <!-- Footer -->
    //     <div style="background:#f1f5f9; padding:16px; font-size:12px; text-align:center; color:#64748b;">
    //       © 2026 AuditProRx. All rights reserved.<br/>
    //       <a href="#" style="color:#64748b; text-decoration:underline;">Unsubscribe</a>
    //     </div>

    //   </div>
    // </div>
    // `,
    //         });
    //       } catch (err) {
    //         console.error("Email failed:", err);
    //       }
    //     }

    res.status(200).json({
      message: "Suppliers saved successfully",
      count: insertedCount,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error saving user suppliers:", error);
    res.status(500).json({ message: "Server error" });
  } finally {
    client.release();
  }
});

router.post("/suppliers", async (req, res) => {
  try {
    const { name, email, phone_number } = req.body;

    const result = await pool.query(
      `INSERT INTO suppliers (id, name, email, phone_number)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [crypto.randomUUID(), name, email || null, phone_number || null],
    );

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete("/suppliers/:id", async (req, res) => {
  const { id } = req.params;

  try {
    // Check if supplier exists
    const existing = await pool.query(
      "SELECT id FROM suppliers WHERE id = $1",
      [id],
    );

    if (existing.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Supplier not found",
      });
    }

    // Delete supplier (mapping will auto-delete via CASCADE)
    await pool.query("DELETE FROM suppliers WHERE id = $1", [id]);

    return res.json({
      success: true,
      message: "Supplier and its mapping deleted successfully",
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: "Failed to delete supplier",
      error: err.message,
    });
  }
});

router.get("/supplier-mapping/:supplierId", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM supplier_mappings WHERE supplier_id = $1`,
      [req.params.supplierId],
    );

    res.json(result.rows[0] || null);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/supplier-mapping", async (req, res) => {
  try {
    const { supplier_id, mappings } = req.body;

    const mappedFields = Object.values(mappings);

    // Validate required fields
    for (let field of REQUIRED_FIELDS) {
      if (!mappedFields.includes(field)) {
        return res.status(400).json({
          error: `${field} is required`,
        });
      }
    }

    const result = await pool.query(
      `
      INSERT INTO supplier_mappings (id, supplier_id, mappings)
      VALUES ($1, $2, $3)
      ON CONFLICT (supplier_id)
      DO UPDATE SET mappings = $3
      RETURNING *
      `,
      [crypto.randomUUID(), supplier_id, mappings],
    );

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/supplier-mapping-by-name/:supplierName", async (req, res) => {
  try {
    const { supplierName } = req.params;

    const result = await pool.query(
      `SELECT sm.mappings
       FROM supplier_mappings sm
       JOIN suppliers s ON sm.supplier_id = s.id
       WHERE s.name = $1`,
      [supplierName],
    );

    if (result.rows.length === 0) {
      return res.json({ mappings: null });
    }

    res.json({ mappings: result.rows[0].mappings });
  } catch (err) {
    console.error("Error fetching supplier mapping by name:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/bin-search — search master_sheet by BIN/PCN/Group
// ─────────────────────────────────────────────────────────────
router.get("/bin-search", async (req, res) => {
  try {
    const { bin, pcn, group } = req.query;

    if (!bin || !bin.trim()) {
      return res.status(400).json({ message: "BIN is required" });
    }

    const trimmedBin = bin.trim();
    const trimmedPcn = pcn?.trim().toUpperCase() || "";
    const trimmedGroup = group?.trim().toUpperCase() || "";

    let result;

    // Try all three first
    if (trimmedPcn && trimmedGroup) {
      result = await pool.query(
        `SELECT DISTINCT pbm_name, payer_type FROM master_sheet
         WHERE LTRIM(UPPER(TRIM(bin)), '0') = LTRIM(UPPER($1), '0')
           AND UPPER(TRIM(COALESCE(pcn, ''))) = $2
           AND UPPER(TRIM(COALESCE(grp, ''))) = $3`,
        [trimmedBin, trimmedPcn, trimmedGroup],
      );
      if (result.rows.length > 0) return res.json(result.rows);
    }

    // Fallback: BIN + PCN
    if (trimmedPcn) {
      result = await pool.query(
        `SELECT DISTINCT pbm_name, payer_type FROM master_sheet
         WHERE LTRIM(UPPER(TRIM(bin)), '0') = LTRIM(UPPER($1), '0')
           AND UPPER(TRIM(COALESCE(pcn, ''))) = $2`,
        [trimmedBin, trimmedPcn],
      );
      if (result.rows.length > 0) return res.json(result.rows);
    }

    // Fallback: BIN only
    result = await pool.query(
      `SELECT DISTINCT pbm_name, payer_type FROM master_sheet
       WHERE LTRIM(UPPER(TRIM(bin)), '0') = LTRIM(UPPER($1), '0')`,
      [trimmedBin],
    );

    return res.json(result.rows);
  } catch (error) {
    console.error("BIN search error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

router.put("/suppliers/:id/email", async (req, res) => {
  try {
    const { id } = req.params;
    const { email, phone_number } = req.body;

    const result = await pool.query(
      `UPDATE suppliers
       SET email = $1, phone_number = $2
       WHERE id = $3
       RETURNING *`,
      [email, phone_number, id],
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Supplier not found" });
    }

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;

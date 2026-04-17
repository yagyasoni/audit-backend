// ─────────────────────────────────────────────────────────────
// FILE: src/routes/admin.routes.js
// ─────────────────────────────────────────────────────────────

import express from "express";
import { pool } from "../config/db.js"; // same db.js your other routes use

const router = express.Router();

// DELETE /admin/users/:id

router.delete("/users/:id", async (req, res) => {
  const { id } = req.params;

  try {
    // optional: check if user exists
    const userCheck = await pool.query(
      "SELECT id, email FROM users WHERE id = $1",
      [id],
    );

    if (userCheck.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const email = userCheck.rows[0].email;

    // 🔥 delete user (CASCADE handles rest)
    await pool.query("DELETE FROM users WHERE id = $1", [id]);

    // ⚠️ manual cleanup (email-based tables)
    await pool.query("DELETE FROM email_otps WHERE email = $1", [email]);
    await pool.query("DELETE FROM password_resets WHERE email = $1", [email]);

    return res.json({
      success: true,
      message: "User and all related data deleted successfully",
    });
  } catch (err) {
    console.error("Delete user error:", err);
    return res.status(500).json({
      success: false,
      message: "Failed to delete user",
    });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /admin/excel
// Returns every row from master_sheet as:
//   { sheetName, headers, rows, total }
// headers: ["id","bin","pcn","grp","pbm_name","payer_type"]
// rows:    string[][] — each row is an ordered array matching headers
// ─────────────────────────────────────────────────────────────
router.get("/excel", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, bin, pcn, grp, pbm_name, payer_type
       FROM master_sheet
       ORDER BY id ASC`,
    );

    const headers = ["id", "bin", "pcn", "grp", "pbm_name", "payer_type"];

    const rows = result.rows.map((row) =>
      headers.map((col) =>
        row[col] !== null && row[col] !== undefined ? String(row[col]) : "",
      ),
    );

    return res.status(200).json({
      sheetName: "master_sheet",
      headers,
      rows,
      total: result.rows.length,
    });
  } catch (err) {
    console.error("[GET /admin/excel]", err);
    return res
      .status(500)
      .json({ error: "Failed to fetch master_sheet data." });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /admin/excel
// Body: { sheetName, headers, rows }
// - row with non-empty id  → UPDATE
// - row with empty id      → INSERT (bigserial auto-assigns id)
// Wrapped in a transaction — all-or-nothing
// ─────────────────────────────────────────────────────────────
router.post("/excel", async (req, res) => {
  const { headers, rows } = req.body;

  if (!Array.isArray(headers) || !Array.isArray(rows)) {
    return res.status(400).json({
      error: "Invalid payload. Expected { headers: string[], rows: any[][] }.",
    });
  }

  // Build column-index map from headers array sent by the frontend
  const idx = {};
  headers.forEach((h, i) => {
    idx[h] = i;
  });

  const client = await pool.connect();
  let updated = 0;
  let inserted = 0;

  try {
    await client.query("BEGIN");

    //   for (const row of rows) {
    //     // const id = row[idx["id"]] ?? "";
    //     const rawId = row[idx["id"]];
    //     const id = Number(rawId);

    //     const hasId = Number.isInteger(id) && id > 0;
    //     // const bin = row[idx["bin"]] ?? null;
    //     // const pcn = row[idx["pcn"]] ?? null;
    //     // const grp = row[idx["grp"]] ?? null;
    //     // const pbm_name = row[idx["pbm_name"]] ?? null;
    //     // const payer_type = row[idx["payer_type"]] ?? null;

    //     const clean = (v) => (typeof v === "string" ? v.trim() : v);

    //     const bin = clean(row[idx["bin"]]) || null;
    //     const pcn = clean(row[idx["pcn"]]) || null;
    //     const grp = clean(row[idx["grp"]]) || null;
    //     const pbm_name = clean(row[idx["pbm_name"]]) || null;
    //     const payer_type = clean(row[idx["payer_type"]]) || null;

    //     // const hasId =
    //     //   id !== "" && id !== null && !isNaN(Number(id)) && Number(id) > 0;

    //     if (hasId) {
    //       // await client.query(
    //       //   `UPDATE master_sheet
    //       //    SET bin = $1, pcn = $2, grp = $3, pbm_name = $4, payer_type = $5
    //       //    WHERE id = $6`,
    //       //   [
    //       //     bin || null,
    //       //     pcn || null,
    //       //     grp || null,
    //       //     pbm_name || null,
    //       //     payer_type || null,
    //       //     Number(id),
    //       //   ],
    //       // );
    //       // updated++;
    //       const result = await client.query(
    //         `UPDATE master_sheet
    //  SET bin = $1, pcn = $2, grp = $3, pbm_name = $4, payer_type = $5
    //  WHERE id = $6`,
    //         [
    //           bin || null,
    //           pcn || null,
    //           grp || null,
    //           pbm_name || null,
    //           payer_type || null,
    //           Number(id),
    //         ],
    //       );

    //       if (result.rowCount > 0) {
    //         updated++;
    //       } else {
    //         console.warn("⚠️ No row found for id:", id);
    //       }
    //     } else {
    //       await client.query(
    //         `INSERT INTO master_sheet (bin, pcn, grp, pbm_name, payer_type)
    //          VALUES ($1, $2, $3, $4, $5)`,
    //         [
    //           bin || null,
    //           pcn || null,
    //           grp || null,
    //           pbm_name || null,
    //           payer_type || null,
    //         ],
    //       );
    //       inserted++;
    //     }
    //   }

    for (const row of rows) {
      const rawId = row[idx["id"]];
      const id = Number(rawId);

      const clean = (v) =>
        typeof v === "string" ? v.trim() || null : (v ?? null);

      const bin = clean(row[idx["bin"]]);
      const pcn = clean(row[idx["pcn"]]);
      const grp = clean(row[idx["grp"]]);
      const pbm_name = clean(row[idx["pbm_name"]]);
      const payer_type = clean(row[idx["payer_type"]]);

      // 🔥 STRICT CONDITION
      if (Number.isInteger(id) && id > 0) {
        const result = await client.query(
          `UPDATE master_sheet
       SET bin = $1, pcn = $2, grp = $3, pbm_name = $4, payer_type = $5
       WHERE id = $6`,
          [bin, pcn, grp, pbm_name, payer_type, id],
        );

        if (result.rowCount === 0) {
          console.log("❌ Update failed for id:", id);
        } else {
          updated++;
        }
      } else {
        await client.query(
          `INSERT INTO master_sheet (bin, pcn, grp, pbm_name, payer_type)
       VALUES ($1, $2, $3, $4, $5)`,
          [bin, pcn, grp, pbm_name, payer_type],
        );

        inserted++;
      }
    }

    await client.query("COMMIT");
    console.log(`[POST /admin/excel] updated=${updated} inserted=${inserted}`);

    return res.status(200).json({
      success: true,
      message: `${updated} rows updated, ${inserted} rows inserted.`,
      updated,
      inserted,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[POST /admin/excel]", err);
    return res
      .status(500)
      .json({ error: "Save failed. Transaction rolled back." });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────
// DELETE /admin/excel/row/:id
// Deletes a single master_sheet row by its bigint PK
// Called once per deleted row before the bulk POST save
// ─────────────────────────────────────────────────────────────
router.delete("/excel/row/:id", async (req, res) => {
  const { id } = req.params;

  if (!id || isNaN(Number(id)) || Number(id) <= 0) {
    return res
      .status(400)
      .json({ error: "Invalid id. Must be a positive integer." });
  }

  try {
    const result = await pool.query(
      `DELETE FROM master_sheet WHERE id = $1 RETURNING id`,
      [Number(id)],
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: `Row with id=${id} not found.` });
    }

    console.log(`[DELETE /admin/excel/row/${id}] deleted`);
    return res
      .status(200)
      .json({ success: true, message: `Row ${id} deleted.` });
  } catch (err) {
    console.error(`[DELETE /admin/excel/row/${id}]`, err);
    return res.status(500).json({ error: "Failed to delete row." });
  }
});

// router.get("/master-sheet-queue", async (req, res) => {
//   try {
//     const result = await pool.query(`
//       SELECT id, bin, pcn, grp, pbm_name, payer_type
//       FROM master_sheet_queue
//       WHERE status = 'pending'
//       ORDER BY id ASC
//     `);

//     return res.status(200).json({
//       rows: result.rows,
//       total: result.rows.length,
//     });
//   } catch (err) {
//     console.error("[GET /master-sheet-queue]", err);
//     return res.status(500).json({ error: "Failed to fetch queue." });
//   }
// });

router.get("/master-sheet-queue", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT ON (bin, pcn, grp)
        id, bin, pcn, grp, pbm_name, payer_type
      FROM master_sheet_queue
      WHERE status = 'pending'
      ORDER BY bin, pcn, grp, id ASC
    `);

    return res.status(200).json({
      rows: result.rows,
      total: result.rows.length,
    });
  } catch (err) {
    console.error("[GET /master-sheet-queue]", err);
    return res.status(500).json({ error: "Failed to fetch queue." });
  }
});

router.put("/master-sheet-queue/:id", async (req, res) => {
  const { id } = req.params;
  const { pbm_name, payer_type } = req.body;

  if (!id || isNaN(Number(id))) {
    return res.status(400).json({ error: "Invalid ID" });
  }

  try {
    await pool.query(
      `UPDATE master_sheet_queue
       SET pbm_name = $1, payer_type = $2
       WHERE id = $3`,
      [pbm_name || null, payer_type || null, Number(id)],
    );

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("[PUT /master-sheet-queue/:id]", err);
    return res.status(500).json({ error: "Update failed" });
  }
});

router.post("/master-sheet-queue/:id/add", async (req, res) => {
  const { id } = req.params;

  if (!id || isNaN(Number(id))) {
    return res.status(400).json({ error: "Invalid ID" });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // 1. Fetch queue row
    const { rows } = await client.query(
      `SELECT * FROM master_sheet_queue
       WHERE id = $1 AND status = 'pending'`,
      [Number(id)],
    );

    if (rows.length === 0) {
      throw new Error("Row not found or already added");
    }

    const row = rows[0];

    // 2. Validate selection
    if (!row.pbm_name || !row.payer_type) {
      throw new Error("PBM Name and Payer Type required");
    }

    // 3. INSERT into master_sheet (NO UPDATE EVER)
    await client.query(
      `INSERT INTO master_sheet (bin, pcn, grp, pbm_name, payer_type)
       VALUES (LPAD($1, 6, '0'), $2, $3, $4, $5)
       ON CONFLICT (bin, pcn, grp) DO NOTHING`,
      [row.bin, row.pcn, row.grp, row.pbm_name, row.payer_type],
    );

    // 4. Mark queue as added
    await client.query(
      `UPDATE master_sheet_queue
       SET status = 'added'
       WHERE id = $1`,
      [Number(id)],
    );

    await client.query("COMMIT");

    return res.status(200).json({ success: true });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[POST /master-sheet-queue/:id/add]", err);
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

router.get("/master-sheet-queue/stats", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status = 'pending') as pending,
        COUNT(*) FILTER (WHERE status = 'added') as added
      FROM master_sheet_queue
    `);

    return res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error("[GET /master-sheet-queue/stats]", err);
    return res.status(500).json({ error: "Failed to fetch stats" });
  }
});

router.post("/feedbacks", async (req, res) => {
  try {
    const { user_id, subject, message } = req.body;

    if (!subject || !message) {
      return res.status(400).json({ message: "Subject and message required" });
    }

    const result = await pool.query(
      `INSERT INTO feedbacks (user_id, subject, message)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [user_id || null, subject, message],
    );

    res.status(200).json({
      message: "Feedback submitted successfully",
      feedback: result.rows[0],
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

router.get("/feedbacks", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT 
         f.id,
         f.subject,
         f.message,
         f.created_at,
         u.name AS user_name,
         u.email,
         u.phone,
         p.pharmacy_name
       FROM feedbacks f
       LEFT JOIN users u ON f.user_id = u.id
       LEFT JOIN pharmacy_details p ON p.user_id = u.id
       ORDER BY f.created_at DESC`,
    );

    res.status(200).json({
      feedbacks: result.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

router.delete("/feedbacks/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `DELETE FROM feedbacks WHERE id = $1 RETURNING *`,
      [id],
    );

    if (!result.rows.length) {
      return res.status(404).json({ message: "Feedback not found" });
    }

    res.status(200).json({
      message: "Feedback deleted successfully",
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

export default router;

import { pool } from "../config/db.js";
import fs from "fs";
import path from "path";
import { parse } from "csv-parse/sync";
import { normalizeInventoryCSV } from "../utils/inventoryNormalizer.js";
import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

const normalizeNDC = (ndc) => {
  if (!ndc) return null;

  // 1. Keep only digits
  let digits = ndc.replace(/\D/g, "");

  // 2. Pad to 11 digits
  digits = digits.padStart(11, "0");

  // 3. Format to 5-4-2
  return `${digits.slice(0, 5)}-${digits.slice(5, 9)}-${digits.slice(9, 11)}`;
};

export const createAudit = async (name, userId) => {
  const result = await pool.query(
    `INSERT INTO audits (name, user_id, status)
     VALUES ($1, $2, 'started')
     RETURNING *`,
    [name, userId],
  );

  return result.rows[0];
};

const FRONT_TO_DB_KEY = {
  ndcNumber: "ndc",
  rxNumber: "rx_number",
  status: "status",
  dateFilled: "date_filled",
  drugName: "drug_name",
  quantity: "quantity",
  packageSize: "package_size",
  primaryInsuranceBinNumber: "primary_bin",
  primaryInsurancePaid: "primary_paid",
  secondaryInsuranceBinNumber: "secondary_bin",
  secondaryInsurancePaid: "secondary_paid",
  brand: "brand",
};

// ── Auto-refresh audit status based on uploaded files ──────────────────────
export const refreshAuditStatus = async (auditId) => {
  const invCheck = await pool.query(
    `SELECT COUNT(*) FROM audit_inventory_files WHERE audit_id = $1`,
    [auditId],
  );
  const wsCheck = await pool.query(
    `SELECT COUNT(*) FROM wholesaler_files WHERE audit_id = $1`,
    [auditId],
  );

  const hasInventory = parseInt(invCheck.rows[0].count) > 0;
  const hasWholesaler = parseInt(wsCheck.rows[0].count) > 0;

  const newStatus = hasInventory && hasWholesaler ? "ready" : "started";

  await pool.query(`UPDATE audits SET status = $1 WHERE id = $2`, [
    newStatus,
    auditId,
  ]);
};

function toDbHeaderMapping(frontMapping = {}) {
  const out = {};
  for (const [frontKey, selectedStandardHeader] of Object.entries(
    frontMapping,
  )) {
    const dbKey = FRONT_TO_DB_KEY[frontKey];
    if (!dbKey) continue;
    out[dbKey] = selectedStandardHeader;
  }
  return out;
}

const cleanNumber = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const s = String(v).trim();
  const n = Number(s.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : null;
};

const cleanInt = (v) => {
  const n = cleanNumber(v);
  return n === null ? null : Math.trunc(n);
};

// const cleanDate = (v) => {
//   if (!v) return null;
//   const s = String(v)
//     .trim()
//     .replace(/\s+\d{1,2}:\d{2}(:\d{2})?\s*(AM|PM)?$/i, "");

//   if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

//   const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
//   if (m) {
//     const mm = String(m[1]).padStart(2, "0");
//     const dd = String(m[2]).padStart(2, "0");
//     const yy = m[3];
//     return `${yy}-${mm}-${dd}`;
//   }

//   return null;
// };

const cleanDate = (v) => {
  // if (v === null || v === undefined || v === "") return null;
  // const s = String(v).trim();
  if (v === null || v === undefined || v === "") return null;
  let s = String(v).trim();
  if (!s) return null;

  // Strip trailing time like " 0:00", " 12:30:00", " 3:45 PM"
  s = s.replace(/\s+\d{1,2}:\d{2}(:\d{2})?\s*(AM|PM)?$/i, "");

  // ISO format YYYY-MM-DD (with or without time)
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);

  // M/D/YYYY or MM/DD/YYYY
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const mm = String(m[1]).padStart(2, "0");
    const dd = String(m[2]).padStart(2, "0");
    return `${m[3]}-${mm}-${dd}`;
  }

  // M/D/YY — 2-digit year
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (m) {
    const mm = String(m[1]).padStart(2, "0");
    const dd = String(m[2]).padStart(2, "0");
    const yy = parseInt(m[3], 10);
    const yyyy = yy >= 70 ? 1900 + yy : 2000 + yy;
    return `${yyyy}-${mm}-${dd}`;
  }

  // M-D-YYYY or MM-DD-YYYY
  m = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (m) {
    const mm = String(m[1]).padStart(2, "0");
    const dd = String(m[2]).padStart(2, "0");
    return `${m[3]}-${mm}-${dd}`;
  }

  // Excel serial number (pure digits, sane range: ~1927–2119)
  if (/^\d+$/.test(s)) {
    const serial = parseInt(s, 10);
    if (serial >= 10000 && serial <= 80000) {
      const utcMs = (serial - 25569) * 86400 * 1000;
      const d = new Date(utcMs);
      if (!isNaN(d.getTime())) {
        const yyyy = d.getUTCFullYear();
        const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
        const dd = String(d.getUTCDate()).padStart(2, "0");
        return `${yyyy}-${mm}-${dd}`;
      }
    }
    // Pure digits but out of Excel-serial range — reject, don't treat as year
    return null;
  }

  return null;
};

const cleanDateNew = (v) => {
  if (!v) return null;

  let s = String(v).trim();

  // Remove time part (handles space + T formats)
  s = s.replace(/([T\s]\d{1,2}:\d{2}(:\d{2})?\s*(AM|PM)?)$/i, "");

  // Case 1: YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  // Case 2: MM/DD/YYYY
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const mm = String(m[1]).padStart(2, "0");
    const dd = String(m[2]).padStart(2, "0");
    const yy = m[3];
    return `${yy}-${mm}-${dd}`;
  }

  // 🔥 Fallback (VERY IMPORTANT)
  const d = new Date(v);
  if (!isNaN(d.getTime())) {
    return d.toISOString().split("T")[0];
  }

  return null;
};

export const updateAuditDates = async (auditId, dates) => {
  const {
    inventory_start_date,
    inventory_end_date,
    wholesaler_start_date,
    wholesaler_end_date,
  } = dates;

  const result = await pool.query(
    `
    UPDATE audits
    SET
      inventory_start_date = $1,
      inventory_end_date = $2,
      wholesaler_start_date = $3,
      wholesaler_end_date = $4
    WHERE id = $5
    RETURNING *
    `,
    [
      inventory_start_date,
      inventory_end_date,
      wholesaler_start_date,
      wholesaler_end_date,
      auditId,
    ],
  );

  return result.rows[0] || null;
};

export const saveInventoryFile = async (
  auditId,
  filename,
  headerMapping,
  options = {},
) => {
  const { excludeTransferred = false, excludeUnbilled = false } = options;

  const auditCheck = await pool.query("SELECT id FROM audits WHERE id = $1", [
    auditId,
  ]);
  if (auditCheck.rows.length === 0) throw new Error("Audit not found");

  // ✅ Clean old inventory data (replace behavior)
  await pool.query(`DELETE FROM inventory_rows WHERE audit_id = $1`, [auditId]);
  const oldInvFiles = await pool.query(
    `SELECT file_name FROM audit_inventory_files WHERE audit_id = $1`,
    [auditId],
  );
  for (const row of oldInvFiles.rows) {
    const oldPath = path.join(
      process.cwd(),
      "uploads/inventory",
      row.file_name,
    );
    try {
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    } catch (e) {}
  }
  await pool.query(`DELETE FROM audit_inventory_files WHERE audit_id = $1`, [
    auditId,
  ]);

  const result = await pool.query(
    `
    INSERT INTO audit_inventory_files (audit_id, file_name)
    VALUES ($1, $2)
    RETURNING *
    `,
    [auditId, filename],
  );

  const filePath = path.join(process.cwd(), "uploads/inventory", filename);
  const dbHeaderMapping = toDbHeaderMapping(headerMapping);
  console.log("Normalizing file:", filePath);
  console.log("Header mapping:", headerMapping);
  console.log("Exclusions:", { excludeTransferred, excludeUnbilled });

  let normalizedPath;
  try {
    normalizedPath = await normalizeInventoryCSV(filePath, headerMapping);
    console.log("Normalized file created:", normalizedPath);
  } catch (e) {
    console.error("NORMALIZATION FAILED:", e);
    throw e;
  }

  const normalizedContent = fs.readFileSync(normalizedPath, "utf-8");
  const records = parse(normalizedContent, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });

  console.log("Total rows parsed:", records.length);

  // ── ✅ Apply status filters ──
  const filteredRecords = records.filter((r) => {
    const status = String(r.status || "")
      .trim()
      .toUpperCase();
    if (excludeTransferred && status === "T") return false;
    if (excludeUnbilled && status === "U") return false;
    return true;
  });

  const droppedCount = records.length - filteredRecords.length;
  console.log(
    `After exclusions: ${filteredRecords.length} rows (dropped ${droppedCount})`,
  );

  if (filteredRecords.length > 0) {
    console.log("First row sample:", JSON.stringify(filteredRecords[0]));
    await insertInventoryRows(auditId, filteredRecords);
  }

  await refreshAuditStatus(auditId);

  return result.rows[0];
};

// ── BULK INSERT with chunking (max 1000 rows per query to stay under 65,535 param limit) ──
export const insertInventoryRows = async (auditId, rows) => {
  if (!rows.length) return { inserted: 0 };

  const client = await pool.connect();
  const CHUNK_SIZE = 1000; // 1000 rows × 15 cols = 15,000 params — safe

  try {
    await client.query("BEGIN");

    for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
      const chunk = rows.slice(i, i + CHUNK_SIZE);
      const values = [];

      const placeholders = chunk.map((r, idx) => {
        const base = idx * 15;
        values.push(
          auditId,
          r.ndc || null,
          r.rx_number || null,
          r.status || null,
          cleanDate(r.date_filled),
          r.drug_name || null,
          r.quantity ? parseInt(r.quantity) : null,
          r.package_size || null,
          r.primary_bin || null,
          r.primary_pcn || null,
          r.primary_group || null,
          r.primary_paid ? parseFloat(r.primary_paid) : null,
          r.secondary_bin || null,
          r.secondary_paid ? parseFloat(r.secondary_paid) : null,
          r.brand || null,
        );
        return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10},$${base + 11},$${base + 12},$${base + 13},$${base + 14},$${base + 15})`;
      });

      await client.query(
        `INSERT INTO inventory_rows
         (audit_id, ndc, rx_number, status, date_filled, drug_name, quantity, package_size,
          primary_bin, primary_pcn, primary_group, primary_paid, secondary_bin, secondary_paid, brand)
         VALUES ${placeholders.join(",")}`,
        values,
      );

      console.log(
        `✅ Chunk ${Math.floor(i / CHUNK_SIZE) + 1}/${Math.ceil(rows.length / CHUNK_SIZE)} inserted`,
      );
    }

    //     const queueInsertResult = await client.query(
    //       `
    //   INSERT INTO master_sheet_queue (bin, pcn, grp)
    //   SELECT DISTINCT
    //     LPAD(TRIM(i.primary_bin), 6, '0'),
    //     LOWER(TRIM(i.primary_pcn)),
    //     LOWER(TRIM(i.primary_group))

    //   FROM inventory_rows i

    //   LEFT JOIN master_sheet m
    //     ON LPAD(TRIM(i.primary_bin), 6, '0') = LPAD(TRIM(m.bin), 6, '0')
    //    AND COALESCE(LOWER(TRIM(i.primary_pcn)), '') = COALESCE(LOWER(TRIM(m.pcn)), '')
    //    AND COALESCE(LOWER(TRIM(i.primary_group)), '') = COALESCE(LOWER(TRIM(m.grp)), '')

    //   LEFT JOIN master_sheet_queue q
    //     ON LPAD(TRIM(i.primary_bin), 6, '0') = LPAD(TRIM(q.bin), 6, '0')
    //    AND COALESCE(LOWER(TRIM(i.primary_pcn)), '') = COALESCE(LOWER(TRIM(q.pcn)), '')
    //    AND COALESCE(LOWER(TRIM(i.primary_group)), '') = COALESCE(LOWER(TRIM(q.grp)), '')

    //   WHERE i.audit_id = $1
    //     AND m.id IS NULL
    //     AND q.id IS NULL
    //     AND i.primary_bin IS NOT NULL

    //   ON CONFLICT DO NOTHING
    // `,
    //       [auditId],
    //     );

    const queueInsertResult = await client.query(
      `
  INSERT INTO master_sheet_queue (bin, pcn, grp)
  SELECT DISTINCT 
    LPAD(TRIM(i.primary_bin), 6, '0'),
    LOWER(TRIM(i.primary_pcn)),
    LOWER(TRIM(i.primary_group))

  FROM inventory_rows i

  LEFT JOIN master_sheet m
    ON LPAD(TRIM(i.primary_bin), 6, '0') = LPAD(TRIM(m.bin), 6, '0')
   AND COALESCE(LOWER(TRIM(i.primary_pcn)), '') = COALESCE(LOWER(TRIM(m.pcn)), '')
   AND COALESCE(LOWER(TRIM(i.primary_group)), '') = COALESCE(LOWER(TRIM(m.grp)), '')

  LEFT JOIN master_sheet_queue q
    ON LPAD(TRIM(i.primary_bin), 6, '0') = LPAD(TRIM(q.bin), 6, '0')
   AND COALESCE(LOWER(TRIM(i.primary_pcn)), '') = COALESCE(LOWER(TRIM(q.pcn)), '')
   AND COALESCE(LOWER(TRIM(i.primary_group)), '') = COALESCE(LOWER(TRIM(q.grp)), '')

  WHERE i.audit_id = $1
    AND m.id IS NULL
    AND q.id IS NULL
    AND i.primary_bin IS NOT NULL

  ON CONFLICT DO NOTHING

  RETURNING bin, pcn, grp
`,
      [auditId],
    );

    const newQueueRows = queueInsertResult.rows;

    if (newQueueRows.length > 0) {
      // 🔥 SEND ONE EMAIL (summary)
      resend.emails
        .send({
          from: process.env.EMAIL_FROM,
          to: "drugdroprx@gmail.com",
          subject: "New Queue Items Detected",
          html: `
      <div style="font-family: Arial; padding:20px;">
        <h2>New Queue Items Added</h2>
        <p><b>Total New Items:</b> ${newQueueRows.length}</p>

        <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;">
          <tr>
            <th>BIN</th>
            <th>PCN</th>
            <th>GRP</th>
          </tr>

          ${newQueueRows
            .slice(0, 10) // limit preview
            .map(
              (r) => `
              <tr>
                <td>${r.bin}</td>
                <td>${r.pcn || "-"}</td>
                <td>${r.grp || "-"}</td>
              </tr>
            `,
            )
            .join("")}
        </table>

        ${
          newQueueRows.length > 10
            ? `<p>...and ${newQueueRows.length - 10} more</p>`
            : ""
        }
      </div>
    `,
        })
        .catch(console.error);
    }

    await client.query("COMMIT");

    console.log(`✅ All ${rows.length} inventory rows inserted`);
    return { inserted: rows.length };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
};

export const saveWholesalerFiles = async (auditId, filesArray) => {
  const auditCheck = await pool.query("SELECT id FROM audits WHERE id = $1", [
    auditId,
  ]);
  if (auditCheck.rows.length === 0) throw new Error("Audit not found");

  // ❌ REMOVED: the old blanket delete that wiped EVERY wholesaler file
  //    for this audit before each upload. That destroyed previously-uploaded
  //    files whenever the user uploaded a new batch.
  //
  //    await pool.query(`DELETE FROM wholesaler_rows WHERE audit_id = $1`, [auditId]);
  //    await pool.query(`DELETE FROM wholesaler_files WHERE audit_id = $1`, [auditId]);
  //
  // ✅ NEW: per-wholesaler replace. Each wholesaler being uploaded clears
  //    ONLY its own previous file/rows, leaving every other wholesaler
  //    on this audit untouched.

  const results = [];

  for (const fileObj of filesArray) {
    // ── Per-wholesaler cleanup (replace just this wholesaler) ──
    const existingFiles = await pool.query(
      `SELECT id, file_name
         FROM wholesaler_files
        WHERE audit_id = $1
          AND wholesaler_name = $2`,
      [auditId, fileObj.wholesaler_name],
    );

    for (const oldFile of existingFiles.rows) {
      // 1) delete child rows for this specific file
      await pool.query(
        `DELETE FROM wholesaler_rows WHERE wholesaler_file_id = $1`,
        [oldFile.id],
      );
      // 2) delete the file record
      await pool.query(`DELETE FROM wholesaler_files WHERE id = $1`, [
        oldFile.id,
      ]);
      // 3) remove the physical file from disk
      const oldPath = path.join(
        process.cwd(),
        "uploads/wholesalers",
        oldFile.file_name,
      );
      try {
        if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
      } catch (e) {
        console.warn(
          "Failed to delete old wholesaler file:",
          oldPath,
          e.message,
        );
      }
    }

    // ── Insert the new file record ──
    const fileInsert = await pool.query(
      `INSERT INTO wholesaler_files (audit_id, wholesaler_name, file_name)
       VALUES ($1, $2, $3) RETURNING *`,
      [auditId, fileObj.wholesaler_name, fileObj.file_name],
    );

    const wholesalerFileId = fileInsert.rows[0].id;

    const filePath = path.join(
      process.cwd(),
      "uploads/wholesalers",
      fileObj.file_name,
    );
    if (!fs.existsSync(filePath)) {
      console.warn("Wholesaler file not found:", filePath);
      results.push(fileInsert.rows[0]);
      continue;
    }

    const content = fs.readFileSync(filePath, "utf-8");
    const records = parse(content, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });

    const mapping = fileObj.headerMapping || {};
    console.log("WHOLESALER MAPPING:", JSON.stringify(mapping));
    if (records.length > 0) {
      const testInvoice = mapping.invoiceDate
        ? records[0][mapping.invoiceDate]
        : "NO_MAPPING_KEY";
      console.log("INVOICE DATE DEBUG:", {
        mappingKey: mapping.invoiceDate,
        rawValue: testInvoice,
        cleaned: mapping.invoiceDate
          ? cleanDate(records[0][mapping.invoiceDate])
          : null,
        csvHeaders: Object.keys(records[0]),
      });
    }
    console.log(
      "SAMPLE ROW KEYS:",
      records.length > 0 ? Object.keys(records[0]) : [],
    );
    console.log(
      "SAMPLE ROW:",
      records.length > 0 ? JSON.stringify(records[0]) : "empty",
    );

    if (records.length === 0) {
      results.push(fileInsert.rows[0]);
      continue;
    }

    // ── BULK INSERT wholesaler rows in chunks (unchanged) ──
    const CHUNK_SIZE = 1000;
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      for (let i = 0; i < records.length; i += CHUNK_SIZE) {
        const chunk = records.slice(i, i + CHUNK_SIZE);
        const values = [];

        const placeholders = chunk.map((row, idx) => {
          const base = idx * 8;

          const ndc = mapping.ndcNumber
            ? (row[mapping.ndcNumber] ?? null)
            : null;
          const invoiceDate = mapping.invoiceDate
            ? (row[mapping.invoiceDate] ?? null)
            : null;
          const productName = mapping.itemDescription
            ? (row[mapping.itemDescription] ?? null)
            : null;
          const quantity =
            mapping.quantity &&
            row[mapping.quantity] !== undefined &&
            row[mapping.quantity] !== ""
              ? parseInt(
                  String(row[mapping.quantity]).replace(/[^0-9-]/g, ""),
                ) || 0
              : null;
          const unitCost =
            mapping.unitPrice && row[mapping.unitPrice]
              ? parseFloat(
                  String(row[mapping.unitPrice]).replace(/[^0-9.]/g, ""),
                )
              : null;
          const totalCost =
            mapping.totalPrice && row[mapping.totalPrice]
              ? parseFloat(
                  String(row[mapping.totalPrice]).replace(/[^0-9.]/g, ""),
                )
              : null;

          values.push(
            auditId,
            wholesalerFileId,
            ndc,
            productName,
            quantity,
            unitCost,
            totalCost,
            cleanDate(invoiceDate),
          );

          return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8})`;
        });

        await client.query(
          `INSERT INTO wholesaler_rows
             (audit_id, wholesaler_file_id, ndc, product_name, quantity, unit_cost, total_cost, invoice_date)
           VALUES ${placeholders.join(",")}`,
          values,
        );

        console.log(
          `✅ Wholesaler chunk ${Math.floor(i / CHUNK_SIZE) + 1}/${Math.ceil(
            records.length / CHUNK_SIZE,
          )} inserted for ${fileObj.wholesaler_name}`,
        );
      }

      await client.query("COMMIT");
      console.log(
        `✅ All ${records.length} wholesaler rows inserted for ${fileObj.wholesaler_name}`,
      );
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    results.push(fileInsert.rows[0]);
  }

  await refreshAuditStatus(auditId);

  return results;
};

export const getAudits = async (userId) => {
  const result = await pool.query(
    `
    SELECT
      a.id,
      a.name,
      a.status,
      a.inventory_start_date,
      a.inventory_end_date,
      a.wholesaler_start_date,
      a.wholesaler_end_date,
      a.created_at,
      (SELECT COUNT(*) FROM audit_inventory_files f WHERE f.audit_id = a.id) AS inventory_files_count
    FROM audits a
    WHERE a.user_id = $1
    ORDER BY a.created_at DESC
  `,
    [userId],
  );

  return result.rows;
};

export const getAuditById = async (auditId) => {
  const result = await pool.query(`SELECT * FROM audits WHERE id = $1`, [
    auditId,
  ]);
  return result.rows[0] || null;
};

export const getInventoryRows = async (auditId) => {
  const result = await pool.query(
    `SELECT * FROM inventory_rows 
     WHERE audit_id = $1 
     ORDER BY id ASC`,
    [auditId],
  );

  const rows = result.rows;

  const REQUIRED_COLUMNS = [
    "ndc",
    "rx_number",
    "status",
    "date_filled",
    "drug_name",
    "quantity",
    "package_size",
    "primary_bin",
    "primary_paid",
    "secondary_bin",
    "secondary_paid",
    "brand",
  ];

  const normalized = rows.map((row) => {
    const normalizedRow = {};
    REQUIRED_COLUMNS.forEach((col) => {
      normalizedRow[col] = row[col] ?? null;
    });
    return normalizedRow;
  });

  return normalized;
};

export const deleteAudit = async (auditId) => {
  // 1. Get all physical file names BEFORE deleting DB rows
  const invFiles = await pool.query(
    `SELECT file_name FROM audit_inventory_files WHERE audit_id = $1`,
    [auditId],
  );
  const wsFiles = await pool.query(
    `SELECT file_name FROM wholesaler_files WHERE audit_id = $1`,
    [auditId],
  );

  // 2. Delete child rows explicitly (safe even with CASCADE)
  await pool.query(`DELETE FROM inventory_rows WHERE audit_id = $1`, [auditId]);
  await pool.query(`DELETE FROM wholesaler_rows WHERE audit_id = $1`, [
    auditId,
  ]);
  await pool.query(`DELETE FROM wholesaler_files WHERE audit_id = $1`, [
    auditId,
  ]);
  await pool.query(`DELETE FROM audit_inventory_files WHERE audit_id = $1`, [
    auditId,
  ]);

  // 3. Delete the audit itself
  const result = await pool.query(
    `DELETE FROM audits WHERE id = $1 RETURNING *`,
    [auditId],
  );

  // 4. Delete physical inventory files
  for (const row of invFiles.rows) {
    const filePath = path.join(
      process.cwd(),
      "uploads/inventory",
      row.file_name,
    );
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (e) {
      console.warn("Failed to delete inventory file:", filePath, e.message);
    }
  }

  // 5. Delete physical wholesaler files
  for (const row of wsFiles.rows) {
    const filePath = path.join(
      process.cwd(),
      "uploads/wholesalers",
      row.file_name,
    );
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (e) {
      console.warn("Failed to delete wholesaler file:", filePath, e.message);
    }
  }

  return result.rows[0] || null;
};

export const getDrugWholesalerDetail = async (
  auditId,
  ndc,
  { outsideRange = false, includeBilled = false } = {},
) => {
  const normalizeNDC = (val) => {
    if (!val) return null;
    const digits = String(val).replace(/\D/g, "");
    return digits.padStart(11, "0");
  };

  const normalizedDigits = normalizeNDC(ndc);

  const auditRes = await pool.query(
    `SELECT id, wholesaler_start_date, wholesaler_end_date
     FROM audits
     WHERE id = $1`,
    [auditId],
  );
  const audit = auditRes.rows[0];

  const summaryRes = await pool.query(
    `SELECT
       MAX(REGEXP_REPLACE(drug_name, '\\s*\\(\\d{5}-\\d{4}-\\d{2}\\).*$', '')) AS drug_name,
       SUM(quantity) AS total_billed,
       MAX(package_size) AS package_size
     FROM inventory_rows
     WHERE audit_id = $1
       AND RIGHT(LPAD(REGEXP_REPLACE(TRIM(ndc), '[^0-9]', '', 'g'), 11, '0'), 10)
           = RIGHT($2, 10)`,
    [auditId, normalizedDigits],
  );
  const summary = summaryRes.rows[0];

  // ✅ NO DATE FILTER HERE
  const wsRes = await pool.query(
    `SELECT
       wr.id,
       wf.wholesaler_name AS type,
       TO_CHAR(wr.invoice_date, 'YYYY-MM-DD') AS invoice_date,
       wr.quantity,
       wr.unit_cost,
       wr.total_cost,
       'wholesaler' AS source
     FROM wholesaler_rows wr
     JOIN wholesaler_files wf ON wf.id = wr.wholesaler_file_id
     WHERE wr.audit_id = $1
       AND RIGHT(LPAD(REGEXP_REPLACE(TRIM(wr.ndc), '[^0-9]', '', 'g'), 11, '0'), 10)
           = RIGHT($2, 10)
     ORDER BY wr.invoice_date ASC NULLS LAST, wr.id ASC`,
    [auditId, normalizedDigits],
  );

  let allRows = wsRes.rows;

  // ✅ APPLY DATE FILTER ONLY IF USER ASKS (OPTIONAL)
  if (outsideRange) {
    allRows = allRows.filter((row) => {
      if (!row.invoice_date) return true;

      const inv = new Date(row.invoice_date);
      const start = audit?.wholesaler_start_date
        ? new Date(audit.wholesaler_start_date)
        : null;
      const end = audit?.wholesaler_end_date
        ? new Date(audit.wholesaler_end_date)
        : null;

      if (!start || !end) return true;

      return inv < start || inv > end;
    });
  }

  if (includeBilled) {
    const billedRes = await pool.query(
      `SELECT
         ir.id,
         'BILLED' AS type,
         TO_CHAR(ir.date_filled, 'YYYY-MM-DD') AS invoice_date,
      (
  ir.quantity::numeric /
  NULLIF(
    NULLIF(REGEXP_REPLACE(ir.package_size, '[^0-9.]', '', 'g'), '')::numeric,
    0
  )
) AS quantity,
         NULL AS unit_cost,
         NULL AS total_cost,
         'inventory' AS source
       FROM inventory_rows ir
       WHERE ir.audit_id = $1
         AND RIGHT(LPAD(REGEXP_REPLACE(TRIM(ir.ndc), '[^0-9]', '', 'g'), 11, '0'), 10)
             = RIGHT($2, 10)
       ORDER BY ir.date_filled ASC NULLS LAST, ir.id ASC`,
      [auditId, normalizedDigits],
    );

    allRows = [...allRows, ...billedRes.rows].sort((a, b) => {
      if (!a.invoice_date) return 1;
      if (!b.invoice_date) return -1;
      return new Date(a.invoice_date) - new Date(b.invoice_date);
    });
  }

  let rt = 0;
  const rows = allRows.map((row, idx) => {
    rt += Number(row.quantity ?? 0);
    return {
      index: idx + 1,
      type: row.type,
      source: row.source,
      invoice_date: row.invoice_date,
      quantity: Number(row.quantity ?? 0),
      unit_cost: row.unit_cost != null ? Number(row.unit_cost) : null,
      total_cost: row.total_cost != null ? Number(row.total_cost) : null,
      rt,
    };
  });

  const total_qty = wsRes.rows.reduce(
    (sum, r) => sum + Number(r.quantity ?? 0),
    0,
  );

  return {
    ndc: normalizedDigits,
    drug_name: summary?.drug_name ?? "",
    total_qty,
    total_billed: Number(summary?.total_billed ?? 0),
    package_size: summary?.package_size ?? null,
    audit: {
      wholesaler_start_date: audit?.wholesaler_start_date ?? null,
      wholesaler_end_date: audit?.wholesaler_end_date ?? null,
    },
    rows,
  };
};

export const getCommunityDataGlobal = async (
  ndc,
  {
    includeGroups = false,
    mode = "state",
    userId,
    bin,
    pcn,
    grp,
    range, // "last_90_days" | "this_year" | "all_time" | undefined
  } = {},
) => {
  const normalizedNdc = ndc.replace(/\D/g, "").padStart(11, "0");

  const groupFields = includeGroups
    ? `
      LTRIM(LPAD(TRIM(i.primary_bin), 6, '0'), '0') AS bin,
      TRIM(i.primary_pcn) AS pcn,
      COALESCE(NULLIF(TRIM(i.primary_group), ''), 'NO_GROUP') AS grp
    `
    : `
      LTRIM(LPAD(TRIM(i.primary_bin), 6, '0'), '0') AS bin,
      TRIM(i.primary_pcn) AS pcn
    `;

  const groupBy = includeGroups
    ? `LTRIM(LPAD(TRIM(i.primary_bin), 6, '0'), '0'), TRIM(i.primary_pcn), COALESCE(NULLIF(TRIM(i.primary_group), ''), 'NO_GROUP')`
    : `LTRIM(LPAD(TRIM(i.primary_bin), 6, '0'), '0'), TRIM(i.primary_pcn)`;

  let params = [normalizedNdc];
  let paramIndex = 2;
  let joins = "";

  // ✅ NDC filter always applied
  let filters = `
    WHERE RIGHT(
      LPAD(REGEXP_REPLACE(i.ndc, '[^0-9]', '', 'g'), 11, '0'),
      10
    ) = RIGHT($1, 10)
  `;

  // ✅ Range / timeline filter
  if (range === "last_90_days") {
    filters += ` AND i.date_filled >= CURRENT_DATE - INTERVAL '90 days'`;
  } else if (range === "this_year") {
    filters += ` AND EXTRACT(YEAR FROM i.date_filled) = EXTRACT(YEAR FROM CURRENT_DATE)`;
  }

  // ✅ Optional bin filter (from outside or from See Group click)
  if (bin) {
    filters += `
    AND LTRIM(LPAD(TRIM(i.primary_bin), 6, '0'), '0')
    = LTRIM($${paramIndex}, '0')
  `;
    params.push(bin.toString().trim());
    paramIndex++;
  }

  // ✅ Optional pcn filter
  if (pcn) {
    filters += ` AND TRIM(i.primary_pcn) = $${paramIndex}`;
    params.push(pcn.toString().trim());
    paramIndex++;
  }

  // ✅ Optional group filter
  if (grp !== undefined) {
    const normalizedGrp = grp && grp.trim() !== "" ? grp.trim() : "NO_GROUP";

    filters += ` AND COALESCE(NULLIF(TRIM(i.primary_group), ''), 'NO_GROUP') = $${paramIndex}`;
    params.push(normalizedGrp);
    paramIndex++;
  }

  // ✅ Always join audits for user_id access
  joins = ` INNER JOIN audits a ON a.id = i.audit_id `;

  // ✅ User filter only in opportunities mode
  if (mode === "opportunities" && userId) {
    filters += ` AND a.user_id = $${paramIndex}`;
    params.push(userId);
    paramIndex++;
  }

  const query = `
    SELECT
      ${groupFields},

      COUNT(DISTINCT (a.user_id,i.rx_number,i.date_filled)) AS estimated_rxs,

      ROUND(AVG(
        COALESCE(i.primary_paid, 0) + COALESCE(i.secondary_paid, 0)
      )::numeric, 2) AS avg_ins_paid,

      ROUND((
        SUM(COALESCE(i.primary_paid, 0) + COALESCE(i.secondary_paid, 0))
        / NULLIF(SUM(i.quantity), 0)
      )::numeric, 2) AS avg_ins_paid_per_unit

      ${
        includeGroups
          ? `, ARRAY_AGG(DISTINCT i.rx_number)
               FILTER (WHERE i.rx_number IS NOT NULL) AS rx_numbers`
          : ""
      }

    FROM inventory_rows i
    ${joins}
    ${filters}

    GROUP BY ${groupBy}
    ORDER BY estimated_rxs DESC
  `;

  const result = await pool.query(query, params);
  return result.rows;
};

export const getDrugLookup = async (auditId, ingredient) => {
  // Helper: the same regex is used in SELECT and GROUP BY. It strips a trailing
  // "(12345-1234-12)" NDC pattern from drug_name so that
  //   "ELIQUIS 5MG TAB (00003-0894-21)"
  //   "ELIQUIS 5MG TAB (00003-0894-70)"
  //   "ELIQUIS 5MG TAB (00003-3764-74)"
  // all roll up into a single "ELIQUIS 5MG TAB" parent row.
  const CLEAN_DRUG = `TRIM(REGEXP_REPLACE(drug_name, '\\s*\\(\\d{5}-\\d{4}-\\d{2}\\)\\s*$', ''))`;

  // Parent rows — grouped by cleaned drug_name (across all NDCs of that strength)
  const drugsRes = await pool.query(
    `
    SELECT
      ${CLEAN_DRUG}                                              AS drug_name,
      MAX(brand)                                                 AS brand,
      COUNT(*)                                                   AS rx_count,
      SUM(quantity)::numeric / NULLIF(COUNT(*), 0)               AS avg_qty_per_rx,
      SUM(COALESCE(primary_paid,0) + COALESCE(secondary_paid,0))
        / NULLIF(COUNT(*), 0)                                    AS avg_ins_paid_per_rx,
      SUM(COALESCE(primary_paid,0) + COALESCE(secondary_paid,0))
        / NULLIF(SUM(quantity), 0)                               AS avg_ins_paid_per_unit
    FROM inventory_rows
    WHERE audit_id = $1
      AND UPPER(SPLIT_PART(TRIM(drug_name), ' ', 1)) = UPPER($2)
    GROUP BY ${CLEAN_DRUG}
    ORDER BY rx_count DESC
    `,
    [auditId, ingredient],
  );

  // Child rows — grouped by cleaned drug_name + NDC
  const ndcRes = await pool.query(
    `
    SELECT
      ${CLEAN_DRUG}                                              AS drug_name,
      ndc,
      MAX(brand)                                                 AS brand,
      COUNT(*)                                                   AS rx_count,
      SUM(quantity)::numeric / NULLIF(COUNT(*), 0)               AS avg_qty_per_rx,
      SUM(COALESCE(primary_paid,0) + COALESCE(secondary_paid,0))
        / NULLIF(COUNT(*), 0)                                    AS avg_ins_paid_per_rx,
      SUM(COALESCE(primary_paid,0) + COALESCE(secondary_paid,0))
        / NULLIF(SUM(quantity), 0)                               AS avg_ins_paid_per_unit
    FROM inventory_rows
    WHERE audit_id = $1
      AND UPPER(SPLIT_PART(TRIM(drug_name), ' ', 1)) = UPPER($2)
    GROUP BY ${CLEAN_DRUG}, ndc
    ORDER BY ${CLEAN_DRUG}, rx_count DESC
    `,
    [auditId, ingredient],
  );

  // Nest NDCs under their parent (cleaned) drug_name
  const byDrug = new Map();
  for (const d of drugsRes.rows) byDrug.set(d.drug_name, { ...d, ndcs: [] });
  for (const n of ndcRes.rows) {
    if (byDrug.has(n.drug_name)) byDrug.get(n.drug_name).ndcs.push(n);
  }

  return {
    ingredient: ingredient.toUpperCase(),
    drugs: Array.from(byDrug.values()),
  };
};

export const searchDrugNames = async (query, limit = 10) => {
  const CLEAN_DRUG = `
  TRIM(
    REGEXP_REPLACE(
      REGEXP_REPLACE(drug_name, '\\s*\\(\\d{5}-\\d{4}-\\d{2}\\)\\s*$', ''),
      '[,|].*$',
      ''
    )
  )
  `;

  const result = await pool.query(
    `
    SELECT 
      ${CLEAN_DRUG} AS drug_name,
      COUNT(*) AS rx_count
    FROM inventory_rows
    WHERE drug_name ILIKE $1
      AND drug_name IS NOT NULL
      AND TRIM(drug_name) != ''
      AND drug_name NOT LIKE '%,%'
      AND drug_name NOT LIKE '%|%'
      AND LENGTH(drug_name) < 120
    GROUP BY ${CLEAN_DRUG}
    ORDER BY rx_count DESC
    LIMIT $2
    `,
    [`%${query}%`, limit],
  );

  return result.rows.map((r) => ({
    name: r.drug_name,
    rx_count: Number(r.rx_count),
  }));
};

// ── GLOBAL DRUG LOOKUP (across ALL audits, with optional BIN/PCN/GRP filters) ──

export const getDrugLookupGlobal = async (ingredient, filters = {}) => {
  const { bin, pcn, grp } = filters;
  const CLEAN_DRUG = `TRIM(REGEXP_REPLACE(drug_name, '\\s*\\(\\d{5}-\\d{4}-\\d{2}\\)\\s*$', ''))`;

  // Build WHERE clause dynamically
  const conditions = [`UPPER(SPLIT_PART(TRIM(drug_name), ' ', 1)) = UPPER($1)`];
  const params = [ingredient];
  let pIdx = 2;

  if (bin && String(bin).trim()) {
    // Strip leading zeros on both sides so user typing "4336" matches DB "004336"
    conditions.push(
      `LTRIM(UPPER(TRIM(COALESCE(primary_bin,''))),'0') = LTRIM(UPPER(TRIM($${pIdx})),'0')`,
    );
    params.push(String(bin).trim());
    pIdx++;
  }
  if (pcn && String(pcn).trim()) {
    conditions.push(
      `UPPER(TRIM(COALESCE(primary_pcn,''))) = UPPER(TRIM($${pIdx}))`,
    );
    params.push(String(pcn).trim());
    pIdx++;
  }
  if (grp && String(grp).trim()) {
    conditions.push(
      `UPPER(COALESCE(NULLIF(TRIM(primary_group), ''), 'NO_GROUP')) = UPPER(TRIM($${pIdx}))`,
    );
    params.push(String(grp).trim());
    pIdx++;
  }

  const whereClause = conditions.join(" AND ");

  // Parent rows — grouped by cleaned drug_name
  const drugsRes = await pool.query(
    `
    SELECT
      ${CLEAN_DRUG}                                              AS drug_name,
      MAX(brand)                                                 AS brand,
      COUNT(DISTINCT (a.user_id,rx_number,date_filled))                                AS rx_count,
      SUM(quantity)::numeric / NULLIF(COUNT(*), 0)               AS avg_qty_per_rx,
      SUM(COALESCE(primary_paid,0) + COALESCE(secondary_paid,0))
        / NULLIF(COUNT(*), 0)                                    AS avg_ins_paid_per_rx,
      SUM(COALESCE(primary_paid,0) + COALESCE(secondary_paid,0))
        / NULLIF(SUM(quantity), 0)                               AS avg_ins_paid_per_unit
    FROM inventory_rows
INNER JOIN audits a ON a.id = inventory_rows.audit_id
WHERE ${whereClause}
    GROUP BY ${CLEAN_DRUG}
    ORDER BY rx_count DESC
    `,
    params,
  );

  // Child rows — grouped by cleaned drug_name + NDC
  const ndcRes = await pool.query(
    `
    SELECT
      ${CLEAN_DRUG}                                              AS drug_name,
      RIGHT(LPAD(REGEXP_REPLACE(ndc, '[^0-9]', '', 'g'), 11, '0'), 10) AS ndc,
      MAX(brand)                                                 AS brand,
      COUNT(DISTINCT (a.user_id,rx_number,date_filled))                                                   AS rx_count,
      SUM(quantity)::numeric / NULLIF(COUNT(*), 0)               AS avg_qty_per_rx,
      SUM(COALESCE(primary_paid,0) + COALESCE(secondary_paid,0))
        / NULLIF(COUNT(*), 0)                                    AS avg_ins_paid_per_rx,
      SUM(COALESCE(primary_paid,0) + COALESCE(secondary_paid,0))
        / NULLIF(SUM(quantity), 0)                               AS avg_ins_paid_per_unit
    FROM inventory_rows
INNER JOIN audits a ON a.id = inventory_rows.audit_id
WHERE ${whereClause}
    GROUP BY ${CLEAN_DRUG}, RIGHT(LPAD(REGEXP_REPLACE(ndc, '[^0-9]', '', 'g'), 11, '0'), 10)
    ORDER BY ${CLEAN_DRUG}, rx_count DESC
    `,
    params,
  );

  const byDrug = new Map();
  for (const d of drugsRes.rows) byDrug.set(d.drug_name, { ...d, ndcs: [] });
  for (const n of ndcRes.rows) {
    if (byDrug.has(n.drug_name)) byDrug.get(n.drug_name).ndcs.push(n);
  }

  return {
    ingredient: ingredient.toUpperCase(),
    filters: { bin: bin || null, pcn: pcn || null, grp: grp || null },
    drugs: Array.from(byDrug.values()),
  };
};

// ── Log a submitted search (fire-and-forget, with quality filters) ──

export const logDrugSearch = async (query) => {
  try {
    const raw = String(query ?? "").trim();
    if (!raw) return;

    // Only keep the FIRST word (the ingredient) — drops "ELIQUIS 5MG TAB" → "ELIQUIS"
    const firstWord = raw.split(/\s+/)[0];

    // Reject garbage:
    //  - too short (< 3 chars)
    //  - contains digits or punctuation other than hyphen (rejects "E;i", "5mg")
    //  - starts with digit
    if (firstWord.length < 5) return;
    if (!/^[A-Za-z][A-Za-z-]+$/.test(firstWord)) return;

    // Normalize to uppercase so "Eliquis" and "eliquis" merge
    const normalized = firstWord.toUpperCase();

    await pool.query(`INSERT INTO drug_search_log (query) VALUES ($1)`, [
      normalized,
    ]);
  } catch (err) {
    console.warn("logDrugSearch failed:", err.message);
  }
};

// ── Landing page stats + trending (one call) ──
// ── Landing page stats + trending (one call) ──
export const getDrugLookupLanding = async () => {
  const CLEAN_DRUG = `TRIM(REGEXP_REPLACE(drug_name, '\\s*\\(\\d{5}-\\d{4}-\\d{2}\\)\\s*$', ''))`;

  // Run everything in parallel
  const [statsRes, trendingRes] = await Promise.all([
    pool.query(`
  SELECT
    (SELECT COUNT(DISTINCT ${CLEAN_DRUG}) FROM inventory_rows WHERE drug_name IS NOT NULL AND TRIM(drug_name) != '') AS drugs_indexed,
    (SELECT COUNT(DISTINCT ndc) FROM inventory_rows WHERE ndc IS NOT NULL AND TRIM(ndc) != '') AS ndc_codes,
    (SELECT COUNT(*) FROM inventory_rows) AS total_prescriptions,
    (SELECT COUNT(DISTINCT rx_number) FROM inventory_rows WHERE rx_number IS NOT NULL AND TRIM(rx_number) != '') AS unique_rx
`),
    pool.query(`
      SELECT query, COUNT(*) AS hits
      FROM drug_search_log
      WHERE searched_at >= NOW() - INTERVAL '30 days'
      GROUP BY LOWER(query), query
      ORDER BY hits DESC
      LIMIT 10
    `),
  ]);

  const stats = statsRes.rows[0] || {};

  return {
    stats: {
      drugs_indexed: Number(stats.drugs_indexed ?? 0),
      ndc_codes: Number(stats.ndc_codes ?? 0),
      total_prescriptions: Number(stats.total_prescriptions ?? 0),
      unique_rx: Number(stats.unique_rx ?? 0),
    },
    trending: trendingRes.rows.map((r) => ({
      query: r.query,
      hits: Number(r.hits),
    })),
  };
};

export const searchNdcSuggestions = async (query, limit = 8) => {
  const q = String(query ?? "").trim();
  if (q.length < 2) return [];

  const numericOnly = q.replace(/\D/g, "");
  const ndcPattern = numericOnly.length >= 3 ? `%${numericOnly}%` : null;

  try {
    const result = await pool.query(
      `
      SELECT
        ndc,
        MAX(drug_name)    AS drug_name,
        MAX(brand)        AS brand,
        MAX(package_size) AS package_size,
        COUNT(*)          AS rx_count
      FROM inventory_rows
      WHERE ndc IS NOT NULL
        AND TRIM(ndc) <> ''
        AND (
          drug_name ILIKE $1
          OR ($2::text IS NOT NULL AND REGEXP_REPLACE(ndc, '[^0-9]', '', 'g') ILIKE $2)
        )
      GROUP BY ndc
      ORDER BY rx_count DESC
      LIMIT $3
      `,
      [`%${q}%`, ndcPattern, limit],
    );

    return result.rows.map((r) => ({
      ndc: r.ndc,
      drug_name: r.drug_name,
      brand: r.brand || null,
      package_size: r.package_size || null,
      rx_count: Number(r.rx_count),
    }));
  } catch (err) {
    // Log only safe scalar fields — never `err` itself (pg attaches the socket)
    const msg = String(err?.message || "").slice(0, 300);
    const code = err?.code || "";
    console.error(
      "searchNdcSuggestions SQL error | code:",
      code,
      "| msg:",
      msg,
    );
    throw new Error(msg || "NDC suggestion query failed");
  }
};

import { pool } from "../config/db.js";
import fs from "fs";
import path from "path";
import { parse } from "csv-parse/sync";
import { normalizeInventoryCSV } from "../utils/inventoryNormalizer.js";

export const createAudit = async (name) => {
  const result = await pool.query(
    `
    INSERT INTO audits (name)
    VALUES ($1)
    RETURNING *
    `,
    [name],
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

function toDbHeaderMapping(frontMapping = {}) {
  const out = {};
  for (const [frontKey, selectedStandardHeader] of Object.entries(frontMapping)) {
    const dbKey = FRONT_TO_DB_KEY[frontKey];
    if (!dbKey) continue;
    out[dbKey] = selectedStandardHeader; // e.g. rx_number -> "rx_number"
  }
  return out;
}

const cleanNumber = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const s = String(v).trim();
  // remove $ , and other junk
  const n = Number(s.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : null;
};

const cleanInt = (v) => {
  const n = cleanNumber(v);
  return n === null ? null : Math.trunc(n);
};

const cleanDate = (v) => {
  if (!v) return null;
  const s = String(v).trim();

  // Allow ISO yyyy-mm-dd as-is
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  // Try mm/dd/yyyy -> yyyy-mm-dd
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const mm = String(m[1]).padStart(2, "0");
    const dd = String(m[2]).padStart(2, "0");
    const yy = m[3];
    return `${yy}-${mm}-${dd}`;
  }

  // If unknown format, return null to avoid Postgres crash
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

export const saveInventoryFile = async (auditId, filename, headerMapping) => {
  // ensure audit exists
  const auditCheck = await pool.query("SELECT id FROM audits WHERE id = $1", [
    auditId,
  ]);

  if (auditCheck.rows.length === 0) throw new Error("Audit not found");

  const result = await pool.query(
    `
    INSERT INTO audit_inventory_files (audit_id, file_name)
    VALUES ($1, $2)
    RETURNING *
    `,
    [auditId, filename],
  );

  // Auto-parse CSV and insert inventory rows
  const filePath = path.join(process.cwd(), "uploads/inventory", filename);
  // 1️⃣ Normalize file using frontend mapping
const dbHeaderMapping = toDbHeaderMapping(headerMapping);
// const normalizedPath = await normalizeInventoryCSV(filePath, dbHeaderMapping);
console.log("Normalizing file:", filePath);
console.log("Header mapping:", headerMapping);

let normalizedPath;

try {
  normalizedPath = await normalizeInventoryCSV(
    filePath,
    headerMapping
  );
  console.log("Normalized file created:", normalizedPath);
} catch (e) {
  console.error("NORMALIZATION FAILED:", e);
  throw e;
}

// 2️⃣ Read normalized file
const normalizedContent = fs.readFileSync(normalizedPath, "utf-8");

const records = parse(normalizedContent, {
  columns: true,
  skip_empty_lines: true,
  trim: true,
});

console.log("Records to insert:", records.length);
if (records.length > 0) {
  console.log("First record:", JSON.stringify(records[0]));
  await insertInventoryRows(auditId, records);
}

await pool.query(
  `UPDATE audits SET status = 'started' WHERE id = $1`,
  [auditId]
);
  return result.rows[0];
};

export const insertInventoryRows = async (auditId, rows) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    for (const r of rows) {
      await client.query(
        `INSERT INTO inventory_rows
        (audit_id, ndc, rx_number, status, date_filled, drug_name, quantity, package_size,
         primary_bin, primary_paid, secondary_bin, secondary_paid, brand)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
  auditId,
  r.ndc || null,
  r.rx_number || null,
  r.status || null,
  r.date_filled || null,
  r.drug_name || null,
  r.quantity ? parseInt(r.quantity) : null,
  r.package_size || null,
  r.primary_bin || null,
  r.primary_paid ? parseFloat(r.primary_paid) : null,
  r.secondary_bin || null,
  r.secondary_paid ? parseFloat(r.secondary_paid) : null,
  r.brand || null,
]
      );
    }

    await client.query("COMMIT");
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

  const existing = await pool.query(
    "SELECT id FROM audit_wholesaler_files WHERE audit_id = $1",
    [auditId],
  );

  if (existing.rows.length === 0) {
    const insert = await pool.query(
      `
      INSERT INTO audit_wholesaler_files (audit_id, wholesaler_files)
      VALUES ($1, $2)
      RETURNING *
      `,
      [auditId, JSON.stringify(filesArray)],
    );

    return insert.rows[0];
  }

  const update = await pool.query(
    `
    UPDATE audit_wholesaler_files
    SET wholesaler_files = $2,
        uploaded_at = NOW()
    WHERE audit_id = $1
    RETURNING *
    `,
    [auditId, JSON.stringify(filesArray)],
  );

  return update.rows[0];
};

// --- NEW ---

export const getAudits = async () => {
  const result = await pool.query(`
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
    ORDER BY a.created_at DESC
  `);

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
    [auditId]
  );

  const rows = result.rows;

  // 🔹 Define required columns for report UI
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

  // 🔹 Ensure missing columns are auto-added
  const normalized = rows.map((row) => {
    const normalizedRow = {};
    REQUIRED_COLUMNS.forEach((col) => {
      normalizedRow[col] = row[col] ?? null;
    });
    return normalizedRow;
  });

  return normalized;
};

// export const deleteAudit = async (auditId) => {
//   const result = await pool.query(
//     `DELETE FROM audits WHERE id = $1 RETURNING *`,
//     [auditId],
//   );
//   return result.rows[0] || null;
// };

//here it also deletes the physical files from uploads/inventory to prevent orphaned files and save disk space
export const deleteAudit = async (auditId) => {
  // 1) get filenames first
  const filesRes = await pool.query(
    `SELECT file_name FROM audit_inventory_files WHERE audit_id = $1`,
    [auditId]
  );

  // 2) delete audit (cascades rows/files table rows)
  const result = await pool.query(
    `DELETE FROM audits WHERE id = $1 RETURNING *`,
    [auditId]
  );

  // 3) delete physical files
  for (const row of filesRes.rows) {
    const filePath = path.join(process.cwd(), "uploads/inventory", row.file_name);
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (e) {
      console.warn("Failed to delete file:", filePath, e.message);
    }
  }

  return result.rows[0] || null;
};
import { parse } from "csv-parse/sync";
import fs from "fs";
import path from "path";
import { Resend } from "resend";
import { pool } from "../config/db.js";
import { readInventoryCSV } from "../utils/inventoryNormalizer.js";
import { parseAmount } from "../utils/number.js";
import { cleanDate, isBadDate, badDateMessage } from "../utils/dates.js";
import { UploadRefused } from "../utils/uploadRefused.js";

const resend = new Resend(process.env.RESEND_API_KEY);

const normalizeNDC = (ndc) => {
  if (!ndc) return null;
  const raw = String(ndc).trim();
  const parts = raw.split("-");

  if (parts.length === 3) {
    const [a, b, c] = parts.map((p) => p.replace(/\D/g, ""));
    let seg1 = a, seg2 = b, seg3 = c;
    if (a.length === 5 && b.length === 3 && c.length === 2) {
      seg2 = "0" + b; // 5-3-2 → 5-4-2
    } else if (a.length === 5 && b.length === 4 && c.length === 1) {
      seg3 = "0" + c; // 5-4-1 → 5-4-2
    } else if (a.length === 4 && b.length === 4 && c.length === 2) {
      seg1 = "0" + a; // 4-4-2 → 5-4-2
    }
    return `${seg1.padStart(5, "0")}-${seg2.padStart(4, "0")}-${seg3.padStart(2, "0")}`;
  }

  // No dashes — strip non-digits, pad to 11 from the front
  const digits = raw.replace(/\D/g, "").padStart(11, "0");
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
  secondaryInsurancePcn: "secondary_pcn",
  secondaryInsuranceGroup: "secondary_group",
  secondaryInsurancePaid: "secondary_paid",
  brand: "brand",
  patientCopay: "patient_copay",
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

// One shared number reader for uploaded files (see utils/number.js).
const cleanNumber = (v) => parseAmount(v);

// Deletes an upload from disk. Never throws: a file that cannot be removed
// must not turn a finished upload into an error.
const removeFileQuietly = (filePath) => {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (e) {
    console.warn("Failed to delete file:", filePath, e.message);
  }
};

const cleanInt = (v) => {
  const n = cleanNumber(v);
  return n === null ? null : Math.trunc(n);
};

// cleanDate / isBadDate: see ../utils/dates.js

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

  const uploadDir = path.join(process.cwd(), "uploads/inventory");
  const filePath = path.join(uploadDir, filename);

  // ── STEP 1: read and check the NEW file. Nothing is deleted yet. ──
  // The old rows and the old file used to be deleted before the new file
  // was read, so a file that failed left the report empty. Now a file that
  // cannot be read changes nothing: the report keeps its current data.
  let filteredRecords;
  let stats;
  try {
    const auditCheck = await pool.query(
      "SELECT id FROM audits WHERE id = $1",
      [auditId],
    );
    if (auditCheck.rows.length === 0) throw new Error("Audit not found");

    console.log("Reading file:", filePath);
    console.log("Exclusions:", { excludeTransferred, excludeUnbilled });

    const { rows: records, totalRows, skippedRows } = readInventoryCSV(
      filePath,
      headerMapping,
    );

    console.log(
      `Total rows parsed: ${records.length} (skipped ${skippedRows} of ${totalRows})`,
    );

    if (records.length === 0 && skippedRows > 0) {
      throw new UploadRefused(
        "No row in this file could be read: every row has a different number of columns than the header. Nothing was changed.",
      );
    }

    // ── ✅ Apply status filters ──
    filteredRecords = records.filter((r) => {
      const status = String(r.status || "")
        .trim()
        .toUpperCase();
      if (status === "F") return false; // always excluded (business rule)
      if (excludeTransferred && status === "T") return false;
      if (excludeUnbilled && status === "U") return false;
      return true;
    });

    const droppedCount = records.length - filteredRecords.length;
    console.log(
      `After exclusions: ${filteredRecords.length} rows (dropped ${droppedCount})`,
    );

    // A date that does not exist (month 13, 30 February) almost always
    // means a day/month/year file read as month/day/year. Saving it would
    // store wrong or empty dates without a word, so the file is refused
    // with the lines to look at.
    const badDates = filteredRecords
      .filter((r) => isBadDate(r.date_filled))
      .map((r) => ({ line: r._line, value: r.date_filled }));
    if (badDates.length > 0) {
      throw new UploadRefused(badDateMessage("This file", badDates));
    }

    stats = {
      total: totalRows, // data rows in the file
      skipped: skippedRows, // refused: wrong number of columns
      excluded: droppedCount, // left out by the status rules
      inserted: filteredRecords.length,
    };
  } catch (e) {
    console.error("INVENTORY FILE REFUSED:", e.message);
    removeFileQuietly(filePath); // the new upload is not kept
    throw e;
  }

  // ── STEP 2: swap old for new in ONE database step. ──
  // Either everything below is saved, or nothing is.
  const client = await pool.connect();
  let fileRecord;
  let oldFileNames = [];
  let notifyQueue = null;
  try {
    await client.query("BEGIN");

    // One upload at a time per report. A second upload sent at the same
    // moment waits here, then replaces the first, instead of both inserting
    // their rows (which doubled the data).
    await client.query(`SELECT id FROM audits WHERE id = $1 FOR UPDATE`, [
      auditId,
    ]);

    await client.query(
      `UPDATE audits SET exclude_transferred = $2, exclude_unbilled = $3 WHERE id = $1`,
      [auditId, excludeTransferred, excludeUnbilled],
    );

    // ✅ Clean old inventory data (replace behavior)
    await client.query(`DELETE FROM inventory_rows WHERE audit_id = $1`, [
      auditId,
    ]);
    const oldInvFiles = await client.query(
      `DELETE FROM audit_inventory_files WHERE audit_id = $1 RETURNING file_name`,
      [auditId],
    );
    oldFileNames = oldInvFiles.rows.map((row) => row.file_name);

    const result = await client.query(
      `
      INSERT INTO audit_inventory_files (audit_id, file_name, status_header)
      VALUES ($1, $2, $3)
      RETURNING *
      `,
      [auditId, filename, headerMapping?.status || null],
    );
    fileRecord = result.rows[0];

    if (filteredRecords.length > 0) {
      const inserted = await insertInventoryRows(
        auditId,
        filteredRecords,
        client,
      );
      notifyQueue = inserted.notifyQueue || null;
    }

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    removeFileQuietly(filePath); // the new upload is not kept
    throw e;
  } finally {
    client.release();
  }

  // ── STEP 3: the new data is saved. Now the old files can go. ──
  for (const oldName of oldFileNames) {
    if (oldName && oldName !== filename) {
      removeFileQuietly(path.join(uploadDir, oldName));
    }
  }
  if (notifyQueue) notifyQueue();

  await refreshAuditStatus(auditId);

  return { file: fileRecord, rows: stats };
};

export const insertInventoryRows = async (
  auditId,
  rows,
  existingClient = null,
) => {
  if (!rows.length) return { inserted: 0 };

  // With no client given, this function opens and commits its own
  // transaction. A caller that is already inside a transaction (the file
  // upload, which swaps old rows for new ones in one step) passes its client;
  // then nothing is committed here.
  const ownTransaction = !existingClient;
  const client = existingClient || (await pool.connect());
  const CHUNK_SIZE = 1000; // 1000 rows × 18 cols = 18,000 params — safe

  try {
    if (ownTransaction) await client.query("BEGIN");

    const uniqueNdcMap = new Map();
    for (const row of rows) {
      const ndc = row.ndc?.trim();
      if (!ndc) continue;
      if (!uniqueNdcMap.has(ndc)) {
        uniqueNdcMap.set(ndc, row.drug_name?.trim() || "Unknown Drug");
      }
    }

    if (uniqueNdcMap.size > 0) {
      await client.query(
        `
        INSERT INTO ndc_sheet (ndc, drug_name, status)
        SELECT u.ndc,
               u.drug_name,
               CASE WHEN EXISTS (
                 SELECT 1 FROM inventory_rows ir WHERE ir.ndc = u.ndc
               ) THEN 'reviewed' ELSE 'pending' END
        FROM UNNEST($1::text[], $2::text[]) AS u(ndc, drug_name)
        ON CONFLICT (ndc) DO NOTHING
        `,
        [[...uniqueNdcMap.keys()], [...uniqueNdcMap.values()]],
      );
    }

    for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
      const chunk = rows.slice(i, i + CHUNK_SIZE);
      const values = [];

      const placeholders = chunk.map((r, idx) => {
        const base = idx * 18;
        values.push(
          auditId,
          r.ndc || null,
          r.rx_number || null,
          r.status || null,
          // r.date_filled || null,
          cleanDate(r.date_filled),
          r.drug_name || null,
          // r.quantity ? parseInt(r.quantity) : null,
          // Numbers go through parseAmount: it reads "1,234.56", "$45.10"
          // and "(5)" correctly, and gives null (never NaN) for text.
          parseAmount(r.quantity),
          r.package_size || null,
          r.primary_bin || null,
          r.primary_pcn || null,
          r.primary_group || null,
          parseAmount(r.primary_paid),
          r.secondary_bin || null,
          r.secondary_pcn || null,
          r.secondary_group || null,
          parseAmount(r.secondary_paid),
          r.brand || null,
          parseAmount(r.patient_copay),
        );
        return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10},$${base + 11},$${base + 12},$${base + 13},$${base + 14},$${base + 15},$${base + 16},$${base + 17},$${base + 18})`;
      });

      await client.query(
        `INSERT INTO inventory_rows
         (audit_id, ndc, rx_number, status, date_filled, drug_name, quantity, package_size,
          primary_bin, primary_pcn, primary_group, primary_paid,
          secondary_bin, secondary_pcn, secondary_group, secondary_paid, brand, patient_copay)
         VALUES ${placeholders.join(",")}`,
        values,
      );

      console.log(
        `✅ Chunk ${Math.floor(i / CHUNK_SIZE) + 1}/${Math.ceil(rows.length / CHUNK_SIZE)} inserted`,
      );
    }

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

    // The summary email goes out only once the rows are really saved: after
    // the COMMIT below, or after the caller's own commit.
    const notifyQueue = () => {
      if (newQueueRows.length === 0) return;
      // 🔥 SEND ONE EMAIL (summary)
      resend.emails
        .send({
          from: process.env.EMAIL_FROM,
          to: "auditprorx@gmail.com",
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
    };

    if (!ownTransaction) {
      // The caller commits, then calls notifyQueue().
      return { inserted: rows.length, notifyQueue };
    }

    await client.query("COMMIT");
    notifyQueue();
    console.log(`✅ All ${rows.length} inventory rows inserted`);
    return { inserted: rows.length };
  } catch (err) {
    if (ownTransaction) await client.query("ROLLBACK");
    throw err;
  } finally {
    if (ownTransaction) client.release();
  }
};

export const saveWholesalerFiles = async (auditId, filesArray) => {
  const uploadDir = path.join(process.cwd(), "uploads/wholesalers");
  const newPaths = filesArray.map((f) => path.join(uploadDir, f.file_name));

  // ── STEP 1: read and check every NEW file. Nothing is deleted yet. ──
  // The old rows and the old file of a wholesaler used to be deleted before
  // the new file was read, so a file that failed left that wholesaler empty.
  // Now a file that cannot be read changes nothing.
  let prepared;
  try {
    const auditCheck = await pool.query(
      "SELECT id FROM audits WHERE id = $1",
      [auditId],
    );
    if (auditCheck.rows.length === 0) throw new Error("Audit not found");

    prepared = filesArray.map((fileObj) => {
      const filePath = path.join(uploadDir, fileObj.file_name);
      if (!fs.existsSync(filePath)) {
        console.warn("Wholesaler file not found:", filePath);
        return { fileObj, rows: [], skipped: 0 };
      }

      const content = fs.readFileSync(filePath, "utf-8");
      let records;
      try {
        records = parse(content, {
          // Excel's "CSV UTF-8" starts the file with a hidden mark. Without
          // bom:true that mark becomes part of the first column's name, the
          // column is never found, and every row loses its first value.
          bom: true,
          columns: true,
          skip_empty_lines: true,
          trim: true,
        });
      } catch (err) {
        throw new UploadRefused(
          `${fileObj.wholesaler_name}: the file could not be read as a CSV (${err.message}). Nothing was changed. Please fix the file and upload it again.`,
        );
      }

      const mapping = fileObj.headerMapping || {};
      console.log("WHOLESALER MAPPING:", JSON.stringify(mapping));
      console.log(
        "WHOLESALER COLUMNS:",
        records.length > 0 ? Object.keys(records[0]) : [],
      );

      // One array per row, in the column order of the INSERT below
      // (after audit_id and wholesaler_file_id).
      const rows = [];
      const badDates = [];
      let skipped = 0;

      records.forEach((row, index) => {
        const ndc = mapping.ndcNumber ? (row[mapping.ndcNumber] ?? null) : null;
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
            ? (cleanNumber(row[mapping.quantity]) ?? 0)
            : null;
        // Costs go through the shared number reader: "-250.00" and
        // "(250.00)" stay negative (credits and returns are not purchases),
        // and text such as "N/A" becomes empty instead of "not a number".
        const unitCost =
          mapping.unitPrice && row[mapping.unitPrice]
            ? parseAmount(row[mapping.unitPrice])
            : null;
        const totalCost =
          mapping.totalPrice && row[mapping.totalPrice]
            ? parseAmount(row[mapping.totalPrice])
            : null;

        // A row with neither an NDC nor a product name cannot be matched to
        // anything (blank or "total" lines of the export). It is left out
        // and counted.
        if (!ndc && !productName) {
          skipped += 1;
          return;
        }

        // index 0 is the first data row = line 2 of the file
        if (isBadDate(invoiceDate))
          badDates.push({ line: index + 2, value: invoiceDate });

        rows.push([
          ndc,
          productName,
          quantity,
          unitCost,
          totalCost,
          cleanDate(invoiceDate),
        ]);
      });

      if (badDates.length > 0) {
        throw new UploadRefused(
          badDateMessage(`The ${fileObj.wholesaler_name} file`, badDates),
        );
      }

      if (skipped > 0) {
        console.warn(
          `⚠️  ${skipped} rows without NDC and product name skipped for ${fileObj.wholesaler_name}`,
        );
      }

      return { fileObj, rows, skipped };
    });
  } catch (e) {
    console.error("WHOLESALER FILE REFUSED:", e.message);
    newPaths.forEach(removeFileQuietly); // the new uploads are not kept
    throw e;
  }

  // ── STEP 2: swap old for new in ONE database step. ──
  // Either every file of this upload is saved, or nothing is changed.
  //
  // Per-wholesaler replace: each wholesaler being uploaded clears ONLY its
  // own previous file/rows, leaving every other wholesaler on this audit
  // untouched. Two files for the SAME wholesaler in one upload are both
  // kept (the earlier data is cleared once, before the first of them), so
  // the first file is no longer lost.
  const CHUNK_SIZE = 1000;
  const client = await pool.connect();
  const results = [];
  const removedNames = []; // files whose record was deleted
  const clearedWholesalers = new Set(); // wholesalers already cleared in this upload

  try {
    await client.query("BEGIN");

    // One upload at a time per report. A second upload sent at the same
    // moment waits here, then replaces the first, instead of both inserting
    // their rows (which doubled the data).
    await client.query(`SELECT id FROM audits WHERE id = $1 FOR UPDATE`, [
      auditId,
    ]);

    for (const { fileObj, rows, skipped } of prepared) {
      if (!clearedWholesalers.has(fileObj.wholesaler_name)) {
        clearedWholesalers.add(fileObj.wholesaler_name);

        const existingFiles = await client.query(
          `SELECT id, file_name
             FROM wholesaler_files
            WHERE audit_id = $1
              AND wholesaler_name = $2`,
          [auditId, fileObj.wholesaler_name],
        );

        for (const oldFile of existingFiles.rows) {
          // 1) delete child rows for this specific file
          await client.query(
            `DELETE FROM wholesaler_rows WHERE wholesaler_file_id = $1`,
            [oldFile.id],
          );

          // 2) delete the file record
          await client.query(`DELETE FROM wholesaler_files WHERE id = $1`, [
            oldFile.id,
          ]);

          // 3) the physical file is removed after the commit (step 3)
          removedNames.push(oldFile.file_name);
        }
      }

      // ── Insert the new file record ──
      const fileInsert = await client.query(
        `INSERT INTO wholesaler_files (audit_id, wholesaler_name, file_name)
         VALUES ($1, $2, $3) RETURNING *`,
        [auditId, fileObj.wholesaler_name, fileObj.file_name],
      );

      const wholesalerFileId = fileInsert.rows[0].id;

      // ── BULK INSERT wholesaler rows in chunks ──
      for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
        const chunk = rows.slice(i, i + CHUNK_SIZE);
        const values = [];

        const placeholders = chunk.map((row, idx) => {
          const base = idx * 8;
          values.push(auditId, wholesalerFileId, ...row);
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
            rows.length / CHUNK_SIZE,
          )} inserted for ${fileObj.wholesaler_name}`,
        );
      }

      if (rows.length > 0) {
        console.log(
          `✅ All ${rows.length} wholesaler rows inserted for ${fileObj.wholesaler_name}`,
        );
      }

      // skippedRows: rows of the file left out (no NDC and no product name)
      results.push({ ...fileInsert.rows[0], skippedRows: skipped });
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    newPaths.forEach(removeFileQuietly); // the new uploads are not kept
    throw err;
  } finally {
    client.release();
  }

  // ── STEP 3: the new data is saved. Now the old files can go. ──
  const newNames = new Set(filesArray.map((f) => f.file_name));
  for (const oldName of removedNames) {
    if (oldName && !newNames.has(oldName)) {
      removeFileQuietly(path.join(uploadDir, oldName));
    }
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
    "patient_copay",
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

const BILLED_ONLY = (col = "status") =>
  `UPPER(TRIM(COALESCE(${col}, ''))) = 'B'`;

export const getCommunityDataGlobal = async (
  ndc,
  {
    includeGroups = false,
    mode = "state",
    userId,
    bin,
    pcn,
    grp,
    range, // "last_30_days" | "last_90_days" | "this_year" | "all_time" | undefined
  } = {},
) => {
  const normalizedNdc = ndc.replace(/\D/g, "").padStart(11, "0");

  const groupFields = includeGroups
    ? `
      LPAD(TRIM(i.primary_bin), 6, '0') AS bin,
      TRIM(i.primary_pcn) AS pcn,
      COALESCE(NULLIF(TRIM(i.primary_group), ''), 'NO_GROUP') AS grp
    `
    : `
      LPAD(TRIM(i.primary_bin), 6, '0') AS bin,
      TRIM(i.primary_pcn) AS pcn
    `;

  const groupBy = includeGroups
    ? `LPAD(TRIM(i.primary_bin), 6, '0'), TRIM(i.primary_pcn), COALESCE(NULLIF(TRIM(i.primary_group), ''), 'NO_GROUP')`
    : `LPAD(TRIM(i.primary_bin), 6, '0'), TRIM(i.primary_pcn)`;

  let params = [normalizedNdc];
  let paramIndex = 2;
  let joins = "";

  // ✅ NDC filter always applied
  let filters = `
    WHERE RIGHT(
      LPAD(REGEXP_REPLACE(i.ndc, '[^0-9]', '', 'g'), 11, '0'),
      10
    ) = RIGHT($1, 10)
    AND ${BILLED_ONLY("i.status")}
  `;

  // ✅ Range / timeline filter
  if (range === "last_30_days") {
    filters += ` AND i.date_filled >= CURRENT_DATE - INTERVAL '30 days'`;
  } else if (range === "last_90_days") {
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
  const ownClaimsOnly = mode === "opportunities" && Boolean(userId);
  if (ownClaimsOnly) {
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
        // Rx numbers leave the server only for the caller's own claims
        // (opportunities mode is filtered to that pharmacy above). In the
        // community modes the rows mix every pharmacy's claims.
        includeGroups && ownClaimsOnly
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
      AND ${BILLED_ONLY()}
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
      AND ${BILLED_ONLY()}
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
  const tokens = String(query ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) return [];

  const conditions = tokens.map((_, i) => `drug_name ILIKE $${i + 1}`);
  const params = tokens.map((t) => `%${t}%`);
  // Add exact-prefix param for relevance scoring (first token)
  params.push(`${tokens[0]}%`);
  params.push(limit);

  const exactPrefixIdx = tokens.length + 1;
  const limitIdx = tokens.length + 2;

  const result = await pool.query(
    `
    SELECT drug_name
    FROM ndc_sheet
    WHERE ${conditions.join(" AND ")}
      AND LENGTH(drug_name) <= 140
    GROUP BY drug_name
    ORDER BY
      CASE
        WHEN drug_name ILIKE $${exactPrefixIdx} THEN 0
        ELSE 1
      END,
      drug_name
    LIMIT $${limitIdx}
    `,
    params,
  );

  return result.rows.map((r) => ({
    name: r.drug_name,
    rx_count: 0, // kept in response shape for FE compatibility
  }));
};

export const getDrugLookupGlobal = async (ingredient, filters = {}) => {
  const { bin, pcn, grp, ndc } = filters;

  // Normalize an NDC to 10 digits (strip non-digits, left-pad to 11, take last 10)
  const NDC_NORM = (col) =>
    `RIGHT(LPAD(REGEXP_REPLACE(${col}, '[^0-9]', '', 'g'), 11, '0'), 10)`;

  const NDC_NAME_CTE = `
    WITH ndc_name AS (
      SELECT
        ${NDC_NORM("inventory_rows.ndc")} AS ndc_norm,
        COALESCE(MAX(ns.drug_name), MAX(inventory_rows.drug_name)) AS raw_name,
        MAX(ns.ndc) AS ns_ndc
      FROM inventory_rows
      LEFT JOIN ndc_sheet ns
        ON ${NDC_NORM("ns.ndc")} = ${NDC_NORM("inventory_rows.ndc")}
      WHERE inventory_rows.ndc IS NOT NULL
        AND TRIM(inventory_rows.ndc) <> ''
        AND ${BILLED_ONLY("inventory_rows.status")}
      GROUP BY ${NDC_NORM("inventory_rows.ndc")}
    )
  `;

  const CLEAN_DRUG = `TRIM(REGEXP_REPLACE(nn.raw_name, '\\s*\\(\\d{5}-\\d{4}-\\d{2}\\)\\s*$', ''))`;

  // Build WHERE clause dynamically
  const conditions = [];
  const params = [];
  let pIdx = 1;

  // ── Primary filter: NDC OR ingredient ──
  if (ndc && String(ndc).trim()) {
    const digits = String(ndc).replace(/\D/g, "");
    conditions.push(
      `${NDC_NORM("inventory_rows.ndc")} = RIGHT(LPAD($${pIdx}, 11, '0'), 10)`,
    );
    params.push(digits);
    pIdx++;
  } else if (ingredient && String(ingredient).trim()) {
    const ingTokens = String(ingredient).trim().split(/\s+/).filter(Boolean);
    for (const tok of ingTokens) {
      conditions.push(`nn.raw_name ILIKE $${pIdx}`);
      params.push(`%${tok}%`);
      pIdx++;
    }
  } else {
    // Neither provided — return empty shape
    return {
      ingredient: "",
      filters: { bin: null, pcn: null, grp: null, ndc: null },
      drugs: [],
    };
  }

  // Exclude corrupted rows where an entire CSV blob was imported into a single
  // drug_name cell (real drug names are short). Keeps junk out of results.
  conditions.push(`LENGTH(nn.raw_name) <= 140`);

  // Billed claims only (see BILLED_ONLY above).
  conditions.push(BILLED_ONLY("inventory_rows.status"));

  // ── Optional BIN/PCN/GRP filters ──
  if (bin && String(bin).trim()) {
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

  // Parent rows — grouped by canonical drug name
  const drugsRes = await pool.query(
    `
    ${NDC_NAME_CTE}
    SELECT
      ${CLEAN_DRUG}                                              AS drug_name,
      MAX(brand)                                                 AS brand,
      COUNT(DISTINCT (a.user_id,rx_number,date_filled))          AS rx_count,
      SUM(quantity)::numeric / NULLIF(COUNT(*), 0)               AS avg_qty_per_rx,
      SUM(COALESCE(primary_paid,0) + COALESCE(secondary_paid,0))
        / NULLIF(COUNT(*), 0)                                    AS avg_ins_paid_per_rx,
      SUM(COALESCE(primary_paid,0) + COALESCE(secondary_paid,0))
        / NULLIF(SUM(quantity), 0)                               AS avg_ins_paid_per_unit
    FROM inventory_rows
    INNER JOIN audits a ON a.id = inventory_rows.audit_id
    INNER JOIN ndc_name nn ON nn.ndc_norm = ${NDC_NORM("inventory_rows.ndc")}
    WHERE ${whereClause}
    GROUP BY ${CLEAN_DRUG}
    ORDER BY rx_count DESC
    `,
    params,
  );

  // Child rows — one per normalized NDC. NDC never appears twice.
  const ndcRes = await pool.query(
    `
    ${NDC_NAME_CTE}
    SELECT
      MAX(${CLEAN_DRUG})                                              AS drug_name,
      COALESCE(
        MAX(nn.ns_ndc),
        LPAD(REGEXP_REPLACE(MAX(inventory_rows.ndc), '[^0-9]', '', 'g'), 11, '0')
      )                                                               AS ndc,
      MAX(brand)                                                      AS brand,
      COUNT(DISTINCT (a.user_id,rx_number,date_filled))               AS rx_count,
      SUM(quantity)::numeric / NULLIF(COUNT(*), 0)                    AS avg_qty_per_rx,
      SUM(COALESCE(primary_paid,0) + COALESCE(secondary_paid,0))
        / NULLIF(COUNT(*), 0)                                         AS avg_ins_paid_per_rx,
      SUM(COALESCE(primary_paid,0) + COALESCE(secondary_paid,0))
        / NULLIF(SUM(quantity), 0)                                    AS avg_ins_paid_per_unit
    FROM inventory_rows
    INNER JOIN audits a ON a.id = inventory_rows.audit_id
    INNER JOIN ndc_name nn ON nn.ndc_norm = ${NDC_NORM("inventory_rows.ndc")}
    WHERE ${whereClause}
    GROUP BY ${NDC_NORM("inventory_rows.ndc")}
    ORDER BY drug_name, rx_count DESC
    `,
    params,
  );

  const byDrug = new Map();
  for (const d of drugsRes.rows) byDrug.set(d.drug_name, { ...d, ndcs: [] });
  for (const n of ndcRes.rows) {
    if (byDrug.has(n.drug_name)) byDrug.get(n.drug_name).ndcs.push(n);
  }

  // For the title on the results page, prefer the actual drug name when in NDC mode
  const displayHeader = ndc
    ? drugsRes.rows[0]?.drug_name || String(ndc)
    : String(ingredient || "").toUpperCase();

  return {
    ingredient: displayHeader,
    filters: {
      bin: bin || null,
      pcn: pcn || null,
      grp: grp || null,
      ndc: ndc || null,
    },
    drugs: Array.from(byDrug.values()),
  };
};

// export const getDrugLookupGlobal = async (ingredient, filters = {}) => {
//   const { bin, pcn, grp, ndc } = filters;

//   const CLEAN_DRUG = `TRIM(REGEXP_REPLACE(nn.raw_name, '\\s*\\(\\d{5}-\\d{4}-\\d{2}\\)\\s*$', ''))`;

//   const whereClause = conditions.join(" AND ");

// ── Log a submitted search (fire-and-forget, with quality filters) ──

export const logDrugSearch = async (query) => {
  try {
    const raw = String(query ?? "").trim();
    if (!raw) return;

    // Only keep the FIRST word (the ingredient) — drops "ELIQUIS 5MG TAB" → "ELIQUIS"
    const firstWord = raw.split(/\s+/)[0];

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
    (SELECT COUNT(DISTINCT ${CLEAN_DRUG}) FROM inventory_rows WHERE ${BILLED_ONLY()} AND drug_name IS NOT NULL AND TRIM(drug_name) != '') AS drugs_indexed,
    (SELECT COUNT(DISTINCT ndc) FROM inventory_rows WHERE ${BILLED_ONLY()} AND ndc IS NOT NULL AND TRIM(ndc) != '') AS ndc_codes,
    (SELECT COUNT(*) FROM inventory_rows WHERE ${BILLED_ONLY()}) AS total_prescriptions,
    (SELECT COUNT(DISTINCT rx_number) FROM inventory_rows WHERE ${BILLED_ONLY()} AND rx_number IS NOT NULL AND TRIM(rx_number) != '') AS unique_rx
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
        drug_name
      FROM ndc_sheet
      WHERE drug_name ILIKE $1
         OR ($2::text IS NOT NULL AND REGEXP_REPLACE(ndc, '[^0-9]', '', 'g') ILIKE $2)
      ORDER BY drug_name
      LIMIT $3
      `,
      [`%${q}%`, ndcPattern, limit],
    );

    return result.rows.map((r) => ({
      ndc: r.ndc,
      drug_name: r.drug_name,
      brand: null,
      package_size: null,
      rx_count: 0,
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

//   const numericOnly = q.replace(/\D/g, "");
//   const ndcPattern = numericOnly.length >= 3 ? `%${numericOnly}%` : null;

//   const CLEAN_DRUG = `TRIM(REGEXP_REPLACE(drug_name, '\\s*\\(\\d{5}-\\d{4}-\\d{2}\\)\\s*$', ''))`;

export const searchNdcAutocomplete = async (query, limit = 10) => {
  const numericOnly = String(query ?? "").replace(/\D/g, "");
  if (numericOnly.length < 2) return [];

  try {
    const result = await pool.query(
      `
      SELECT
        ndc,
        drug_name
      FROM ndc_sheet
      WHERE REGEXP_REPLACE(ndc, '[^0-9]', '', 'g') ILIKE $1 || '%'
      ORDER BY drug_name
      LIMIT $2
      `,
      [numericOnly, limit],
    );

    return result.rows.map((r) => ({
      name: r.drug_name,
      ndc: r.ndc,
      rx_count: 0,
    }));
  } catch (err) {
    const msg = String(err?.message || "").slice(0, 300);
    const code = err?.code || "";
    console.error(
      "searchNdcAutocomplete SQL error | code:",
      code,
      "| msg:",
      msg,
    );
    throw new Error(msg || "NDC autocomplete query failed");
  }
};

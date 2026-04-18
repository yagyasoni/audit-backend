import * as auditService from "../services/audit.service.js";
import { pool } from "../config/db.js";
// import { createAudit, updateAuditDates, saveInventoryFile, saveWholesalerFiles } from "../services/audit.service.js";
import jwt from "jsonwebtoken";

export const createAudit = async (req, res) => {
  try {
    const { name } = req.body;

    if (!name || name.trim() === "") {
      return res.status(400).json({
        error: "Report name is required",
      });
    }

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

    const audit = await auditService.createAudit(name, userId);

    res.status(201).json(audit);
  } catch (error) {
    if (
      error.name === "TokenExpiredError" ||
      error.name === "JsonWebTokenError"
    ) {
      return res.status(401).json({ message: "Token expired or invalid" });
    }
    console.error("Create Audit Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

export const getFullReport = async (req, res) => {
  try {
    const { id } = req.params;

    // DEBUG - check if rows exist at all
    const countCheck = await pool.query(
      `SELECT COUNT(*) FROM inventory_rows WHERE audit_id = $1`,
      [id],
    );
    console.log("ROW COUNT FOR AUDIT:", id, countCheck.rows[0]);

    const result = await pool.query(
      `
  SELECT
  i.ndc,
  MAX(REGEXP_REPLACE(i.drug_name, '\s*\(\d{5}-\d{4}-\d{2}\).*$', '')) AS drug_name,
  MAX(i.package_size) AS package_size,
  COALESCE(w.total_ordered, 0) AS total_ordered,
  SUM(i.quantity) AS total_billed,
  SUM(COALESCE(i.primary_paid, 0) + COALESCE(i.secondary_paid, 0)) AS total_amount,
  COALESCE(w.total_cost, 0) AS cost,
  COALESCE(w.total_ordered, 0) - SUM(i.quantity) AS total_shortage,

COALESCE(SUM(CASE WHEN LOWER(pbm.pbm_name) = 'horizon' AND LOWER(pbm.payer_type) = 'commercial' THEN i.quantity ELSE 0 END), 0) AS horizon,
  COALESCE(SUM(CASE WHEN LOWER(pbm.pbm_name) = 'express scripts' AND LOWER(pbm.payer_type) = 'commercial' THEN i.quantity ELSE 0 END), 0) AS express,
  COALESCE(SUM(CASE WHEN LOWER(pbm.pbm_name) = 'caremark' AND LOWER(pbm.payer_type) = 'commercial' THEN i.quantity ELSE 0 END), 0) AS cvs_caremark,
  COALESCE(SUM(CASE WHEN LOWER(pbm.pbm_name) IN ('optum','optumrx') AND LOWER(pbm.payer_type) = 'commercial' THEN i.quantity ELSE 0 END), 0) AS optumrx,
  COALESCE(SUM(CASE WHEN LOWER(pbm.pbm_name) = 'humana' AND LOWER(pbm.payer_type) = 'commercial' THEN i.quantity ELSE 0 END), 0) AS humana,
COALESCE(SUM(CASE WHEN LOWER(pbm.payer_type) = 'medicaid' THEN i.quantity ELSE 0 END), 0) AS nj_medicaid,
COALESCE(SUM(CASE WHEN LOWER(pbm.payer_type) = 'medicare' THEN i.quantity ELSE 0 END), 0) AS medicare,
COALESCE(SUM(CASE WHEN (LOWER(pbm.pbm_name) ILIKE '%southern scripts%' OR LOWER(pbm.pbm_name) ILIKE '%liviniti%') AND LOWER(pbm.payer_type) = 'commercial' THEN i.quantity ELSE 0 END), 0) AS ssc,
  COALESCE(SUM(CASE WHEN LOWER(pbm.pbm_name) IN ('medimpact') AND LOWER(pbm.payer_type) = 'commercial' THEN i.quantity ELSE 0 END), 0) AS pdmi,
COALESCE(SUM(CASE WHEN LOWER(pbm.payer_type) IN ('coupon','copay card') THEN i.quantity ELSE 0 END), 0) AS coupon,
COALESCE(SUM(CASE WHEN LOWER(pbm.payer_type) = 'government/military' THEN i.quantity ELSE 0 END), 0) AS gov_military

FROM inventory_rows i

-- ✅ SINGLE lateral with 3-level COALESCE fallback (fixes the 2x duplication)
LEFT JOIN LATERAL (
  SELECT ms.pbm_name, ms.payer_type
  FROM (
    SELECT pbm_name, payer_type, 1 AS priority FROM master_sheet m
     WHERE LTRIM(UPPER(TRIM(m.bin)),'0') = LTRIM(UPPER(TRIM(COALESCE(i.primary_bin,''))),'0')
       AND UPPER(TRIM(COALESCE(m.pcn,''))) = UPPER(TRIM(COALESCE(i.primary_pcn,'')))
       AND UPPER(TRIM(COALESCE(m.grp,''))) = UPPER(TRIM(COALESCE(i.primary_group,'')))
    UNION ALL
    SELECT pbm_name, payer_type, 2 FROM master_sheet m
     WHERE LTRIM(UPPER(TRIM(m.bin)),'0') = LTRIM(UPPER(TRIM(COALESCE(i.primary_bin,''))),'0')
       AND UPPER(TRIM(COALESCE(m.pcn,''))) = UPPER(TRIM(COALESCE(i.primary_pcn,'')))
    UNION ALL
    SELECT pbm_name, payer_type, 3 FROM master_sheet m
     WHERE LTRIM(UPPER(TRIM(m.bin)),'0') = LTRIM(UPPER(TRIM(COALESCE(i.primary_bin,''))),'0')
    ORDER BY priority LIMIT 1
  ) ms
) pbm ON true

LEFT JOIN (
  SELECT
    LPAD(REGEXP_REPLACE(ndc, '[^0-9]', '', 'g'), 11, '0') AS ndc_normalized,
    SUM(quantity) AS total_ordered,
    SUM(COALESCE(total_cost, 0)) AS total_cost
  FROM wholesaler_rows
  WHERE audit_id = $1
  GROUP BY LPAD(REGEXP_REPLACE(ndc, '[^0-9]', '', 'g'), 11, '0')
) w ON LPAD(REGEXP_REPLACE(w.ndc_normalized, '[^0-9]', '', 'g'), 11, '0')
     = LPAD(REGEXP_REPLACE(i.ndc, '[^0-9]', '', 'g'), 11, '0')

WHERE i.audit_id = $1
GROUP BY i.ndc, w.total_ordered, w.total_cost, w.ndc_normalized
ORDER BY SUM(i.quantity) DESC
  `,
      [id],
    );

    console.log("REPORT ROWS:", result.rows.length);
    return res.json(result.rows);
  } catch (error) {
    console.error("Report aggregation error:", error);
    return res.status(500).json({ message: error.message });
  }
};

export const updateAuditDates = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      inventory_start_date,
      inventory_end_date,
      wholesaler_start_date,
      wholesaler_end_date,
    } = req.body;

    // Basic validation
    if (!inventory_start_date || !inventory_end_date) {
      return res.status(400).json({
        error: "Inventory start and end dates are required",
      });
    }

    const updatedAudit = await auditService.updateAuditDates(id, {
      inventory_start_date,
      inventory_end_date,
      wholesaler_start_date,
      wholesaler_end_date,
    });

    if (!updatedAudit) {
      return res.status(404).json({
        error: "Audit not found",
      });
    }

    res.json(updatedAudit);
  } catch (error) {
    console.error("Update Dates Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

export const uploadInventoryFile = async (req, res) => {
  try {
    const { id } = req.params;
    const file = req.files?.file?.[0];

    const headerMapping = req.body.headerMapping
      ? JSON.parse(req.body.headerMapping)
      : {};

    if (!file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const saved = await auditService.saveInventoryFile(
      id,
      file.filename,
      headerMapping,
    );

    return res.status(200).json({
      message: "Inventory file uploaded successfully",
      file: saved,
      headerMapping,
    });
  } catch (err) {
    console.error("Upload error:", err);
    console.error("UPLOAD INVENTORY ERROR:", err);

    return res.status(500).json({
      error: err.message,
      stack: err.stack,
      details: err?.cause || null,
    });
  }
};

export const createInventoryRows = async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = req.body;

    if (!rows || !Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: "rows array required" });
    }

    const result = await auditService.insertInventoryRows(id, rows);

    res.status(201).json({
      message: "Inventory rows inserted successfully",
      ...result,
    });
  } catch (err) {
    console.error("Insert Inventory Rows Error:", err);
    res.status(500).json({ error: "Failed to insert inventory rows" });
  }
};

export const uploadWholesalerFiles = async (req, res) => {
  try {
    const { id } = req.params;

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "No files uploaded" });
    }

    if (!req.body.metadata) {
      return res.status(400).json({ error: "metadata required" });
    }

    const metadata = JSON.parse(req.body.metadata);

    const filesArray = req.files
      .map((file) => {
        const meta = metadata.find((m) => m.field === file.fieldname);
        if (!meta) return null;
        return {
          wholesaler_name: meta.wholesaler_name,
          file_name: file.filename,
          headerMapping: meta.headerMapping || {}, // 👈 pass mapping through
        };
      })
      .filter(Boolean);

    const saved = await auditService.saveWholesalerFiles(id, filesArray);

    res.status(200).json({
      message: "Wholesaler files uploaded",
      data: saved,
    });
  } catch (err) {
    console.error("Wholesaler Upload Error:", err);
    res.status(500).json({ error: err.message });
  }
};

// --- NEW ---

export const getAudits = async (req, res) => {
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

    const audits = await auditService.getAudits(userId);
    res.json(audits);
  } catch (error) {
    if (
      error.name === "TokenExpiredError" ||
      error.name === "JsonWebTokenError"
    ) {
      return res.status(401).json({ message: "Token expired or invalid" });
    }
    console.error("Get Audits Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

export const getAuditById = async (req, res) => {
  try {
    const { id } = req.params;
    const audit = await auditService.getAuditById(id);

    if (!audit) {
      return res.status(404).json({ error: "Audit not found" });
    }

    res.json(audit);
  } catch (error) {
    console.error("Get Audit By Id Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

export const getInventoryRows = async (req, res) => {
  try {
    const { id } = req.params;
    const rows = await auditService.getInventoryRows(id);
    res.json(rows);
  } catch (error) {
    console.error("Get Inventory Rows Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

export const deleteAudit = async (req, res) => {
  try {
    const { id } = req.params;
    const deleted = await auditService.deleteAudit(id);

    if (!deleted) {
      return res.status(404).json({ error: "Audit not found" });
    }

    res.json({ message: "Audit deleted successfully", audit: deleted });
  } catch (error) {
    console.error("Delete Audit Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

export const getInventoryFiles = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT id, file_name FROM audit_inventory_files WHERE audit_id = $1 ORDER BY id DESC`,
      [id],
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Get inventory files error:", err);
    res.status(500).json({ error: err.message });
  }
};

export const getWholesalerFiles = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT id, wholesaler_name, file_name FROM wholesaler_files WHERE audit_id = $1 ORDER BY id DESC`,
      [id],
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Get wholesaler files error:", err);
    res.status(500).json({ error: err.message });
  }
};

export const getInventoryDetail = async (req, res) => {
  try {
    const { id, ndc } = req.params;

    const result = await pool.query(
      `SELECT
        i.rx_number,
        TO_CHAR(i.date_filled, 'YYYY-MM-DD') AS date_filled,
        i.quantity,
        'PRIMERX' AS type,
        i.primary_bin AS pri_bin,
        i.primary_pcn AS pri_pcn,
        i.primary_group AS pri_group,
        COALESCE(pbm.pbm_name, '') AS pri_insurance,
        COALESCE(i.primary_paid, 0) AS pri_paid,
        COALESCE(i.secondary_bin, '') AS sec_bin,
        COALESCE(i.secondary_paid, 0) AS sec_paid
      FROM inventory_rows i
      LEFT JOIN LATERAL (
        SELECT COALESCE(
          (SELECT STRING_AGG(DISTINCT pbm_name, ', ') FROM master_sheet m
           WHERE UPPER(TRIM(m.bin)) = UPPER(TRIM(COALESCE(i.primary_bin,'')))
             AND UPPER(TRIM(COALESCE(m.pcn,''))) = UPPER(TRIM(COALESCE(i.primary_pcn,'')))
             AND UPPER(TRIM(COALESCE(m.grp,''))) = UPPER(TRIM(COALESCE(i.primary_group,'')))),
          (SELECT STRING_AGG(DISTINCT pbm_name, ', ') FROM master_sheet m
           WHERE UPPER(TRIM(m.bin)) = UPPER(TRIM(COALESCE(i.primary_bin,'')))
             AND UPPER(TRIM(COALESCE(m.pcn,''))) = UPPER(TRIM(COALESCE(i.primary_pcn,'')))),
          (SELECT STRING_AGG(DISTINCT pbm_name, ', ') FROM master_sheet m
           WHERE UPPER(TRIM(m.bin)) = UPPER(TRIM(COALESCE(i.primary_bin,''))))
        ) AS pbm_name
      ) pbm ON true
      WHERE i.audit_id = $1
        AND LPAD(REGEXP_REPLACE(i.ndc, '[^0-9]', '', 'g'), 11, '0') = LPAD(REGEXP_REPLACE($2, '[^0-9]', '', 'g'), 11, '0')
      ORDER BY i.date_filled ASC`,
      [id, ndc],
    );

    return res.json(result.rows);
  } catch (error) {
    console.error("Inventory detail error:", error);
    return res.status(500).json({ message: error.message });
  }
};

// export const getWholesalerDetail = async (req, res) => {
//   try {
//     const { id, ndc } = req.params;

//     const result = await pool.query(
//       `SELECT w.*, wf.wholesaler_name
//       FROM wholesaler_rows w
//       LEFT JOIN wholesaler_files wf ON w.wholesaler_file_id = wf.id
//       WHERE w.audit_id = $1
//         AND LPAD(REGEXP_REPLACE(w.ndc, '[^0-9]', '', 'g'), 11, '0') = LPAD(REGEXP_REPLACE($2, '[^0-9]', '', 'g'), 11, '0')
//       ORDER BY w.id ASC`,
//       [id, ndc],
//     );

//     // Map to consistent field names
//     const rows = result.rows.map((r) => ({
//       type: r.wholesaler_name || r.type || "MCKESSON",
//       date_ordered: r.invoice_date
//         ? new Date(r.invoice_date).toLocaleDateString("en-US", {
//             month: "2-digit",
//             day: "2-digit",
//             year: "numeric",
//           })
//         : "",
//       quantity: r.quantity || 0,
//     }));

//     return res.json(rows);
//   } catch (error) {
//     console.error("Wholesaler detail error:", error);
//     return res.status(500).json({ message: error.message });
//   }
// };

export const getWholesalerDetail = async (req, res) => {
  try {
    const { id, ndc } = req.params;

    const result = await pool.query(
      `SELECT
         w.id,
         wf.wholesaler_name,
         TO_CHAR(w.invoice_date, 'YYYY-MM-DD') AS invoice_date,
         w.quantity
       FROM wholesaler_rows w
       LEFT JOIN wholesaler_files wf ON w.wholesaler_file_id = wf.id
       WHERE w.audit_id = $1
         AND LPAD(REGEXP_REPLACE(w.ndc, '[^0-9]', '', 'g'), 11, '0') = LPAD(REGEXP_REPLACE($2, '[^0-9]', '', 'g'), 11, '0')
       ORDER BY w.invoice_date ASC NULLS LAST, w.id ASC`,
      [id, ndc],
    );

    console.log("🔍 getWholesalerDetail sample row:", result.rows[0]);

    const rows = result.rows.map((r) => ({
      type: r.wholesaler_name || "MCKESSON",
      date_ordered: r.invoice_date || "",   // YYYY-MM-DD string
      quantity: Number(r.quantity ?? 0),
    }));

    return res.json(rows);
  } catch (error) {
    console.error("Wholesaler detail error:", error);
    return res.status(500).json({ message: error.message });
  }
};

export const getDrugWholesalerDetail = async (req, res) => {
  try {
    const { id, ndc } = req.params;
    const decodedNdc = decodeURIComponent(ndc);
    const { outside_range = "false", include_billed = "false" } = req.query;

    const result = await auditService.getDrugWholesalerDetail(id, decodedNdc, {
      outsideRange: outside_range === "true",
      includeBilled: include_billed === "true",
    });

    return res.json(result);
  } catch (error) {
    console.error("getDrugWholesalerDetail error:", error);
    return res.status(500).json({ message: error.message });
  }
};

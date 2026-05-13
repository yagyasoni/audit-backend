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

    const countCheck = await pool.query(
      `SELECT COUNT(*) FROM inventory_rows WHERE audit_id = $1`,
      [id],
    );
    console.log("ROW COUNT FOR AUDIT:", id, countCheck.rows[0]);

    const result = await pool.query(
      `
      WITH a AS (
        SELECT
          inventory_start_date,
          inventory_end_date,
          wholesaler_start_date,
          wholesaler_end_date
        FROM audits
        WHERE id = $1
      ),
      ws AS (
        SELECT
          LPAD(REGEXP_REPLACE(wr.ndc, '[^0-9]', '', 'g'), 11, '0') AS ndc_normalized,
          SUM(wr.quantity) AS total_ordered,
          SUM(COALESCE(wr.total_cost, 0)) AS total_cost
        FROM wholesaler_rows wr
        CROSS JOIN a
        WHERE wr.audit_id = $1
          AND (
            wr.invoice_date IS NULL
            OR (a.wholesaler_start_date IS NULL AND a.wholesaler_end_date IS NULL)
            OR wr.invoice_date BETWEEN a.wholesaler_start_date AND a.wholesaler_end_date
          )
        GROUP BY LPAD(REGEXP_REPLACE(wr.ndc, '[^0-9]', '', 'g'), 11, '0')
      )
      SELECT
        i.ndc,
        MAX(REGEXP_REPLACE(i.drug_name, '\\s*\\(\\d{5}-\\d{4}-\\d{2}\\).*$', '')) AS drug_name,
        MAX(i.brand) AS brand,
        MAX(i.package_size) AS package_size,
        COALESCE(MAX(ws.total_ordered), 0) AS total_ordered,
 
        SUM(CASE WHEN i.date_filled IS NULL
                  OR (a.inventory_start_date IS NULL AND a.inventory_end_date IS NULL)
                  OR i.date_filled BETWEEN a.inventory_start_date AND a.inventory_end_date
                 THEN i.quantity ELSE 0 END) AS total_billed,
 
        SUM(CASE WHEN i.date_filled IS NULL
                  OR (a.inventory_start_date IS NULL AND a.inventory_end_date IS NULL)
                  OR i.date_filled BETWEEN a.inventory_start_date AND a.inventory_end_date
                 THEN COALESCE(i.primary_paid, 0) + COALESCE(i.secondary_paid, 0)
                 ELSE 0 END) AS total_amount,
 
        COALESCE(MAX(ws.total_cost), 0) AS cost,
 
        COALESCE(MAX(ws.total_ordered), 0) - SUM(
          CASE WHEN i.date_filled IS NULL
                OR (a.inventory_start_date IS NULL AND a.inventory_end_date IS NULL)
                OR i.date_filled BETWEEN a.inventory_start_date AND a.inventory_end_date
               THEN i.quantity ELSE 0 END
        ) AS total_shortage,
 
        COALESCE(SUM(CASE WHEN (i.date_filled IS NULL
                                 OR (a.inventory_start_date IS NULL AND a.inventory_end_date IS NULL)
                                 OR i.date_filled BETWEEN a.inventory_start_date AND a.inventory_end_date)
                            AND LOWER(pbm.pbm_name) = 'horizon'
                            AND LOWER(pbm.payer_type) = 'commercial'
                          THEN i.quantity ELSE 0 END), 0) AS horizon,
 
        COALESCE(SUM(CASE WHEN (i.date_filled IS NULL
                                 OR (a.inventory_start_date IS NULL AND a.inventory_end_date IS NULL)
                                 OR i.date_filled BETWEEN a.inventory_start_date AND a.inventory_end_date)
                            AND LOWER(pbm.pbm_name) = 'express scripts'
                            AND LOWER(pbm.payer_type) = 'commercial'
                          THEN i.quantity ELSE 0 END), 0) AS express,
 
        COALESCE(SUM(CASE WHEN (i.date_filled IS NULL
                                 OR (a.inventory_start_date IS NULL AND a.inventory_end_date IS NULL)
                                 OR i.date_filled BETWEEN a.inventory_start_date AND a.inventory_end_date)
                            AND LOWER(pbm.pbm_name) = 'caremark'
                            AND LOWER(pbm.payer_type) = 'commercial'
                          THEN i.quantity ELSE 0 END), 0) AS cvs_caremark,
 
        COALESCE(SUM(CASE WHEN (i.date_filled IS NULL
                                 OR (a.inventory_start_date IS NULL AND a.inventory_end_date IS NULL)
                                 OR i.date_filled BETWEEN a.inventory_start_date AND a.inventory_end_date)
                            AND LOWER(pbm.pbm_name) IN ('optum','optumrx')
                            AND LOWER(pbm.payer_type) = 'commercial'
                          THEN i.quantity ELSE 0 END), 0) AS optumrx,
 
        COALESCE(SUM(CASE WHEN (i.date_filled IS NULL
                                 OR (a.inventory_start_date IS NULL AND a.inventory_end_date IS NULL)
                                 OR i.date_filled BETWEEN a.inventory_start_date AND a.inventory_end_date)
                            AND LOWER(pbm.pbm_name) = 'humana'
                            AND LOWER(pbm.payer_type) = 'commercial'
                          THEN i.quantity ELSE 0 END), 0) AS humana,
 
        COALESCE(SUM(CASE WHEN (i.date_filled IS NULL
                                 OR (a.inventory_start_date IS NULL AND a.inventory_end_date IS NULL)
                                 OR i.date_filled BETWEEN a.inventory_start_date AND a.inventory_end_date)
                            AND LOWER(pbm.payer_type) = 'medicaid'
                          THEN i.quantity ELSE 0 END), 0) AS nj_medicaid,
 
        COALESCE(SUM(CASE WHEN (i.date_filled IS NULL
                                 OR (a.inventory_start_date IS NULL AND a.inventory_end_date IS NULL)
                                 OR i.date_filled BETWEEN a.inventory_start_date AND a.inventory_end_date)
                            AND LOWER(pbm.payer_type) = 'medicare'
                          THEN i.quantity ELSE 0 END), 0) AS medicare,
 
        COALESCE(SUM(CASE WHEN (i.date_filled IS NULL
                                 OR (a.inventory_start_date IS NULL AND a.inventory_end_date IS NULL)
                                 OR i.date_filled BETWEEN a.inventory_start_date AND a.inventory_end_date)
                            AND (LOWER(pbm.pbm_name) ILIKE '%southern scripts%'
                              OR LOWER(pbm.pbm_name) ILIKE '%liviniti%')
                            AND LOWER(pbm.payer_type) = 'commercial'
                          THEN i.quantity ELSE 0 END), 0) AS ssc,
 
        COALESCE(SUM(CASE WHEN (i.date_filled IS NULL
                                 OR (a.inventory_start_date IS NULL AND a.inventory_end_date IS NULL)
                                 OR i.date_filled BETWEEN a.inventory_start_date AND a.inventory_end_date)
                            AND LOWER(pbm.pbm_name) IN ('medimpact')
                            AND LOWER(pbm.payer_type) = 'commercial'
                          THEN i.quantity ELSE 0 END), 0) AS pdmi,
 
        COALESCE(SUM(CASE WHEN (i.date_filled IS NULL
                                 OR (a.inventory_start_date IS NULL AND a.inventory_end_date IS NULL)
                                 OR i.date_filled BETWEEN a.inventory_start_date AND a.inventory_end_date)
                            AND LOWER(pbm.payer_type) IN ('coupon','copay card')
                          THEN i.quantity ELSE 0 END), 0) AS coupon,
 
        COALESCE(SUM(CASE WHEN (i.date_filled IS NULL
                                 OR (a.inventory_start_date IS NULL AND a.inventory_end_date IS NULL)
                                 OR i.date_filled BETWEEN a.inventory_start_date AND a.inventory_end_date)
                            AND LOWER(pbm.payer_type) = 'government/military'
                          THEN i.quantity ELSE 0 END), 0) AS gov_military
 
      FROM inventory_rows i
      CROSS JOIN a
 
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
 
      LEFT JOIN ws ON ws.ndc_normalized
                    = LPAD(REGEXP_REPLACE(i.ndc, '[^0-9]', '', 'g'), 11, '0')
 
      WHERE i.audit_id = $1
 
      GROUP BY i.ndc
 
      -- ✅ SCENE 2 — NO HAVING clause, every drug stays in the result
 
      ORDER BY total_billed DESC
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

    const excludeTransferred = req.body.excludeTransferred === "true";
    const excludeUnbilled = req.body.excludeUnbilled === "true";

    if (!file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const saved = await auditService.saveInventoryFile(
      id,
      file.filename,
      headerMapping,
      { excludeTransferred, excludeUnbilled },
    );

    return res.status(200).json({
      message: "Inventory file uploaded successfully",
      file: saved,
      headerMapping,
      excluded: { excludeTransferred, excludeUnbilled },
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
      `WITH a AS (
         SELECT inventory_start_date, inventory_end_date
         FROM audits WHERE id = $1
       )
       SELECT
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
         COALESCE(i.secondary_paid, 0) AS sec_paid,
         CASE
           WHEN i.date_filled IS NULL THEN false
           WHEN (a.inventory_start_date IS NULL AND a.inventory_end_date IS NULL) THEN false
           WHEN i.date_filled BETWEEN a.inventory_start_date AND a.inventory_end_date THEN false
           ELSE true
         END AS is_outside_date_range
       FROM inventory_rows i
       CROSS JOIN a
       LEFT JOIN LATERAL (
         SELECT COALESCE(
           (SELECT STRING_AGG(DISTINCT pbm_name, ', ') FROM master_sheet m
            WHERE LTRIM(UPPER(TRIM(m.bin)),'0') = LTRIM(UPPER(TRIM(COALESCE(i.primary_bin,''))),'0')
              AND UPPER(TRIM(COALESCE(m.pcn,''))) = UPPER(TRIM(COALESCE(i.primary_pcn,'')))
              AND UPPER(TRIM(COALESCE(m.grp,''))) = UPPER(TRIM(COALESCE(i.primary_group,'')))),
           (SELECT STRING_AGG(DISTINCT pbm_name, ', ') FROM master_sheet m
            WHERE LTRIM(UPPER(TRIM(m.bin)),'0') = LTRIM(UPPER(TRIM(COALESCE(i.primary_bin,''))),'0')
              AND UPPER(TRIM(COALESCE(m.pcn,''))) = UPPER(TRIM(COALESCE(i.primary_pcn,'')))),
           (SELECT STRING_AGG(DISTINCT pbm_name, ', ') FROM master_sheet m
            WHERE LTRIM(UPPER(TRIM(m.bin)),'0') = LTRIM(UPPER(TRIM(COALESCE(i.primary_bin,''))),'0'))
         ) AS pbm_name
       ) pbm ON true
       WHERE i.audit_id = $1
         AND LPAD(REGEXP_REPLACE(i.ndc, '[^0-9]', '', 'g'), 11, '0')
           = LPAD(REGEXP_REPLACE($2, '[^0-9]', '', 'g'), 11, '0')
       ORDER BY i.date_filled ASC NULLS LAST`,
      [id, ndc],
    );

    return res.json(result.rows);
  } catch (error) {
    console.error("Inventory detail error:", error);
    return res.status(500).json({ message: error.message });
  }
};

export const getWholesalerDetail = async (req, res) => {
  try {
    const { id, ndc } = req.params;

    const result = await pool.query(
      `WITH a AS (
         SELECT wholesaler_start_date, wholesaler_end_date
         FROM audits WHERE id = $1
       )
       SELECT
         w.id,
         wf.wholesaler_name,
         TO_CHAR(w.invoice_date, 'YYYY-MM-DD') AS invoice_date,
         w.quantity,
         CASE
           WHEN w.invoice_date IS NULL THEN false
           WHEN (a.wholesaler_start_date IS NULL AND a.wholesaler_end_date IS NULL) THEN false
           WHEN w.invoice_date BETWEEN a.wholesaler_start_date AND a.wholesaler_end_date THEN false
           ELSE true
         END AS is_outside_date_range
       FROM wholesaler_rows w
       CROSS JOIN a
       LEFT JOIN wholesaler_files wf ON w.wholesaler_file_id = wf.id
       WHERE w.audit_id = $1
         AND LPAD(REGEXP_REPLACE(w.ndc, '[^0-9]', '', 'g'), 11, '0')
           = LPAD(REGEXP_REPLACE($2, '[^0-9]', '', 'g'), 11, '0')
       ORDER BY w.invoice_date ASC NULLS LAST, w.id ASC`,
      [id, ndc],
    );

    const rows = result.rows.map((r) => ({
      type: r.wholesaler_name || "MCKESSON",
      date_ordered: r.invoice_date || "",
      quantity: Number(r.quantity ?? 0),
      is_outside_date_range: !!r.is_outside_date_range,
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

export const getCommunityData = async (req, res) => {
  try {
    const { ndc } = req.params;

    const {
      includeGroups = "false",
      mode = "state",
      userId,
      bin,
      pcn,
      grp,
      range,
    } = req.query;

    const result = await auditService.getCommunityDataGlobal(ndc, {
      includeGroups: includeGroups === "true",
      mode,
      userId,
      bin,
      pcn,
      grp,
      range,
    });

    return res.json(result);
  } catch (error) {
    console.error("Community data error:", error);
    return res.status(500).json({ message: error.message });
  }
};

// export const getCommunityData1 = async (req, res) => {
//   try {
//     const { ndc } = req.params;

//     const {
//       includeGroups = "false",
//       startDate,
//       endDate,
//       range,
//       mode = "state",
//       userId,
//       bin,
//       pcn,
//       grp,
//     } = req.query;

//     let finalStartDate = startDate;
//     let finalEndDate = endDate;

//     // ✅ RANGE LOGIC
//     if (range) {
//       const now = new Date();

//       if (range === "last_90_days") {
//         const past = new Date();
//         past.setDate(now.getDate() - 90);
//         finalStartDate = past.toISOString().split("T")[0];
//         finalEndDate = now.toISOString().split("T")[0];
//       }

//       if (range === "this_year") {
//         const start = new Date(now.getFullYear(), 0, 1);
//         finalStartDate = start.toISOString().split("T")[0];
//         finalEndDate = now.toISOString().split("T")[0];
//       }
//     }

//     const result = await auditService.getCommunityDataGlobal(ndc, {
//       includeGroups: includeGroups === "true",
//       startDate: finalStartDate,
//       endDate: finalEndDate,
//       mode,
//       userId,
//       bin,
//       pcn,
//       grp,
//     });

//     return res.json(result);
//   } catch (error) {
//     console.error("Community data error:", error);
//     return res.status(500).json({ message: error.message });
//   }
// };

// export const getCommunityData = async (req, res) => {
//   try {
//     const { ndc } = req.params;

//     const {
//       includeGroups = "false",
//       startDate,
//       endDate,
//       mode = "state",
//       userId,
//       bin,
//       pcn,
//     } = req.query;

//     const result = await auditService.getCommunityDataGlobal(ndc, {
//       includeGroups: includeGroups === "true",
//       startDate,
//       endDate,
//       mode,
//       userId,
//       bin,
//       pcn,
//     });

//     return res.json(result);
//   } catch (error) {
//     console.error("Community data error:", error);
//     return res.status(500).json({ message: error.message });
//   }
// };

export const getDrugLookup = async (req, res) => {
  try {
    const { id } = req.params;
    const { ingredient } = req.query;
    if (!ingredient)
      return res.status(400).json({ error: "ingredient required" });
    const result = await auditService.getDrugLookup(id, ingredient);
    return res.json(result);
  } catch (error) {
    console.error("getDrugLookup error:", error);
    return res.status(500).json({ message: error.message });
  }
};

export const searchDrugNames = async (req, res) => {
  try {
    const { q, type = "name" } = req.query;

    if (!q || String(q).trim().length < 2) {
      return res.json([]);
    }

    const query = String(q).trim();

    // ── NDC autocomplete branch ──
    if (type === "ndc") {
      const results = await auditService.searchNdcAutocomplete(query, 10);
      return res.json(results);
    }

    // ── Drug-name autocomplete (default) ──
    // Fire-and-forget log only for name searches; NDCs aren't ingredients
    auditService.logDrugSearch(query);

    const results = await auditService.searchDrugNames(query, 10);
    return res.json(results);
  } catch (error) {
    console.error("Drug search error:", error);
    return res.status(500).json({ message: error.message });
  }
};

export const getDrugLookupGlobal = async (req, res) => {
  try {
    const { ingredient, bin, pcn, grp, ndc, type } = req.query;

    // ── NDC mode ──
    if (type === "ndc" || (ndc && String(ndc).trim())) {
      const ndcValue = String(ndc || ingredient || "").trim();
      if (!ndcValue) {
        return res.status(400).json({ error: "ndc required" });
      }
      const result = await auditService.getDrugLookupGlobal("", {
        bin,
        pcn,
        grp,
        ndc: ndcValue,
      });
      return res.json(result);
    }

    // ── Ingredient mode (existing behavior) ──
    if (!ingredient || !String(ingredient).trim()) {
      return res.status(400).json({ error: "ingredient required" });
    }

    const ing = String(ingredient).trim();
    auditService.logDrugSearch(ing);

    const result = await auditService.getDrugLookupGlobal(ing, {
      bin,
      pcn,
      grp,
    });
    return res.json(result);
  } catch (error) {
    console.error("getDrugLookupGlobal error:", error);
    return res.status(500).json({ message: error.message });
  }
};

export const getDrugLookupLanding = async (req, res) => {
  try {
    const result = await auditService.getDrugLookupLanding();
    return res.json(result);
  } catch (error) {
    console.error("getDrugLookupLanding error:", error);
    return res.status(500).json({ message: error.message });
  }
};

export const searchNdcSuggestions = async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || String(q).trim().length < 2) return res.json([]);
    const results = await auditService.searchNdcSuggestions(
      String(q).trim(),
      8,
    );
    return res.json(results);
  } catch (err) {
    // Only log/send safe scalar fields — never the raw error (it has the pg socket attached)
    const msg =
      err && err.message
        ? String(err.message).slice(0, 500)
        : "Failed to fetch NDC suggestions";
    const code = err && err.code ? String(err.code) : "";
    console.error("NDC suggestions error:", code, msg);
    return res.status(500).json({ error: msg });
  }
};

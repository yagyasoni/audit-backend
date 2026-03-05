import * as auditService from "../services/audit.service.js";
import { pool } from "../config/db.js";
// import { createAudit, updateAuditDates, saveInventoryFile, saveWholesalerFiles } from "../services/audit.service.js";
export const createAudit = async (req, res) => {
  try {
    const { name } = req.body;

    if (!name || name.trim() === "") {
      return res.status(400).json({
        error: "Report name is required",
      });
    }

    const audit = await auditService.createAudit(name);

    res.status(201).json(audit);
  } catch (error) {
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
      [id]
    );
    console.log("ROW COUNT FOR AUDIT:", id, countCheck.rows[0]);

    const result = await pool.query(
  `
  SELECT
    ndc,
    MAX(drug_name) AS drug_name,
    MAX(package_size) AS package_size,
    COUNT(*) AS total_ordered,
    SUM(quantity) AS total_billed,
    SUM(primary_paid) AS total_paid,
    SUM(COALESCE(primary_paid, 0) + COALESCE(secondary_paid, 0)) AS total_amount,
    COUNT(*) - SUM(quantity) AS total_shortage
  FROM inventory_rows
  WHERE audit_id = $1
  GROUP BY ndc
  ORDER BY ndc
  `,
  [id]
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
    const file = req.file;
    const headerMapping = req.body.headerMapping
      ? JSON.parse(req.body.headerMapping)
      : {};

    if (!file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const saved = await auditService.saveInventoryFile(
  id,
  file.filename,
  headerMapping
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
    const audits = await auditService.getAudits();
    res.json(audits);
  } catch (error) {
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

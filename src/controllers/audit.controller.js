import * as auditService from "../services/audit.service.js";

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

    if (!req.file) {
      return res.status(400).json({ error: "File is required" });
    }

    const fileRecord = await auditService.saveInventoryFile(
      id,
      req.file.filename,
    );

    res.status(201).json({
      message: "Inventory uploaded successfully",
      file: fileRecord,
    });
  } catch (error) {
    console.error("Upload Inventory Error:", error);
    res.status(500).json({ error: error.message });
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

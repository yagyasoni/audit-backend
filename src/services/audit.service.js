import { pool } from "../config/db.js";

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

export const saveInventoryFile = async (auditId, filename) => {
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

  return result.rows[0];
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

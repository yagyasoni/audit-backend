-- Each report keeps its own supplier list: the suppliers picked for it,
-- whether or not a file has been uploaded for them yet.
--
-- Until now there was one list per account (user_suppliers), so changing
-- suppliers while setting up a new report changed what every older report
-- showed. The account list stays, as the starting list for a NEW report.
--
-- Safe to run more than once. It only creates this table and adds rows to
-- it. No existing table or row is changed.
--
--   node src/scripts/runSql.js src/migrations/20261120_audit_suppliers.sql

CREATE TABLE IF NOT EXISTS audit_suppliers (
  audit_id UUID NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
  supplier_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (audit_id, supplier_name)
);

-- One-time fill for the reports that already exist: each gets the suppliers
-- it has files for. Suppliers that were picked but never uploaded were not
-- saved anywhere, so they cannot be brought back.
INSERT INTO audit_suppliers (audit_id, supplier_name)
SELECT DISTINCT f.audit_id, f.wholesaler_name
  FROM wholesaler_files f
  JOIN audits a ON a.id = f.audit_id
 WHERE f.wholesaler_name IS NOT NULL
   AND f.wholesaler_name <> ''
ON CONFLICT DO NOTHING;

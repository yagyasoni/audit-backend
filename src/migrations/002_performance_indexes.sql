-- Performance indexes for the large tables. Run ONCE against the live database.
--
-- Why: inventory_rows, wholesaler_rows and master_sheet had no indexes at all,
-- so every report, delete and lookup scanned the whole table.
--
-- How to run (from the server that has the .env, e.g. C:\backend or the Linux box):
--
--   node src/scripts/runSql.js src/migrations/002_performance_indexes.sql
--
-- Do NOT use "npm run migrate" for this: that runner sends the whole file as one
-- transaction, and CONCURRENTLY cannot run inside a transaction. It would also
-- try to re-run audit.sql, which is not safe on a live database.
-- CONCURRENTLY builds each index without blocking writes. Safe to re-run.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_inventory_rows_audit
  ON inventory_rows (audit_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_inventory_rows_ndc
  ON inventory_rows (ndc);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_inventory_rows_ndc_norm
  ON inventory_rows ((LPAD(REGEXP_REPLACE(ndc, '[^0-9]', '', 'g'), 11, '0')));

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_inventory_rows_audit_date
  ON inventory_rows (audit_id, date_filled);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_wholesaler_rows_audit
  ON wholesaler_rows (audit_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_wholesaler_rows_file
  ON wholesaler_rows (wholesaler_file_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_wholesaler_rows_ndc_norm
  ON wholesaler_rows ((LPAD(REGEXP_REPLACE(ndc, '[^0-9]', '', 'g'), 11, '0')));

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_master_sheet_bin_norm
  ON master_sheet ((LTRIM(UPPER(TRIM(bin)), '0')));

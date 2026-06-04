-- Add rank to group report rows (copied from the source report's rank column).
-- Runs after group_reports.sql (which creates the table).
ALTER TABLE inventory_group_report_rows
    ADD COLUMN IF NOT EXISTS rank NUMERIC;

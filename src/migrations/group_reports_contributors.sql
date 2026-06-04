-- Shared multi-pharmacy reports: tag each row with the contributor pharmacy so
-- one report can hold a highest-shortage column per pharmacy (merged by NDC).
ALTER TABLE inventory_group_report_rows
    ADD COLUMN IF NOT EXISTS pharmacy_id UUID,
    ADD COLUMN IF NOT EXISTS pharmacy_name TEXT;

-- Backfill existing single-pharmacy rows from their report so old reports render.
UPDATE inventory_group_report_rows rr
SET pharmacy_id = r.pharmacy_id, pharmacy_name = r.pharmacy_name
FROM inventory_group_reports r
WHERE rr.report_id = r.id AND rr.pharmacy_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_group_report_rows_pharmacy
    ON inventory_group_report_rows(report_id, pharmacy_id);

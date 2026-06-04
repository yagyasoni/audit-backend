-- ============================================================================
-- Inventory Group — Per-pharmacy reports inside a group
-- A pharmacy copies its report's (NDC, drug name, package size, highest
-- shortage) into a group. Each "add" creates one report + N rows.
-- ============================================================================

-- ── A single per-pharmacy report added to a group ───────────────────────────
CREATE TABLE IF NOT EXISTS inventory_group_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id UUID NOT NULL REFERENCES inventory_groups(id) ON DELETE CASCADE,
    pharmacy_id UUID REFERENCES pharmacy_details(id) ON DELETE SET NULL,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,

    pharmacy_name TEXT NOT NULL,        -- snapshot → becomes the shortage column header
    source_audit_id TEXT,               -- report it was copied from (frontend auditId is a string)
    label TEXT,
    row_count INTEGER DEFAULT 0,

    created_at TIMESTAMP DEFAULT NOW()
);

-- ── The drug rows belonging to a report ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS inventory_group_report_rows (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    report_id UUID NOT NULL REFERENCES inventory_group_reports(id) ON DELETE CASCADE,

    ndc TEXT,
    drug_name TEXT,
    package_size NUMERIC,
    highest_shortage NUMERIC,
    sort_order INTEGER
);

CREATE INDEX IF NOT EXISTS idx_group_reports_group
    ON inventory_group_reports(group_id);
CREATE INDEX IF NOT EXISTS idx_group_report_rows_report
    ON inventory_group_report_rows(report_id);


-- Add rank to group report rows (copied from the source report's rank column).
-- Runs after group_reports.sql (which creates the table).
ALTER TABLE inventory_group_report_rows
    ADD COLUMN IF NOT EXISTS rank NUMERIC;

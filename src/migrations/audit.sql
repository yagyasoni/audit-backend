-- MAIN AUDIT
CREATE TABLE audits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    inventory_start_date DATE,
    inventory_end_date DATE,
    wholesaler_start_date DATE,
    wholesaler_end_date DATE,
    status TEXT DEFAULT 'draft',
    created_at TIMESTAMP DEFAULT NOW()
);

-- INVENTORY FILE (PrimerX upload)
CREATE TABLE audit_inventory_files (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    audit_id UUID REFERENCES audits(id) ON DELETE CASCADE,
    file_name TEXT,
    uploaded_at TIMESTAMP DEFAULT NOW()
);

-- INVENTORY PARSED ROWS
-- CREATE TABLE audit_inventory_rows (
--     id BIGSERIAL PRIMARY KEY,
--     audit_id UUID REFERENCES audits(id) ON DELETE CASCADE,
--     ndc TEXT,
--     rx_number TEXT,
--     drug_name TEXT,
--     quantity NUMERIC,
--     date_filled DATE,
--     primary_paid NUMERIC,
--     secondary_paid NUMERIC
-- );

-- WHOLESALER FILES (multiple suppliers)
-- CREATE TABLE audit_wholesaler_files (
--     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
--     audit_id UUID REFERENCES audits(id) ON DELETE CASCADE,
--     supplier_name TEXT,
--     file_name TEXT,
--     uploaded_at TIMESTAMP DEFAULT NOW()
-- );
-- DROP TABLE IF EXISTS audit_wholesaler_files CASCADE;a

CREATE TABLE audit_wholesaler_files (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    audit_id UUID REFERENCES audits(id) ON DELETE CASCADE,
    wholesaler_files JSONB NOT NULL DEFAULT '[]',
    uploaded_at TIMESTAMP DEFAULT NOW()
);


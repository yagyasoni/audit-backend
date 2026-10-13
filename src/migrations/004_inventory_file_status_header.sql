ALTER TABLE audit_inventory_files
  ADD COLUMN IF NOT EXISTS status_header TEXT;

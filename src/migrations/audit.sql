-- MAIN AUDIT
CREATE TABLE audits (

    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
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

CREATE TABLE IF NOT EXISTS inventory_rows (
  
    id BIGSERIAL PRIMARY KEY,
    audit_id UUID REFERENCES audits(id) ON DELETE CASCADE,
    
    ndc TEXT,
    rx_number TEXT,
    status TEXT,
    date_filled DATE,
    drug_name TEXT,
    quantity INTEGER,
    package_size TEXT,
    
    primary_bin TEXT,
    primary_paid NUMERIC,
    secondary_bin TEXT,
    secondary_paid NUMERIC,
    primary_pcn TEXT,
    primary_group TEXT,
    brand TEXT
);


CREATE TABLE wholesaler_files (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    audit_id UUID REFERENCES audits(id) ON DELETE CASCADE,

    wholesaler_name TEXT,
    file_name TEXT,

    uploaded_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS wholesaler_rows (
    id BIGSERIAL PRIMARY KEY,

    audit_id UUID REFERENCES audits(id) ON DELETE CASCADE,
    wholesaler_file_id UUID REFERENCES wholesaler_files(id) ON DELETE CASCADE,

    
    ndc TEXT,
    product_name TEXT,
    quantity INTEGER,

    unit_cost NUMERIC,
    total_cost NUMERIC,

    invoice_date DATE,

    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  phone TEXT,
  password TEXT,
  role TEXT DEFAULT 'user',
  is_verified BOOLEAN DEFAULT false,
  status TEXT CHECK (status IN ('active','inactive')) DEFAULT 'inactive',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE auth_providers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_user_id TEXT
);

CREATE TABLE email_otps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT,
  otp TEXT,
  expires_at TIMESTAMP
);

CREATE TABLE refresh_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  token TEXT,
  expires_at TIMESTAMP
);

CREATE TABLE password_resets (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL,
  token TEXT NOT NULL,
  expires_at TIMESTAMP NOT NULL
);



CREATE TABLE pharmacy_details (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    user_id UUID REFERENCES users(id) ON DELETE CASCADE,

    pharmacy_name TEXT NOT NULL,
    address TEXT NOT NULL,
    phone TEXT NOT NULL,
    fax TEXT,

    ncpdp_number TEXT,
    npi_number TEXT,

    pharmacy_license_number TEXT,
    license_expiry_date DATE,
    license_file BYTEA,

    dea_number TEXT,
    dea_expiry_date DATE,
    dea_file BYTEA,

    cds_number TEXT,
    cds_expiry DATE,
    cds_file BYTEA,

    pharmacist_name TEXT,
    pharmacist_license_number TEXT,
    pharmacist_expiration DATE,
    pharmacist_file BYTEA,

    cmea_expiry DATE,
    cmea_file BYTEA,

    -- NEW FIELDS

    ein_number TEXT,
    ein_file BYTEA,

    liability_insurance_file BYTEA,
    insurance_expiration DATE,

    workers_comp_file BYTEA,
    workers_comp_expiration DATE,

    surety_bond_file BYTEA,
    surety_bond_expiration DATE,

    voided_cheque_file BYTEA,

    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);


CREATE TABLE suppliers (
  id UUID PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE supplier_mappings (
  id UUID PRIMARY KEY,
  supplier_id UUID UNIQUE REFERENCES suppliers(id) ON DELETE CASCADE,
  mappings JSON NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE master_sheet (
    id BIGSERIAL PRIMARY KEY,

    bin TEXT,
    pcn TEXT,
    grp TEXT,

    pbm_name TEXT,
    payer_type TEXT,

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE master_sheet_queue (
    id SERIAL PRIMARY KEY,

    bin VARCHAR(20) NOT NULL,
    pcn VARCHAR(50),
    grp VARCHAR(50),

    pbm_name VARCHAR(100),
    payer_type VARCHAR(50),

    status VARCHAR(20) DEFAULT 'pending', -- pending | added

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE feedbacks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,

    subject TEXT NOT NULL,
    message TEXT NOT NULL,

    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE subscriptions (
  id SERIAL PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  status TEXT, -- trialing, active, past_due, canceled
  current_period_end TIMESTAMP,
  trial_end TIMESTAMP,
  grace_period_end TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE preserved_inventory_rx (
    id BIGSERIAL PRIMARY KEY,

    original_user_id UUID,

    rx_number TEXT NOT NULL,
    date_filled DATE NOT NULL,

    -- 🔥 FULL SNAPSHOT
    ndc TEXT,
    status TEXT,
    drug_name TEXT,
    quantity INTEGER,
    package_size TEXT,

    primary_bin TEXT,
    primary_paid NUMERIC,
    secondary_bin TEXT,
    secondary_paid NUMERIC,
    primary_pcn TEXT,
    primary_group TEXT,
    brand TEXT,

    -- Optional traceability
    original_audit_id UUID,

    created_at TIMESTAMP DEFAULT NOW(),

    -- ✅ uniqueness stays minimal
    UNIQUE (original_user_id, rx_number, date_filled)
);


-- ============================================================================
-- Inventory View Network — Schema Migration
-- Run this once on your existing Postgres database.
-- ============================================================================

-- ── Inventory listings (drugs being shared on the network) ──────────────────
CREATE TABLE IF NOT EXISTS inventory_listings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    pharmacy_id UUID REFERENCES pharmacy_details(id) ON DELETE CASCADE,

    ndc TEXT NOT NULL,
    drug_name TEXT NOT NULL,
    strength TEXT,
    dosage_form TEXT,
    manufacturer TEXT,
    package_size TEXT,

    quantity INTEGER NOT NULL CHECK (quantity > 0),
    lot_number TEXT,
    expiry DATE,
    acquisition_cost NUMERIC(10, 2),

    reason_code TEXT NOT NULL CHECK (reason_code IN ('shortage_relief','near_expiry','overstock')),

    is_active BOOLEAN DEFAULT true,
    auto_expires_at TIMESTAMP DEFAULT NOW() + INTERVAL '30 days',

    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_inventory_listings_active
    ON inventory_listings(is_active, auto_expires_at);
CREATE INDEX IF NOT EXISTS idx_inventory_listings_ndc
    ON inventory_listings(ndc);
CREATE INDEX IF NOT EXISTS idx_inventory_listings_user
    ON inventory_listings(user_id);

-- ── Network agreement acceptances (legal audit trail) ───────────────────────
CREATE TABLE IF NOT EXISTS inventory_agreement_acceptances (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    pharmacy_id UUID REFERENCES pharmacy_details(id) ON DELETE SET NULL,
    agreement_version TEXT NOT NULL,
    accepted_at TIMESTAMP DEFAULT NOW(),
    ip_address TEXT,
    user_agent TEXT,
    UNIQUE(user_id, agreement_version)
);

-- ── Connect requests (immutable audit log of all transfer inquiries) ────────
CREATE TABLE IF NOT EXISTS inventory_connect_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    listing_id UUID REFERENCES inventory_listings(id) ON DELETE SET NULL,

    -- Buyer
    buyer_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    buyer_pharmacy_id UUID REFERENCES pharmacy_details(id) ON DELETE SET NULL,

    -- Seller
    seller_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    seller_pharmacy_id UUID REFERENCES pharmacy_details(id) ON DELETE SET NULL,
    seller_email TEXT,

    -- Request details
    patient_rx TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    notes TEXT,

    -- Email contents (stored for audit)
    email_subject TEXT,
    email_body TEXT,
    email_sent_at TIMESTAMP,
    email_message_id TEXT,

    status TEXT DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','accepted','declined','completed','expired')),

    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_connect_requests_buyer
    ON inventory_connect_requests(buyer_user_id);
CREATE INDEX IF NOT EXISTS idx_connect_requests_seller
    ON inventory_connect_requests(seller_user_id);
CREATE INDEX IF NOT EXISTS idx_connect_requests_listing
    ON inventory_connect_requests(listing_id);

-- ── Bookmarks (saved-for-later) ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS inventory_bookmarks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    listing_id UUID NOT NULL REFERENCES inventory_listings(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, listing_id)
);
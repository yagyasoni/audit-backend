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
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE supplier_mappings (
  id UUID PRIMARY KEY,
  supplier_id UUID UNIQUE REFERENCES suppliers(id) ON DELETE CASCADE,
  mappings JSON NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
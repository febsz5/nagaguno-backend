-- NagaGuno Phase 1 Database Schema
-- Database: PostgreSQL 15+
-- Run: psql -U postgres -d nagaguno_db -f 001_init.sql

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "citext";

-- ============================================================
-- ENUMS
-- ============================================================

CREATE TYPE user_role AS ENUM ('farmer', 'vendor', 'buyer', 'admin');
CREATE TYPE auth_provider AS ENUM ('email', 'phone', 'google');
CREATE TYPE account_status AS ENUM ('active', 'pending_verification', 'blocked', 'suspended');

-- ============================================================
-- USERS TABLE (Core)
-- ============================================================

CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    full_name       VARCHAR(150) NOT NULL,
    email           CITEXT UNIQUE,
    phone_number    VARCHAR(20) UNIQUE,
    password_hash   VARCHAR(255),
    role            user_role NOT NULL DEFAULT 'buyer',
    auth_provider   auth_provider NOT NULL DEFAULT 'email',
    google_id       VARCHAR(255) UNIQUE,
    is_email_verified   BOOLEAN NOT NULL DEFAULT FALSE,
    is_phone_verified   BOOLEAN NOT NULL DEFAULT FALSE,
    account_status  account_status NOT NULL DEFAULT 'active',
    last_login_at   TIMESTAMP WITH TIME ZONE,
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

    -- At least one contact method required
    CONSTRAINT chk_contact CHECK (
        email IS NOT NULL OR phone_number IS NOT NULL OR google_id IS NOT NULL
    ),
    -- Password required for non-Google accounts
    CONSTRAINT chk_password CHECK (
        auth_provider = 'google' OR password_hash IS NOT NULL
    )
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_phone ON users(phone_number);
CREATE INDEX idx_users_role ON users(role);
CREATE INDEX idx_users_google_id ON users(google_id);

-- ============================================================
-- FARMER PROFILES
-- ============================================================

CREATE TABLE farmer_profiles (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    farm_name       VARCHAR(200),
    farm_size_ha    DECIMAL(10, 2),
    location        VARCHAR(255),
    barangay        VARCHAR(100),
    municipality    VARCHAR(100) DEFAULT 'Naga City',
    certifications  TEXT,
    farm_description TEXT,
    avg_rating      DECIMAL(3,2) DEFAULT 0.00,
    total_agreements INT DEFAULT 0,
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- ============================================================
-- VENDOR PROFILES
-- ============================================================

CREATE TABLE vendor_profiles (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    business_name   VARCHAR(200),
    business_address VARCHAR(255),
    business_permit VARCHAR(100),
    avg_rating      DECIMAL(3,2) DEFAULT 0.00,
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- ============================================================
-- BUYER PROFILES
-- ============================================================

CREATE TABLE buyer_profiles (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    delivery_address    VARCHAR(255),
    preferred_payment   VARCHAR(50),
    saved_farmers_count INT DEFAULT 0,
    created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- ============================================================
-- OTP / PASSWORD RESET TOKENS
-- ============================================================

CREATE TABLE otp_tokens (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token       VARCHAR(10) NOT NULL,
    purpose     VARCHAR(50) NOT NULL DEFAULT 'password_reset',  -- 'verify_email'|'verify_phone'|'password_reset'
    expires_at  TIMESTAMP WITH TIME ZONE NOT NULL,
    used_at     TIMESTAMP WITH TIME ZONE,
    created_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_otp_user ON otp_tokens(user_id);
CREATE INDEX idx_otp_token ON otp_tokens(token);

-- ============================================================
-- REFRESH TOKENS (for JWT refresh)
-- ============================================================

CREATE TABLE refresh_tokens (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  VARCHAR(255) NOT NULL UNIQUE,
    device_info VARCHAR(255),
    ip_address  INET,
    expires_at  TIMESTAMP WITH TIME ZONE NOT NULL,
    revoked_at  TIMESTAMP WITH TIME ZONE,
    created_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_refresh_user ON refresh_tokens(user_id);

-- ============================================================
-- AUDIT LOG (for ACID compliance tracking)
-- ============================================================

CREATE TABLE audit_logs (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
    action      VARCHAR(100) NOT NULL,
    table_name  VARCHAR(100),
    record_id   UUID,
    old_values  JSONB,
    new_values  JSONB,
    ip_address  INET,
    user_agent  TEXT,
    created_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_user ON audit_logs(user_id);
CREATE INDEX idx_audit_action ON audit_logs(action);

-- ============================================================
-- AUTO-UPDATE updated_at trigger
-- ============================================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_farmer_profiles_updated_at
    BEFORE UPDATE ON farmer_profiles
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_vendor_profiles_updated_at
    BEFORE UPDATE ON vendor_profiles
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_buyer_profiles_updated_at
    BEFORE UPDATE ON buyer_profiles
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- SEED: Admin account (change password after first login!)
-- ============================================================

-- Admin seed (password: Admin@NagaGuno2026 - will be hashed in app)
-- Run seed via: npm run seed

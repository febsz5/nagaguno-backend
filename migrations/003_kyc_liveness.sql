-- NagaGuno Migration 003: KYC Liveness Photo
-- Database: PostgreSQL 15+ (Supabase)
-- Run: psql -U postgres -d nagaguno_db -f 003_kyc_liveness.sql
--
-- Adds storage for the frame captured at the moment a client-side blink
-- challenge was confirmed (see the Flutter liveness spec for the full
-- design and the honest security-scope notes -- this is a real column
-- addition, already applied directly against the live database when
-- this file was written).

ALTER TABLE kyc_submissions
  ADD COLUMN IF NOT EXISTS liveness_photo_url text,
  ADD COLUMN IF NOT EXISTS liveness_verified_at timestamp with time zone;

-- Both nullable, not NOT NULL: this allows the column to exist and be
-- populated by new submissions immediately, without breaking any
-- existing pending/approved/rejected rows that predate this feature.
-- Enforcement that a NEW submission must include a liveness photo lives
-- in routes/kyc.js's own validation (matching how id_front is required
-- by route-level validation, not a DB constraint), not here.

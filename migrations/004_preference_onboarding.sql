-- NagaGuno Migration 004: Preference Onboarding
-- Database: PostgreSQL 15+ (Supabase)
-- Run: psql -U postgres -d nagaguno_db -f 004_preference_onboarding.sql
--
-- Kept deliberately minimal, matching the earlier onboarding UX spec's
-- own "2-4 steps max, don't over-engineer" principle. selected_categories
-- reuses the exact same category vocabulary already used everywhere
-- else in the app (products, crop plans, marketplace filters) rather
-- than introducing a second taxonomy. Already applied directly
-- against the live database when this file was written.

ALTER TABLE buyer_profiles
  ADD COLUMN IF NOT EXISTS preference_onboarding_completed boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS selected_categories text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS price_preference text,
  ADD COLUMN IF NOT EXISTS recommendation_priority text;

ALTER TABLE farmer_profiles
  ADD COLUMN IF NOT EXISTS preference_onboarding_completed boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS selected_categories text[] NOT NULL DEFAULT '{}';

ALTER TABLE vendor_profiles
  ADD COLUMN IF NOT EXISTS preference_onboarding_completed boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS selected_categories text[] NOT NULL DEFAULT '{}';

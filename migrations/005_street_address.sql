-- 005_street_address.sql
--
-- Adds a free-text street/zone/landmark field, separate from
-- barangay. barangay stays a clean, canonical value from the fixed
-- 27-name dropdown (used for exact-match filtering elsewhere --
-- "near me" sorting, farmer/product location filters -- which would
-- break if street details were concatenated into that same column).
-- This field is genuinely free text: there is no reliable, complete,
-- verifiable public dataset of every street/zone within Naga City's
-- 27 barangays the way there is for the barangays themselves.

ALTER TABLE users ADD COLUMN IF NOT EXISTS street_address VARCHAR(200);
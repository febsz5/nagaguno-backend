-- 010_recommendation_priority_array.sql
--
-- Real fix: "What matters most to you?" during onboarding was
-- single-select only (a plain TEXT column), while the user
-- explicitly wants multiple selections here, same as the category
-- step already allows. Converts existing single values into a
-- one-element array so no data is lost for buyers who already set
-- this.

ALTER TABLE buyer_profiles
  ALTER COLUMN recommendation_priority TYPE TEXT[]
  USING CASE WHEN recommendation_priority IS NULL THEN NULL ELSE ARRAY[recommendation_priority] END;
-- 006_product_views.sql
--
-- Real, new infrastructure: the app had no record of a buyer viewing
-- a product at all before this -- orders were the only behavioral
-- signal that existed. This is what lets "the buyer looked at a
-- Fruits product, even though they didn't pick Fruits during
-- onboarding" actually mean something the recommendation system can
-- use.

CREATE TABLE product_views (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  category VARCHAR(50) NOT NULL, -- denormalized on purpose: a view should
    -- still count toward that category's signal even if the product is
    -- later edited/deleted, matching how order_items already denormalizes
    -- product details for the same reason
  viewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_product_views_buyer_recent ON product_views (buyer_id, viewed_at DESC);

ALTER TABLE product_views ENABLE ROW LEVEL SECURITY;

-- Matches the real, existing pattern on notifications/agreements: a
-- buyer can insert and read their own view history; nobody else's.
CREATE POLICY product_views_own ON product_views
  FOR ALL
  USING (buyer_id = app_current_user_id())
  WITH CHECK (buyer_id = app_current_user_id());
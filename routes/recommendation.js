/**
 * NagaGuno - Recommendation Routes
 *
 * Products and farmers are recommended from REAL live data in this
 * database -- actual listings, actual purchase history (orders +
 * order_items), actual seller reviews -- not the synthetic dataset the
 * Python ML service was trained on. That model returned believable-looking
 * but fake products (P0001, made-up farmers) that don't exist in the real
 * app, which is exactly the gap this rewrite closes.
 *
 * /health and /model-info still point at the Flask service, since those
 * are just diagnostics about whether it's running -- not user-facing data.
 */

const express = require("express");
const router  = express.Router();
const { query } = require("../config/database");
const recService = require("../services/recommendationService");

// GET /api/recommendations/health
router.get("/health", async (req, res) => {
  const status = await recService.healthCheck();
  return res.status(status.status === "ok" ? 200 : 503).json(status);
});

// GET /api/recommendations/model-info
router.get("/model-info", async (req, res) => {
  const result = await recService.getModelInfo();
  if (!result.success) return res.status(503).json({ success: false, message: result.error });
  return res.status(200).json({ success: true, ...result.data });
});

// Real category preferences, inferred from what this buyer has actually
// purchased before (order_items -> products.category), not a stated
// preference field (no such column exists on buyer_profiles).
async function getBuyerPreferredCategories(buyerId) {
  const { rows } = await query(
    `SELECT p.category, SUM(oi.quantity) as total_qty
     FROM orders o
     JOIN order_items oi ON oi.order_id = o.id
     JOIN products p ON p.id = oi.product_id
     WHERE o.buyer_id = $1
     GROUP BY p.category
     ORDER BY total_qty DESC
     LIMIT 3`,
    [buyerId]
  );
  return rows.map(r => r.category);
}

// The buyer's own stated onboarding choices -- content-based's real
// cold-start signal, genuinely separate from getBuyerPreferredCategories
// above (which is order-history-derived and empty for a brand-new buyer).
async function getBuyerOnboardingCategories(buyerId) {
  const { rows } = await query(
    `SELECT selected_categories FROM buyer_profiles WHERE user_id = $1`,
    [buyerId]
  );
  return rows[0]?.selected_categories || [];
}

// Real, new behavioral signal: categories this buyer has actually
// viewed or ordered, whether or not those categories were ever picked
// during onboarding. This is what lets "clicked on a Fruits product
// despite only choosing Vegetables at onboarding" mean something --
// distinct from onboarding categories, which never change after
// the buyer sets them once.
async function getBuyerInteractionCategories(buyerId) {
  const { rows } = await query(
    `SELECT DISTINCT category FROM (
       SELECT category FROM product_views WHERE buyer_id = $1
       UNION
       SELECT p.category::text FROM orders o
         JOIN order_items oi ON oi.order_id = o.id
         JOIN products p ON p.id = oi.product_id
       WHERE o.buyer_id = $1
     ) combined`,
    [buyerId]
  );
  return rows.map(r => r.category);
}

// Real, live collaborative-style signal -- NOT the pretrained
// cf_item_similarity.pkl (which is mathematically tied to the 264
// synthetic products it was computed from and cannot score real
// products at all, verified directly against the trained file before
// concluding this). Computed fresh from real order data instead: among
// OTHER buyers who share at least one of this buyer's own interacted
// categories, which of the current candidate products have they
// actually ordered. A genuinely collaborative signal (based on
// similar users' real behavior), just computed live rather than from
// a frozen matrix -- which also means it naturally improves as real
// order volume grows, with no retraining step required.
async function getLiveCollaborativeScores(buyerId, interactedCategories, candidateProductIds) {
  if (!interactedCategories.length || !candidateProductIds.length) return {};
  const { rows } = await query(
    `WITH similar_buyers AS (
       SELECT DISTINCT buyer_id FROM (
         SELECT buyer_id, category FROM product_views
         UNION ALL
         SELECT o.buyer_id, p.category::text FROM orders o
           JOIN order_items oi ON oi.order_id = o.id
           JOIN products p ON p.id = oi.product_id
       ) all_interactions
       WHERE category = ANY($1::text[]) AND buyer_id != $2
     )
     SELECT oi.product_id, COUNT(DISTINCT o.buyer_id) as similar_buyer_count
     FROM orders o
     JOIN order_items oi ON oi.order_id = o.id
     WHERE o.buyer_id IN (SELECT buyer_id FROM similar_buyers)
       AND oi.product_id = ANY($3::uuid[])
     GROUP BY oi.product_id`,
    [interactedCategories, buyerId, candidateProductIds]
  );
  const maxCount = Math.max(1, ...rows.map(r => Number(r.similar_buyer_count)));
  const scores = {};
  for (const r of rows) scores[r.product_id] = Number(r.similar_buyer_count) / maxCount;
  return scores;
}

async function recommendRealProducts(buyerId, topN, filterCategory) {
  const [onboardingCategories, interactionCategories] = buyerId
    ? await Promise.all([getBuyerOnboardingCategories(buyerId), getBuyerInteractionCategories(buyerId)])
    : [[], []];

  // Real interaction (a view OR an order) beyond onboarding is what
  // actually activates the collaborative half -- a buyer who only
  // ever completed onboarding and has never looked at or bought
  // anything is a genuine cold-start case, matching the same
  // fall-back-to-content-only behavior rec_app.py's own trained
  // hybrid model uses for a new buyer with no order history.
  const hasRealInteraction = interactionCategories.length > 0;
  const queryCategories = [...new Set([...onboardingCategories, ...interactionCategories])];
  const isNewBuyer = queryCategories.length === 0;
  const preferredCategories = buyerId ? await getBuyerPreferredCategories(buyerId) : [];

  // Broader real candidate pool -- content-based scoring needs
  // several real candidates per category to meaningfully rank, not
  // just whatever the old popularity-only query already narrowed to.
  const { rows } = await query(
    `WITH product_popularity AS (
       SELECT oi.product_id, COUNT(*) as order_count, SUM(oi.quantity) as total_qty_sold
       FROM order_items oi
       GROUP BY oi.product_id
     ),
     seller_ratings AS (
       SELECT reviewee_id, AVG(rating)::numeric(3,1) as avg_rating
       FROM reviews GROUP BY reviewee_id
     )
     SELECT
       p.id as product_id, p.name as product_name, p.category, p.unit,
       p.price_per_unit as price_php, p.stock_qty, p.seller_id, p.is_perishable,
       p.image_url,
       u.full_name as seller_name,
       COALESCE(pp.order_count, 0) as total_orders,
       COALESCE(pp.total_qty_sold, 0) as total_quantity_sold,
       COALESCE(sr.avg_rating, 0) as rating,
       (p.category::text = ANY($1::text[])) as matches_preference
     FROM products p
     JOIN users u ON u.id = p.seller_id
     LEFT JOIN product_popularity pp ON pp.product_id = p.id
     LEFT JOIN seller_ratings sr ON sr.reviewee_id = p.seller_id
     WHERE p.status = 'live' AND p.stock_qty > 0 AND u.account_status = 'active'
       ${filterCategory ? 'AND p.category::text = $2' : ''}
     ORDER BY total_quantity_sold DESC NULLS LAST, p.created_at DESC
     LIMIT 60`,
    filterCategory ? [preferredCategories, filterCategory] : [preferredCategories]
  );

  // Real content-based scoring via the trained TF-IDF vectorizer,
  // applied to these real products -- falls back to the plain
  // popularity ordering below if the Python service is unreachable,
  // rather than breaking the whole marketplace/recommendations screen
  // over a dependency that (as this whole conversation found) can
  // genuinely be down.
  let cbScores = {};
  let method = "popularity_fallback";
  if (!isNewBuyer && rows.length) {
    const scoreResult = await recService.scoreLiveProducts(
      queryCategories,
      rows.map(r => ({ product_id: r.product_id, name: r.product_name, category: r.category, unit: r.unit }))
    );
    if (scoreResult.success) {
      cbScores = scoreResult.data.scores || {};
      method = hasRealInteraction ? "hybrid" : "content_based";
    }
  }

  const cfScores = hasRealInteraction && method !== "popularity_fallback"
    ? await getLiveCollaborativeScores(buyerId, interactionCategories, rows.map(r => r.product_id))
    : {};

  const maxQty = Math.max(1, ...rows.map(r => Number(r.total_quantity_sold) || 0));
  const scored = rows.map(r => {
    const cb = cbScores[r.product_id] ?? 0;
    const cf = cfScores[r.product_id] ?? 0;
    const popularityScore = (r.matches_preference ? 0.5 : 0) + 0.5 * (Number(r.total_quantity_sold) / maxQty);
    // Same 0.4/0.6 content/collaborative weighting as rec_app.py's own
    // trained hybrid model, kept consistent on purpose rather than
    // picked arbitrarily -- falls through to the real-order-based
    // popularity score only when the ML service itself is unreachable.
    const score = method === "popularity_fallback" ? popularityScore : method === "hybrid" ? 0.4 * cb + 0.6 * cf : cb;

    let reason;
    if (method === "popularity_fallback") {
      reason = r.matches_preference ? `You've bought ${r.category} before`
        : Number(r.total_orders) > 0 ? `Popular \u2014 ${r.total_orders} real order${r.total_orders === 1 ? '' : 's'} so far`
        : 'New listing';
    } else if (cf > 0.3 && cb > 0.3) {
      reason = `Matches your interests, and popular with similar buyers`;
    } else if (cf > 0.3) {
      reason = `Popular with buyers who share your interests`;
    } else if (interactionCategories.includes(r.category) && !onboardingCategories.includes(r.category)) {
      reason = `Because you looked at ${r.category} before`;
    } else if (onboardingCategories.includes(r.category)) {
      reason = `Matches your preferred category: ${r.category}`;
    } else {
      reason = 'Recommended for you';
    }

    return { row: r, score, reason };
  });

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, topN);

  const products = top.map(({ row: r, score, reason }) => ({
    product_id: r.product_id,
    product_name: r.product_name,
    category: r.category,
    unit: r.unit,
    price_php: Number(r.price_php),
    stock_qty: Number(r.stock_qty),
    image_url: r.image_url,
    seller_name: r.seller_name,
    is_organic: false, // no real organic-certification field exists yet -- not fabricated
    rating: Number(r.rating),
    total_orders: Number(r.total_orders),
    recommendation_score: score,
    recommendation_reason: reason,
  }));

  return { products, preferred_categories: preferredCategories, is_new_buyer: isNewBuyer, method };
}

async function recommendRealFarmers(topN, filterBarangay, filterCategory) {
  const { rows } = await query(
    `SELECT
       u.id as farmer_id, u.full_name as name, u.account_status,
       fp.barangay, fp.farm_name,
       (array_agg(DISTINCT p.category) FILTER (WHERE p.category IS NOT NULL))::text[] as specializations,
       COUNT(DISTINCT p.id) as live_listings,
       COALESCE(sr.avg_rating, 0) as rating
     FROM users u
     JOIN farmer_profiles fp ON fp.user_id = u.id
     LEFT JOIN products p ON p.seller_id = u.id AND p.status = 'live'
     LEFT JOIN (
       SELECT reviewee_id, AVG(rating)::numeric(3,1) as avg_rating
       FROM reviews GROUP BY reviewee_id
     ) sr ON sr.reviewee_id = u.id
     WHERE u.role = 'farmer' AND u.account_status = 'active'
       ${filterBarangay ? 'AND fp.barangay = $2' : ''}
     GROUP BY u.id, u.full_name, u.account_status, fp.barangay, fp.farm_name, sr.avg_rating
     HAVING COUNT(DISTINCT p.id) > 0
       ${filterCategory ? `AND $${filterBarangay ? 3 : 2} = ANY(array_agg(DISTINCT p.category)::text[])` : ''}
     ORDER BY live_listings DESC
     LIMIT $1`,
    [topN, ...(filterBarangay ? [filterBarangay] : []), ...(filterCategory ? [filterCategory] : [])]
  );

  return rows.map(f => ({
    farmer_id: f.farmer_id,
    name: f.name,
    barangay: f.barangay,
    farm_name: f.farm_name,
    is_verified: f.account_status === 'active', // real KYC-approval status
    specializations: f.specializations || [],
    rating: Number(f.rating),
    live_listings: Number(f.live_listings),
    recommendation_reason: `${f.live_listings} active listing${f.live_listings === 1 ? '' : 's'}`,
  }));
}

// POST /api/recommendations/products
// Body: { buyer_id, top_n?, filter_category? }
router.post("/products", async (req, res) => {
  const { buyer_id, top_n = 8, filter_category } = req.body;
  if (!buyer_id) return res.status(400).json({ success: false, message: "buyer_id is required" });
  try {
    const data = await recommendRealProducts(buyer_id, top_n, filter_category);
    return res.status(200).json({ success: true, ...data });
  } catch (err) {
    console.error("POST /recommendations/products", err);
    return res.status(500).json({ success: false, message: "Failed to load recommendations." });
  }
});

// POST /api/recommendations/farmers
// Body: { buyer_id, top_n?, filter_barangay?, filter_category? }
router.post("/farmers", async (req, res) => {
  const { buyer_id, top_n = 5, filter_barangay, filter_category } = req.body;
  if (!buyer_id) return res.status(400).json({ success: false, message: "buyer_id is required" });
  try {
    const farmers = await recommendRealFarmers(top_n, filter_barangay, filter_category);
    return res.status(200).json({ success: true, farmers });
  } catch (err) {
    console.error("POST /recommendations/farmers", err);
    return res.status(500).json({ success: false, message: "Failed to load farmer recommendations." });
  }
});

// POST /api/recommendations/all
// Body: { buyer_id, top_n_products?, top_n_farmers?, filter_category? }
router.post("/all", async (req, res) => {
  const { buyer_id, top_n_products = 8, top_n_farmers = 5, filter_category } = req.body;
  if (!buyer_id) return res.status(400).json({ success: false, message: "buyer_id is required" });
  try {
    const [productData, farmers] = await Promise.all([
      recommendRealProducts(buyer_id, top_n_products, filter_category),
      recommendRealFarmers(top_n_farmers, null, filter_category),
    ]);
    return res.status(200).json({
      success: true,
      buyer_id,
      preferred_categories: productData.preferred_categories,
      is_new_buyer: productData.is_new_buyer,
      method: productData.method, // real, not guessed client-side: "content_based" | "hybrid" | "popularity_fallback"
      products: productData.products,
      farmers,
    });
  } catch (err) {
    console.error("POST /recommendations/all", err);
    return res.status(500).json({ success: false, message: "Failed to load recommendations." });
  }
});

// POST /api/recommendations/similar
// Body: { product_id, top_n? }
// Real "similar" = same category, currently live, ranked by real sales.
router.post("/similar", async (req, res) => {
  const { product_id, top_n = 8 } = req.body;
  if (!product_id) return res.status(400).json({ success: false, message: "product_id is required" });
  try {
    const { rows: baseRows } = await query(`SELECT category FROM products WHERE id = $1`, [product_id]);
    if (!baseRows.length) return res.status(404).json({ success: false, message: "Product not found." });

    const { rows } = await query(
      `WITH product_popularity AS (
         SELECT oi.product_id, SUM(oi.quantity) as total_qty_sold
         FROM order_items oi GROUP BY oi.product_id
       )
       SELECT p.id as product_id, p.name as product_name, p.category, p.unit,
         p.price_per_unit as price_php, p.stock_qty, p.image_url,
         COALESCE(pp.total_qty_sold, 0) as total_quantity_sold
       FROM products p
       JOIN users u ON u.id = p.seller_id
       LEFT JOIN product_popularity pp ON pp.product_id = p.id
       WHERE p.status = 'live' AND p.stock_qty > 0 AND u.account_status = 'active'
         AND p.category::text = $1 AND p.id != $2
       ORDER BY total_quantity_sold DESC NULLS LAST, p.created_at DESC
       LIMIT $3`,
      [baseRows[0].category, product_id, top_n]
    );
    return res.status(200).json({ success: true, products: rows });
  } catch (err) {
    console.error("POST /recommendations/similar", err);
    return res.status(500).json({ success: false, message: "Failed to load similar products." });
  }
});

module.exports = router;
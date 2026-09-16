// routes/spoilage.js
const express = require('express');
const { queryAsUser } = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

// GET /api/spoilage/dashboard — admin monitoring across all live listings
router.get('/dashboard', authorize('admin'), async (req, res) => {
  try {
    const { rows: listings } = await queryAsUser(req.user, `SELECT * FROM product_spoilage_status ORDER BY remaining_pct ASC`);

    const counts = { fresh: 0, near_spoilage: 0, critical: 0, expired: 0 };
    for (const row of listings) {
      if (row.stage && counts[row.stage] !== undefined) counts[row.stage] += 1;
    }

    const { rows: acceptedRows } = await queryAsUser(req.user, 
      `SELECT COUNT(*) AS n FROM spoilage_price_recommendations WHERE status = 'accepted'`
    );

    res.json({
      success: true,
      data: { listings, counts, auto_discounts_applied: parseInt(acceptedRows[0].n, 10) },
    });
  } catch (err) {
    console.error('GET /spoilage/dashboard', err);
    res.status(500).json({ success: false, message: 'Failed to load spoilage dashboard.' });
  }
});

// GET /api/spoilage/my-listings — farmer/vendor view of their own stock
router.get('/my-listings', authorize('farmer', 'vendor'), async (req, res) => {
  try {
    const { rows: listings } = await queryAsUser(req.user, 
      `SELECT * FROM product_spoilage_status WHERE seller_id = $1 ORDER BY remaining_pct ASC`,
      [req.user.id]
    );
    if (!listings.length) return res.json({ success: true, data: [] });

    const productIds = listings.map((l) => l.product_id);
    const { rows: recos } = await queryAsUser(req.user, 
      `SELECT * FROM spoilage_price_recommendations
       WHERE product_id = ANY($1::uuid[]) AND status = 'suggested'
       ORDER BY created_at DESC`,
      [productIds]
    );

    // Real, new query: the most recent APPLIED discount per product
    // (status='accepted', from either path -- the seller's own
    // "Start a Sale"/accepted suggestion, or the automatic cron job)
    // -- previously only ever fetched pending 'suggested' ones,
    // meaning a seller had no persistent way to see "yes, a discount
    // is currently live on this listing" once the one-time success
    // snackbar had faded.
    const { rows: appliedRows } = await queryAsUser(req.user, 
      `SELECT * FROM spoilage_price_recommendations
       WHERE product_id = ANY($1::uuid[]) AND status = 'accepted'
       ORDER BY created_at DESC`,
      [productIds]
    );

    const recoByProduct = new Map();
    for (const reco of recos) {
      if (!recoByProduct.has(reco.product_id)) recoByProduct.set(reco.product_id, reco);
    }
    const appliedByProduct = new Map();
    for (const applied of appliedRows) {
      if (!appliedByProduct.has(applied.product_id)) appliedByProduct.set(applied.product_id, applied);
    }

    res.json({
      success: true,
      data: listings.map((l) => ({
        ...l,
        recommendation: recoByProduct.get(l.product_id) || null,
        applied_discount: appliedByProduct.get(l.product_id) || null,
      })),
    });
  } catch (err) {
    console.error('GET /spoilage/my-listings', err);
    res.status(500).json({ success: false, message: 'Failed to load your listings.' });
  }
});

// POST /api/spoilage/recommendations/:id/respond — seller accepts or dismisses a suggested discount
router.post('/recommendations/:id/respond', authorize('farmer', 'vendor'), async (req, res) => {
  try {
    const { action } = req.body;
    if (!['accept', 'dismiss'].includes(action)) {
      return res.status(400).json({ success: false, message: "action must be 'accept' or 'dismiss'." });
    }

    const { rows } = await queryAsUser(req.user, 
      `SELECT spr.id, spr.product_id, spr.recommended_price, spr.status, p.seller_id
       FROM spoilage_price_recommendations spr
       JOIN products p ON p.id = spr.product_id
       WHERE spr.id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'Recommendation not found.' });
    const reco = rows[0];

    if (reco.seller_id !== req.user.id) {
      return res.status(403).json({ success: false, message: 'This recommendation is not for one of your listings.' });
    }
    if (reco.status !== 'suggested') {
      return res.status(409).json({ success: false, message: 'This recommendation has already been responded to.' });
    }

    const newStatus = action === 'accept' ? 'accepted' : 'dismissed';
    await queryAsUser(req.user, 
      `UPDATE spoilage_price_recommendations SET status = $1, responded_at = NOW() WHERE id = $2`,
      [newStatus, req.params.id]
    );

    if (action === 'accept') {
      await queryAsUser(req.user, `UPDATE products SET price_per_unit = $1 WHERE id = $2`, [reco.recommended_price, reco.product_id]);
    }

    res.json({ success: true, data: { id: req.params.id, status: newStatus } });
  } catch (err) {
    console.error('POST /spoilage/recommendations/:id/respond', err);
    res.status(500).json({ success: false, message: 'Failed to respond to recommendation.' });
  }
});

// POST /api/spoilage/report/:productId
// Seller manually reports that a batch has spoiled faster than the
// category estimate -- overrides the automatic time-based calculation.
// Distinct from the accept/dismiss flow above: this is the seller
// correcting the system, not responding to a system suggestion.
router.post('/report/:productId', authorize('farmer', 'vendor'), async (req, res) => {
  try {
    const { stage } = req.body;
    if (!['near_spoilage', 'critical', 'expired'].includes(stage)) {
      return res.status(400).json({ success: false, message: "stage must be 'near_spoilage', 'critical', or 'expired'." });
    }

    const { rows: prodRows } = await queryAsUser(req.user, 
      `SELECT id, seller_id, price_per_unit FROM products WHERE id = $1 AND status = 'live'`,
      [req.params.productId]
    );
    if (!prodRows.length) return res.status(404).json({ success: false, message: 'Product not found.' });
    if (prodRows[0].seller_id !== req.user.id) {
      return res.status(403).json({ success: false, message: 'This is not one of your listings.' });
    }

    await queryAsUser(req.user, 
      `UPDATE products SET manual_spoilage_stage = $1, manual_spoilage_reported_at = NOW() WHERE id = $2`,
      [stage, req.params.productId]
    );

    // Auto-generate a system-sourced recommendation at the reported
    // severity, same discount tiers as the automatic cron job, so the
    // seller immediately gets a suggested price without a separate step.
    if (stage === 'near_spoilage' || stage === 'critical') {
      const discount = stage === 'critical' ? 0.30 : 0.15;
      const newPrice = Math.round(prodRows[0].price_per_unit * (1 - discount) * 100) / 100;
      await queryAsUser(req.user, 
        `INSERT INTO spoilage_price_recommendations
           (product_id, stage, original_price, recommended_discount_pct, recommended_price, source)
         VALUES ($1, $2, $3, $4, $5, 'system')`,
        [req.params.productId, stage, prodRows[0].price_per_unit, discount, newPrice]
      );
    }

    res.json({ success: true, message: 'Spoilage status reported.' });
  } catch (err) {
    console.error('POST /spoilage/report/:productId', err);
    res.status(500).json({ success: false, message: 'Failed to report spoilage.' });
  }
});

// POST /api/spoilage/sale/:productId
// Seller starts a voluntary sale, unrelated to spoilage -- e.g. overstock,
// a promo, or just wanting to move a product faster. Applied immediately
// (no accept/dismiss step, since the seller is the one initiating it) and
// tagged source='seller' so buyer-facing UI never shows spoilage/urgency
// language for it -- only a plain "Sale" badge.
router.post('/sale/:productId', authorize('farmer', 'vendor'), async (req, res) => {
  try {
    const discountPct = Number(req.body.discount_pct);
    if (!discountPct || discountPct <= 0 || discountPct >= 1) {
      return res.status(400).json({ success: false, message: 'discount_pct must be a number between 0 and 1 (e.g. 0.15 for 15% off).' });
    }

    const { rows: prodRows } = await queryAsUser(req.user, 
      `SELECT id, seller_id, price_per_unit, status FROM products WHERE id = $1`,
      [req.params.productId]
    );
    if (!prodRows.length) return res.status(404).json({ success: false, message: 'Product not found.' });
    if (prodRows[0].seller_id !== req.user.id) {
      return res.status(403).json({ success: false, message: 'This is not one of your listings.' });
    }

    const originalPrice = prodRows[0].price_per_unit;
    const newPrice = Math.round(originalPrice * (1 - discountPct) * 100) / 100;

    const { rows: statusRows } = await queryAsUser(req.user, 
      `SELECT stage FROM product_spoilage_status WHERE product_id = $1`,
      [req.params.productId]
    );
    const currentStage = statusRows[0]?.stage ?? 'fresh';

    const { rows } = await queryAsUser(req.user, 
      `INSERT INTO spoilage_price_recommendations
         (product_id, stage, original_price, recommended_discount_pct, recommended_price, source, status, responded_at)
       VALUES ($1, $2, $3, $4, $5, 'seller', 'accepted', NOW())
       RETURNING *`,
      [req.params.productId, currentStage, originalPrice, discountPct, newPrice]
    );

    // Real bug fixed: starting a manual sale never touched any
    // pre-existing pending system suggestion for the same product --
    // confirmed against the real data this session, where a
    // 'suggested' recommendation kept showing accept/reject options
    // even after a completely different manual discount had already
    // been applied. Superseding it here means the stale suggestion
    // disappears from the seller's view immediately, matching what
    // actually happened to the price.
    await queryAsUser(req.user, 
      `UPDATE spoilage_price_recommendations SET status = 'dismissed', responded_at = NOW()
       WHERE product_id = $1 AND status = 'suggested'`,
      [req.params.productId]
    );

    await queryAsUser(req.user, `UPDATE products SET price_per_unit = $1 WHERE id = $2`, [newPrice, req.params.productId]);

    res.status(201).json({ success: true, data: rows[0], message: 'Sale is now live.' });
  } catch (err) {
    console.error('POST /spoilage/sale/:productId', err);
    res.status(500).json({ success: false, message: 'Failed to start sale.' });
  }
});

module.exports = router;
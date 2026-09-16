// backend/routes/marketplace.js
const express   = require('express');
const { queryAsUser } = require('../config/database');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

// GET /api/marketplace/products
router.get('/products', async (req, res) => {
  try {
    const { category, search, sort = 'newest', min_price, max_price, barangay, flash_sale } = req.query;

    let sql = `
      SELECT
        p.id, p.name, p.description, p.category, p.unit,
        p.price_per_unit, p.stock_qty, p.image_url, p.barangay,
        p.seller_id, p.seller_role, p.created_at,
        u.full_name       AS seller_name,
        COALESCE(fp.barangay, vp.barangay, p.barangay) AS seller_barangay,
        fp.farm_name,
        fp.farm_photo_url,
        vp.business_name,
        vp.business_photo_url,
        pss.stage              AS spoilage_stage,
        pss.remaining_pct      AS spoilage_remaining_pct,
        spr.original_price     AS flash_sale_original_price,
        spr.recommended_discount_pct AS flash_sale_discount_pct,
        spr.source              AS flash_sale_source
      FROM products p
      JOIN users u ON u.id = p.seller_id
      LEFT JOIN farmer_profiles fp ON fp.user_id = p.seller_id
      LEFT JOIN vendor_profiles  vp ON vp.user_id = p.seller_id
      LEFT JOIN product_spoilage_status pss ON pss.product_id = p.id
      LEFT JOIN LATERAL (
        SELECT original_price, recommended_discount_pct, source
        FROM spoilage_price_recommendations
        WHERE product_id = p.id AND status = 'accepted'
        ORDER BY created_at DESC LIMIT 1
      ) spr ON TRUE
      WHERE p.status = 'live'
        AND u.account_status = 'active'
    `;
    const params = [];
    let i = 1;

    if (category && category !== 'all') {
      sql += ` AND p.category = $${i++}`;
      params.push(category);
    }
    if (search) {
      sql += ` AND p.name ILIKE $${i++}`;
      params.push(`%${search}%`);
    }
    if (min_price) {
      sql += ` AND p.price_per_unit >= $${i++}`;
      params.push(parseFloat(min_price));
    }
    if (max_price) {
      sql += ` AND p.price_per_unit <= $${i++}`;
      params.push(parseFloat(max_price));
    }
    if (barangay) {
      sql += ` AND COALESCE(fp.barangay, vp.barangay, p.barangay) ILIKE $${i++}`;
      params.push(`%${barangay}%`);
    }
    if (flash_sale === 'true') {
      sql += ` AND spr.original_price IS NOT NULL`;
    }

    const sortMap = {
      newest:     'p.created_at DESC',
      price_asc:  'p.price_per_unit ASC',
      price_desc: 'p.price_per_unit DESC',
      stock:      'p.stock_qty DESC',
      discount:   'spr.recommended_discount_pct DESC NULLS LAST',
    };
    sql += ` ORDER BY ${sortMap[sort] || sortMap.newest}`;

    const { rows } = await queryAsUser(req.user, sql, params);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('GET /marketplace/products', err);
    res.status(500).json({ success: false, message: 'Failed to load marketplace.' });
  }
});

// GET /api/marketplace/flash-sale
// Listings where the seller accepted a spoilage-driven price cut and the
// item is still live — surfaced separately so buyers see near-spoilage
// deals without having to dig through the full catalog.
router.get('/flash-sale', async (req, res) => {
  try {
    const { limit = 20 } = req.query;
    const { rows } = await queryAsUser(req.user, 
      `SELECT
          p.id, p.name, p.category, p.unit, p.price_per_unit, p.image_url, p.barangay,
          p.seller_id, p.seller_role,
          u.full_name AS seller_name,
          COALESCE(fp.barangay, vp.barangay, p.barangay) AS seller_barangay,
          fp.farm_name, vp.business_name,
          pss.stage AS spoilage_stage,
          pss.remaining_pct AS spoilage_remaining_pct,
          spr.original_price,
          spr.recommended_discount_pct,
          spr.responded_at AS sale_started_at,
          spr.source
       FROM spoilage_price_recommendations spr
       JOIN products p ON p.id = spr.product_id AND p.status = 'live'
       JOIN users u ON u.id = p.seller_id AND u.account_status = 'active'
       JOIN product_spoilage_status pss ON pss.product_id = p.id
       LEFT JOIN farmer_profiles fp ON fp.user_id = p.seller_id
       LEFT JOIN vendor_profiles  vp ON vp.user_id = p.seller_id
       WHERE spr.status = 'accepted'
       ORDER BY spr.recommended_discount_pct DESC, pss.remaining_pct ASC
       LIMIT $1`,
      [parseInt(limit)]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('GET /marketplace/flash-sale', err);
    res.status(500).json({ success: false, message: 'Failed to load flash sale listings.' });
  }
});

// GET /api/marketplace/products/:id
router.get('/products/:id', async (req, res) => {
  try {
    const { rows } = await queryAsUser(req.user, 
      `SELECT
          p.*,
          u.full_name   AS seller_name,
          u.phone_number AS seller_phone,
          COALESCE(fp.barangay, vp.barangay, p.barangay) AS seller_barangay,
          fp.farm_name, fp.farm_photo_url, fp.about_farm,
          vp.business_name, vp.business_photo_url, vp.about_business,
          spr.original_price AS flash_sale_original_price,
          spr.recommended_discount_pct AS flash_sale_discount_pct,
          spr.source AS flash_sale_source
       FROM products p
       JOIN users u ON u.id = p.seller_id
       LEFT JOIN farmer_profiles fp ON fp.user_id = p.seller_id
       LEFT JOIN vendor_profiles  vp ON vp.user_id = p.seller_id
       LEFT JOIN LATERAL (
         SELECT original_price, recommended_discount_pct, source
         FROM spoilage_price_recommendations
         WHERE product_id = p.id AND status = 'accepted'
         ORDER BY created_at DESC LIMIT 1
       ) spr ON TRUE
       WHERE p.id = $1 AND p.status = 'live' AND u.account_status = 'active'`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'Product not found.' });

    // Real, new signal for the recommendation system: only buyers'
    // views count (a farmer/vendor browsing the marketplace, e.g.
    // checking a competitor's pricing, isn't a buying-interest signal
    // the same way). Fire-and-forget on purpose -- a logging failure
    // here should never break the actual product page from loading.
    if (req.user.role === 'buyer') {
      queryAsUser(req.user,
        `INSERT INTO product_views (buyer_id, product_id, category) VALUES ($1, $2, $3)`,
        [req.user.id, rows[0].id, rows[0].category]
      ).catch((err) => console.error('product_views insert failed (non-fatal)', err));
    }

    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('GET /marketplace/products/:id', err);
    res.status(500).json({ success: false, message: 'Failed to load product.' });
  }
});

module.exports = router;

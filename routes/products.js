// backend/routes/products.js
const express   = require('express');
const { queryAsUser } = require('../config/database');
const { authenticate, authorize, requireVerified } = require('../middleware/auth');
const multer    = require('multer');
const path      = require('path');
const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');
const { estimateShelfLifeDays } = require('../utils/shelfLifeEstimator');

const router = express.Router();
router.use(authenticate);
router.use(authorize('farmer', 'vendor'));

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    const ok = /jpeg|jpg|png|webp/.test(path.extname(file.originalname).toLowerCase());
    cb(ok ? null : new Error('Images only'), ok);
  },
});

// ── Helper: upload photo to Supabase ─────────────────────────────────────────
async function uploadPhoto(buffer, mimetype, filePath) {
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { realtime: { transport: WebSocket } }
  );
  const { error } = await supabase.storage
    .from('nagaguno-uploads')
    .upload(filePath, buffer, { contentType: mimetype, upsert: true });

  if (error) throw new Error(`Photo upload failed: ${error.message}`);

  const { data: { publicUrl } } = supabase.storage
    .from('nagaguno-uploads')
    .getPublicUrl(filePath);
  return publicUrl;
}

// GET /api/products — my own listings
router.get('/', async (req, res) => {
  try {
    const { id } = req.user;
    const { status } = req.query;

    let sql = `
      SELECT id, name, description, category, unit,
             price_per_unit, stock_qty, image_url, status, barangay, created_at,
             harvested_at, auto_hidden_reason
      FROM products
      WHERE seller_id = $1 AND status != 'deleted'
    `;
    const params = [id];

    if (status) {
      sql += ` AND status = $2`;
      params.push(status);
    }
    sql += ` ORDER BY created_at DESC`;

    const { rows } = await queryAsUser(req.user, sql, params);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('GET /products', err);
    res.status(500).json({ success: false, message: 'Failed to load products.' });
  }
});

// POST /api/products — add product
router.post('/', requireVerified, upload.single('photo'), async (req, res) => {
  try {
    const { id: seller_id, role: seller_role } = req.user;
    const { name, description, category, unit, price_per_unit, stock_qty, harvested_at } = req.body;

    if (!name || !category || !price_per_unit) {
      return res.status(400).json({
        success: false,
        message: 'Name, category, and price are required.',
      });
    }

    if (!req.file || req.file.size === 0) {
      return res.status(400).json({
        success: false,
        message: 'Please upload a product photo before adding this listing.',
      });
    }

    // Auto-pull barangay from the seller's users row
    const { rows: userRows } = await queryAsUser(req.user, 
      'SELECT barangay FROM users WHERE id = $1',
      [seller_id]
    );
    const barangay = userRows[0]?.barangay ?? null;

    if (!barangay) {
      return res.status(400).json({
        success: false,
        message: 'Please set your barangay in your profile before listing products.',
      });
    }

    const ext = path.extname(req.file.originalname).toLowerCase();
    const filePath = `products/product-${seller_id}-${Date.now()}${ext}`;
    const image_url = await uploadPhoto(req.file.buffer, req.file.mimetype, filePath);
    if (!image_url?.trim()) {
      throw new Error('Photo upload did not return an image URL.');
    }

    const { rows } = await queryAsUser(req.user, 
      `INSERT INTO products
         (seller_id, seller_role, name, description, category,
          unit, price_per_unit, stock_qty, image_url, barangay,
          shelf_life_days, harvested_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,COALESCE($12, NOW()))
       RETURNING *`,
      [
        seller_id,
        seller_role,
        name,
        description  || null,
        category,
        unit         || 'kg',
        parseFloat(price_per_unit),
        parseFloat(stock_qty || 0),
        image_url,
        barangay,
        estimateShelfLifeDays(name, category),
        // Real, new feature: the seller can now specify when the
        // produce was actually harvested, rather than the system
        // always assuming harvest = the moment it was listed. A
        // farmer who harvests Monday but doesn't post until Friday
        // was previously shown as if freshly harvested that Friday,
        // understating real spoilage risk by several days.
        harvested_at || null,
      ]
    );

    res.status(201).json({ success: true, data: rows[0], message: 'Product added successfully.' });
  } catch (err) {
    console.error('POST /products', err);
    res.status(500).json({ success: false, message: 'Failed to add product.' });
  }
});

// PATCH /api/products/:id — edit product
router.patch('/:id', upload.single('photo'), async (req, res) => {
  try {
    const { id: sellerId } = req.user;
    const { id }           = req.params;
    const { name, description, category, unit, price_per_unit, stock_qty, harvested_at } = req.body;

    const existing = await queryAsUser(req.user, 
      'SELECT * FROM products WHERE id = $1 AND seller_id = $2',
      [id, sellerId]
    );
    if (!existing.rows.length) {
      return res.status(404).json({ success: false, message: 'Product not found.' });
    }

    let image_url = existing.rows[0].image_url;
    if (req.file) {
      const ext      = path.extname(req.file.originalname).toLowerCase();
      const filePath = `products/product-${sellerId}-${Date.now()}${ext}`;
      image_url = await uploadPhoto(req.file.buffer, req.file.mimetype, filePath);
    }

    const { rows } = await queryAsUser(req.user, 
      `UPDATE products
       SET name           = COALESCE($1, name),
           description    = COALESCE($2, description),
           category       = COALESCE($3, category),
           unit           = COALESCE($4, unit),
           price_per_unit = COALESCE($5, price_per_unit),
           stock_qty      = COALESCE($6, stock_qty),
           image_url      = COALESCE($7, image_url),
           harvested_at   = COALESCE($8, harvested_at)
       WHERE id = $9 AND seller_id = $10
       RETURNING *`,
      [
        name           || null,
        description    || null,
        category       || null,
        unit           || null,
        price_per_unit ? parseFloat(price_per_unit) : null,
        stock_qty      ? parseFloat(stock_qty)      : null,
        image_url,
        harvested_at   || null,
        id,
        sellerId,
      ]
    );

    res.json({ success: true, data: rows[0], message: 'Product updated.' });
  } catch (err) {
    console.error('PATCH /products/:id', err);
    res.status(500).json({ success: false, message: 'Failed to update product.' });
  }
});

// PATCH /api/products/:id/toggle — live/hidden toggle
router.patch('/:id/toggle', async (req, res) => {
  try {
    const { id: sellerId } = req.user;
    const { id }           = req.params;

    const { rows } = await queryAsUser(req.user, 
      `UPDATE products
       SET status = (CASE WHEN status::text = 'live' THEN 'hidden' ELSE 'live' END)::product_status,
           auto_hidden_reason = NULL
       WHERE id = $1 AND seller_id = $2
       RETURNING id, status`,
      [id, sellerId]
    );

    if (!rows.length) {
      return res.status(404).json({ success: false, message: 'Product not found.' });
    }

    res.json({
      success: true,
      data:    rows[0],
      message: rows[0].status === 'live'
        ? 'Product is now live on marketplace.'
        : 'Product hidden from marketplace.',
    });
  } catch (err) {
    console.error('PATCH /products/:id/toggle', err);
    res.status(500).json({ success: false, message: 'Failed to toggle product.' });
  }
});

// DELETE /api/products/:id — soft delete
router.delete('/:id', async (req, res) => {
  try {
    const { id: sellerId } = req.user;
    const { id }           = req.params;

    const { rows } = await queryAsUser(req.user, 
      `UPDATE products SET status = 'deleted'
       WHERE id = $1 AND seller_id = $2
       RETURNING id`,
      [id, sellerId]
    );
    if (!rows.length) {
      return res.status(404).json({ success: false, message: 'Product not found.' });
    }

    res.json({ success: true, message: 'Product deleted.' });
  } catch (err) {
    console.error('DELETE /products/:id', err);
    res.status(500).json({ success: false, message: 'Failed to delete product.' });
  }
});

module.exports = router;

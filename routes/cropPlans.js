// // backend/routes/cropPlans.js
// const express   = require('express');
// const { queryAsUser } = require('../config/database');
// const { authenticate, authorize, requireVerified } = require('../middleware/auth');
// const multer    = require('multer');
// const path      = require('path');
// const { createClient } = require('@supabase/supabase-js');
// const WebSocket = require('ws');

// const router = express.Router();
// router.use(authenticate);
// router.use(authorize('farmer'));

// const upload = multer({
//   storage: multer.memoryStorage(),
//   limits:  { fileSize: 5 * 1024 * 1024 },
//   fileFilter: (_, file, cb) => {
//     const ok = /jpeg|jpg|png|webp/.test(path.extname(file.originalname).toLowerCase());
//     cb(ok ? null : new Error('Images only'), ok);
//   },
// });

// // ── Helper: upload photo to Supabase ────────────────────────────────────────
// async function uploadPhoto(buffer, mimetype, filename) {
//   const supabase = createClient(
//     process.env.SUPABASE_URL,
//     process.env.SUPABASE_SERVICE_ROLE_KEY,
//     { realtime: { transport: WebSocket } }
//   );
//   const filePath = `crop-photos/${filename}`;
//   await supabase.storage
//     .from('nagaguno-uploads')
//     .upload(filePath, buffer, { contentType: mimetype, upsert: true });
//   const { data: { publicUrl } } = supabase.storage
//     .from('nagaguno-uploads')
//     .getPublicUrl(filePath);
//   return publicUrl;
// }

// // ── Helper: get farmer's barangay from users table ───────────────────────────
// async function getFarmerBarangay(user) {
//   const { rows } = await queryAsUser(user,
//     'SELECT barangay FROM users WHERE id = $1',
//     [user.id]
//   );
//   return rows[0]?.barangay ?? null;
// }

// // GET /api/production
// router.get('/', async (req, res) => {
//   try {
//     const { stage } = req.query;
//     let sql = `
//       SELECT *,
//         (expected_harvest - CURRENT_DATE) AS days_remaining
//       FROM crop_plans
//       WHERE farmer_id = $1
//     `;
//     const params = [req.user.id];
//     if (stage) { sql += ` AND stage = $2`; params.push(stage); }
//     sql += ` ORDER BY expected_harvest ASC`;
//     const { rows } = await queryAsUser(req.user, sql, params);
//     res.json({ success: true, data: rows });
//   } catch (err) {
//     console.error('GET /production', err);
//     res.status(500).json({ success: false, message: 'Failed to load crop plans.' });
//   }
// });

// // POST /api/production
// // Accepts: name, category, quantity, unit, field_location,
// //          planting_date, expected_harvest_date, notes, photo (file)
// // barangay is pulled automatically from the farmer's users row
// router.post('/', requireVerified, upload.single('photo'), async (req, res) => {
//   try {
//     const {
//       name,                  // from fprod.jsx form
//       category,
//       quantity,
//       unit,
//       field_location,
//       planting_date,
//       expected_harvest_date, // from fprod.jsx form
//       notes,
//     } = req.body;

//     // Validate required fields
//     if (!name || !quantity || !field_location || !planting_date || !expected_harvest_date) {
//       return res.status(400).json({
//         success: false,
//         message: 'name, quantity, field_location, planting_date, and expected_harvest_date are required.',
//       });
//     }
//     if (expected_harvest_date <= planting_date) {
//       return res.status(400).json({
//         success: false,
//         message: 'Harvest date must be after planting date.',
//       });
//     }

//     // Auto-fill barangay from farmer's profile — never from request body
//     const barangay = await getFarmerBarangay(req.user);

//     // Upload photo if provided
//     let image_url = null;
//     if (req.file) {
//       const ext      = path.extname(req.file.originalname).toLowerCase();
//       const filename = `crop-${req.user.id}-${Date.now()}${ext}`;
//       image_url = await uploadPhoto(req.file.buffer, req.file.mimetype, filename);
//     }

//     const { rows } = await queryAsUser(req.user, 
//       `INSERT INTO crop_plans
//          (farmer_id, crop_name, category, quantity_kg, unit,
//           field_location, barangay, planting_date, expected_harvest,
//           notes, image_url, stage)
//        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'planted')
//        RETURNING *`,
//       [
//         req.user.id,
//         name,
//         category   || 'others',
//         parseFloat(quantity),
//         unit       || 'kg',
//         field_location,
//         barangay,
//         planting_date,
//         expected_harvest_date,  // maps to expected_harvest column
//         notes      || null,
//         image_url,
//       ]
//     );

//     res.status(201).json({ success: true, data: rows[0], message: 'Crop plan added.' });
//   } catch (err) {
//     console.error('POST /production', err);
//     res.status(500).json({ success: false, message: 'Failed to add crop plan.' });
//   }
// });

// // PATCH /api/production/:id
// router.patch('/:id', upload.single('photo'), async (req, res) => {
//   try {
//     const {
//       name, category, quantity, unit,
//       field_location, planting_date,
//       expected_harvest_date, stage, notes,
//     } = req.body;

//     // Ownership check
//     const check = await queryAsUser(req.user, 
//       'SELECT id, image_url FROM crop_plans WHERE id = $1 AND farmer_id = $2',
//       [req.params.id, req.user.id]
//     );
//     if (!check.rows.length) {
//       return res.status(404).json({ success: false, message: 'Crop plan not found.' });
//     }

//     // Upload new photo if provided
//     let image_url = check.rows[0].image_url;
//     if (req.file) {
//       const ext      = path.extname(req.file.originalname).toLowerCase();
//       const filename = `crop-${req.user.id}-${req.params.id}${ext}`;
//       image_url = await uploadPhoto(req.file.buffer, req.file.mimetype, filename);
//     }

//     const { rows } = await queryAsUser(req.user, 
//       `UPDATE crop_plans
//        SET crop_name        = COALESCE($1,  crop_name),
//            category         = COALESCE($2,  category),
//            quantity_kg      = COALESCE($3,  quantity_kg),
//            unit             = COALESCE($4,  unit),
//            field_location   = COALESCE($5,  field_location),
//            planting_date    = COALESCE($6,  planting_date),
//            expected_harvest = COALESCE($7,  expected_harvest),
//            stage            = COALESCE($8,  stage),
//            notes            = COALESCE($9,  notes),
//            image_url        = COALESCE($10, image_url)
//        WHERE id = $11 AND farmer_id = $12
//        RETURNING *`,
//       [
//         name                 || null,
//         category             || null,
//         quantity ? parseFloat(quantity) : null,
//         unit                 || null,
//         field_location       || null,
//         planting_date        || null,
//         expected_harvest_date|| null,
//         stage                || null,
//         notes                || null,
//         image_url,
//         req.params.id,
//         req.user.id,
//       ]
//     );

//     res.json({ success: true, data: rows[0], message: 'Crop plan updated.' });
//   } catch (err) {
//     console.error('PATCH /production/:id', err);
//     res.status(500).json({ success: false, message: 'Failed to update crop plan.' });
//   }
// });

// // DELETE /api/production/:id
// router.delete('/:id', async (req, res) => {
//   try {
//     const { rows } = await queryAsUser(req.user, 
//       'DELETE FROM crop_plans WHERE id = $1 AND farmer_id = $2 RETURNING id',
//       [req.params.id, req.user.id]
//     );
//     if (!rows.length) {
//       return res.status(404).json({ success: false, message: 'Crop plan not found.' });
//     }
//     res.json({ success: true, message: 'Crop plan deleted.' });
//   } catch (err) {
//     console.error('DELETE /production/:id', err);
//     res.status(500).json({ success: false, message: 'Failed to delete crop plan.' });
//   }
// });

// module.exports = router;

//NEW------------------------------------------------------------------------------------------
// backend/routes/cropPlans.js
const express   = require('express');
// Real fix: 'query' (the privileged, non-RLS connection) is imported
// alongside queryAsUser specifically for the new /public endpoint
// below. The crop_plans table's real RLS policy
// (crop_plans_owner_or_admin) restricts ALL access to
// farmer_id = app_current_user_id() or admin -- correct for the
// private "My Production" feature, but it meant a buyer using
// queryAsUser genuinely got zero rows for every other farmer's crop
// plan, regardless of this endpoint's own WHERE clause, since RLS
// applies before that filter ever matters. This is a deliberate,
// legitimate exception (same reasoning as why marketplace/products
// endpoints already let buyers see other people's live listings),
// not a security bypass of anything meant to stay private -- only
// this one explicitly public endpoint uses it.
const { queryAsUser, query } = require('../config/database');
const { authenticate, authorize, requireVerified } = require('../middleware/auth');
const multer    = require('multer');
const path      = require('path');
const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');

const router = express.Router();
router.use(authenticate);

// GET /api/production/public — Real, new endpoint: lets ANY
// authenticated user (buyer, vendor, farmer) browse upcoming crop
// plans across all farmers, not just their own. Deliberately
// registered here, between authenticate and the farmer-only
// authorize() below -- Express matches this route directly without
// ever reaching that gate, so it stays open to every role while
// every other route in this file remains farmer-only, unchanged.
// This is what actually makes the "reserve a future harvest" version
// of Smart Agreements possible: previously a crop plan was only ever
// visible to the farmer who created it, so a buyer had no way to
// even find one to request against.
router.get('/public', async (req, res) => {
  try {
    const { category, barangay } = req.query;
    let sql = `
      SELECT cp.id, cp.crop_name, cp.category, cp.quantity_kg, cp.unit,
             cp.field_location, cp.barangay, cp.planting_date,
             cp.expected_harvest, cp.stage, cp.image_url,
             (cp.expected_harvest - CURRENT_DATE) AS days_remaining,
             u.id AS farmer_id, u.full_name AS farmer_name, u.phone_number AS farmer_phone,
             fp.farm_name, fp.farm_photo_url
      FROM crop_plans cp
      JOIN users u ON u.id = cp.farmer_id
      LEFT JOIN farmer_profiles fp ON fp.user_id = cp.farmer_id
      WHERE cp.stage != 'done'
        AND cp.expected_harvest >= CURRENT_DATE
    `;
    const params = [];
    if (category) { params.push(category); sql += ` AND cp.category = $${params.length}`; }
    if (barangay) { params.push(barangay); sql += ` AND cp.barangay = $${params.length}`; }
    sql += ` ORDER BY cp.expected_harvest ASC`;

    const { rows } = await query(sql, params);

    // Real, new feature: applies the same real-data-driven weighted
    // heuristic already used for Marketplace recommendations
    // (recommendationService.js), adapted since a crop plan has no
    // sales history to score popularity from yet -- category match
    // to the buyer's own past purchases is the first signal, same as
    // before; how soon the harvest is stands in for "popularity"
    // here, since a sooner, actionable reservation is more relevant
    // than one many months out. Same honest limitation as the
    // Marketplace version: a real, simple formula on real data, not
    // a trained model.
    const { rows: purchasedCategories } = await query(
      `SELECT DISTINCT p.category
       FROM orders o
       JOIN order_items oi ON oi.order_id = o.id
       JOIN products p ON p.id = oi.product_id
       WHERE o.buyer_id = $1`,
      [req.user.id]
    );
    const preferredCategories = new Set(purchasedCategories.map((r) => r.category.toLowerCase()));
    const maxDays = Math.max(1, ...rows.map((r) => Number(r.days_remaining)));

    const scored = rows.map((r) => ({
      ...r,
      // Real fix: crop_plans.category isn't consistently capitalized
      // the same way products.category is (confirmed directly
      // against real data this session -- "vegetables" vs
      // "Vegetables" for genuinely the same category) -- comparing
      // case-insensitively avoids silently missing a real match
      // purely due to that inconsistency.
      recommendation_score:
        (preferredCategories.has(r.category.toLowerCase()) ? 0.5 : 0) +
        0.5 * (1 - Number(r.days_remaining) / maxDays),
    }));
    scored.sort((a, b) => b.recommendation_score - a.recommendation_score);

    res.json({ success: true, data: scored });
  } catch (err) {
    console.error('GET /production/public', err);
    res.status(500).json({ success: false, message: 'Failed to load upcoming crops.' });
  }
});

router.use(authorize('farmer'));

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    const ok = /jpeg|jpg|png|webp/.test(path.extname(file.originalname).toLowerCase());
    cb(ok ? null : new Error('Images only'), ok);
  },
});

// ── Helper: upload photo to Supabase ────────────────────────────────────────
async function uploadPhoto(buffer, mimetype, filename) {
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { realtime: { transport: WebSocket } }
  );
  const filePath = `crop-photos/${filename}`;
  await supabase.storage
    .from('nagaguno-uploads')
    .upload(filePath, buffer, { contentType: mimetype, upsert: true });
  const { data: { publicUrl } } = supabase.storage
    .from('nagaguno-uploads')
    .getPublicUrl(filePath);
  return publicUrl;
}

// ── Helper: get farmer's barangay from users table ───────────────────────────
async function getFarmerBarangay(user) {
  const { rows } = await queryAsUser(user,
    'SELECT barangay FROM users WHERE id = $1',
    [user.id]
  );
  return rows[0]?.barangay ?? null;
}

// GET /api/production
router.get('/', async (req, res) => {
  try {
    const { stage } = req.query;
    let sql = `
      SELECT *,
        (expected_harvest - CURRENT_DATE) AS days_remaining
      FROM crop_plans
      WHERE farmer_id = $1
    `;
    const params = [req.user.id];
    if (stage) { sql += ` AND stage = $2`; params.push(stage); }
    sql += ` ORDER BY expected_harvest ASC`;
    const { rows } = await queryAsUser(req.user, sql, params);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('GET /production', err);
    res.status(500).json({ success: false, message: 'Failed to load crop plans.' });
  }
});

// POST /api/production
// Accepts: name, category, quantity, unit, field_location,
//          planting_date, expected_harvest_date, notes, photo (file)
// barangay is pulled automatically from the farmer's users row
router.post('/', requireVerified, upload.single('photo'), async (req, res) => {
  try {
    const {
      name,                  // from fprod.jsx form
      category,
      quantity,
      unit,
      field_location,
      planting_date,
      expected_harvest_date, // from fprod.jsx form
      notes,
    } = req.body;

    // Validate required fields
    if (!name || !quantity || !field_location || !planting_date || !expected_harvest_date) {
      return res.status(400).json({
        success: false,
        message: 'name, quantity, field_location, planting_date, and expected_harvest_date are required.',
      });
    }
    if (expected_harvest_date <= planting_date) {
      return res.status(400).json({
        success: false,
        message: 'Harvest date must be after planting date.',
      });
    }

    // Auto-fill barangay from farmer's profile — never from request body
    const barangay = await getFarmerBarangay(req.user);

    // Upload photo if provided
    let image_url = null;
    if (req.file) {
      const ext      = path.extname(req.file.originalname).toLowerCase();
      const filename = `crop-${req.user.id}-${Date.now()}${ext}`;
      image_url = await uploadPhoto(req.file.buffer, req.file.mimetype, filename);
    }

    const { rows } = await queryAsUser(req.user, 
      `INSERT INTO crop_plans
         (farmer_id, crop_name, category, quantity_kg, unit,
          field_location, barangay, planting_date, expected_harvest,
          notes, image_url, stage)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'planted')
       RETURNING *`,
      [
        req.user.id,
        name,
        category   || 'others',
        parseFloat(quantity),
        unit       || 'kg',
        field_location,
        barangay,
        planting_date,
        expected_harvest_date,  // maps to expected_harvest column
        notes      || null,
        image_url,
      ]
    );

    res.status(201).json({ success: true, data: rows[0], message: 'Crop plan added.' });
  } catch (err) {
    console.error('POST /production', err);
    res.status(500).json({ success: false, message: 'Failed to add crop plan.' });
  }
});

// PATCH /api/production/:id
router.patch('/:id', upload.single('photo'), async (req, res) => {
  try {
    const {
      name, category, quantity, unit,
      field_location, planting_date,
      expected_harvest_date, stage, notes,
    } = req.body;

    // Ownership check
    const check = await queryAsUser(req.user, 
      'SELECT id, image_url FROM crop_plans WHERE id = $1 AND farmer_id = $2',
      [req.params.id, req.user.id]
    );
    if (!check.rows.length) {
      return res.status(404).json({ success: false, message: 'Crop plan not found.' });
    }

    // Upload new photo if provided
    let image_url = check.rows[0].image_url;
    if (req.file) {
      const ext      = path.extname(req.file.originalname).toLowerCase();
      const filename = `crop-${req.user.id}-${req.params.id}${ext}`;
      image_url = await uploadPhoto(req.file.buffer, req.file.mimetype, filename);
    }

    const { rows } = await queryAsUser(req.user, 
      `UPDATE crop_plans
       SET crop_name        = COALESCE($1,  crop_name),
           category         = COALESCE($2,  category),
           quantity_kg      = COALESCE($3,  quantity_kg),
           unit             = COALESCE($4,  unit),
           field_location   = COALESCE($5,  field_location),
           planting_date    = COALESCE($6,  planting_date),
           expected_harvest = COALESCE($7,  expected_harvest),
           stage            = COALESCE($8,  stage),
           notes            = COALESCE($9,  notes),
           image_url        = COALESCE($10, image_url)
       WHERE id = $11 AND farmer_id = $12
       RETURNING *`,
      [
        name                 || null,
        category             || null,
        quantity ? parseFloat(quantity) : null,
        unit                 || null,
        field_location       || null,
        planting_date        || null,
        expected_harvest_date|| null,
        stage                || null,
        notes                || null,
        image_url,
        req.params.id,
        req.user.id,
      ]
    );

    res.json({ success: true, data: rows[0], message: 'Crop plan updated.' });
  } catch (err) {
    console.error('PATCH /production/:id', err);
    res.status(500).json({ success: false, message: 'Failed to update crop plan.' });
  }
});

// DELETE /api/production/:id
router.delete('/:id', async (req, res) => {
  try {
    const { rows } = await queryAsUser(req.user, 
      'DELETE FROM crop_plans WHERE id = $1 AND farmer_id = $2 RETURNING id',
      [req.params.id, req.user.id]
    );
    if (!rows.length) {
      return res.status(404).json({ success: false, message: 'Crop plan not found.' });
    }
    res.json({ success: true, message: 'Crop plan deleted.' });
  } catch (err) {
    console.error('DELETE /production/:id', err);
    res.status(500).json({ success: false, message: 'Failed to delete crop plan.' });
  }
});

module.exports = router;
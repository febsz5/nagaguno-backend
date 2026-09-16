// backend/routes/profile.js
const express   = require('express');
const { queryAsUser } = require('../config/database');
const { authenticate } = require('../middleware/auth');
const multer    = require('multer');
const path      = require('path');

const router = express.Router();
router.use(authenticate);

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    const ok = /jpeg|jpg|png|webp/.test(path.extname(file.originalname).toLowerCase());
    cb(ok ? null : new Error('Images only'), ok);
  },
});

async function getRoleProfile(user) {
  const tables = {
    buyer:  'buyer_profiles',
    farmer: 'farmer_profiles',
    vendor: 'vendor_profiles',
  };
  const table = tables[user.role];
  if (!table) return null;
  const { rows } = await queryAsUser(user, `SELECT * FROM ${table} WHERE user_id = $1`, [user.id]);
  return rows[0] ?? null;
}

// GET /api/profiles/me
router.get('/me', async (req, res) => {
  try {
    const { id, role } = req.user;
    const { rows } = await queryAsUser(req.user,
      `SELECT id, full_name, email, phone_number, barangay, street_address,
              avatar_url, role, account_status, created_at
       FROM users WHERE id = $1`, [id]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'User not found.' });
    const profile = await getRoleProfile(req.user);
    res.json({ success: true, data: { user: rows[0], profile } });
  } catch (err) {
    console.error('GET /profiles/me', err);
    res.status(500).json({ success: false, message: 'Failed to load profile.' });
  }
});

// PATCH /api/profiles/me
router.patch('/me', async (req, res) => {
  try {
    const { id, role } = req.user;
    const {
      full_name, phone_number, barangay, street_address,
      about_me, email,
      farm_name, farm_address, about_farm,
      business_name, business_address, about_business,
    } = req.body;

    // Real, new feature: email was never editable here at all.
    // Since it's the login identifier and genuinely unique at the
    // DB level (users_email_key), format-validate it here so a bad
    // address fails clearly, and catch the real unique-constraint
    // violation below to return a friendly message instead of a
    // raw 500.
    if (email !== undefined && email !== null) {
      const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailPattern.test(email)) {
        return res.status(400).json({ success: false, message: 'Please enter a valid email address.' });
      }
    }

    await queryAsUser(req.user,
      `UPDATE users
       SET full_name      = COALESCE($1, full_name),
           phone_number   = COALESCE($2, phone_number),
           barangay       = COALESCE($3, barangay),
           street_address = COALESCE($4, street_address),
           email          = COALESCE($5, email)
       WHERE id = $6`,
      [full_name || null, phone_number || null, barangay || null, street_address || null, email || null, id]
    );

    if (role === 'buyer') {
      await queryAsUser(req.user,
        `UPDATE buyer_profiles SET about_me = $1 WHERE user_id = $2`,
        [about_me ?? null, id]
      );
    }
    if (role === 'farmer') {
      await queryAsUser(req.user,
        `UPDATE farmer_profiles
         SET farm_name    = COALESCE($1, farm_name),
             farm_address = COALESCE($2, farm_address),
             about_farm   = COALESCE($3, about_farm),
             barangay     = COALESCE($4, barangay)
         WHERE user_id = $5`,
        [farm_name || null, farm_address || null, about_farm || null, barangay || null, id]
      );
    }
    if (role === 'vendor') {
      await queryAsUser(req.user,
        `UPDATE vendor_profiles
         SET business_name    = COALESCE($1, business_name),
             business_address = COALESCE($2, business_address),
             about_business   = COALESCE($3, about_business),
             barangay         = COALESCE($4, barangay)
         WHERE user_id = $5`,
        [business_name || null, business_address || null,
         about_business || null, barangay || null, id]
      );
    }

    res.json({ success: true, message: 'Profile updated successfully.' });
  } catch (err) {
    console.error('PATCH /profiles/me', err);
    if (err.code === '23505' && err.constraint === 'users_email_key') {
      return res.status(409).json({ success: false, message: 'This email is already in use by another account.' });
    }
    res.status(500).json({ success: false, message: 'Failed to update profile.' });
  }
});

// POST /api/profiles/me/photo
router.post('/me/photo', upload.single('photo'), async (req, res) => {
  try {
    const { id, role } = req.user;
    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded.' });

    const { createClient } = require('@supabase/supabase-js');
    const WebSocket = require('ws');
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { realtime: { transport: WebSocket } }
    );

    const ext      = path.extname(req.file.originalname).toLowerCase();
    const fileName = `${role}-${id}-${Date.now()}${ext}`;
    const bucket   = 'nagaguno-uploads';

    const { error: uploadError } = await supabase.storage
      .from(bucket)
      .upload(`photos/${fileName}`, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: true,
      });
    if (uploadError) throw uploadError;

    const { data: { publicUrl } } = supabase.storage
      .from(bucket)
      .getPublicUrl(`photos/${fileName}`);

    if (role === 'buyer') {
      await queryAsUser(req.user, `UPDATE users SET avatar_url = $1 WHERE id = $2`, [publicUrl, id]);
    } else if (role === 'farmer') {
      await queryAsUser(req.user, `UPDATE farmer_profiles SET farm_photo_url = $1 WHERE user_id = $2`, [publicUrl, id]);
    } else if (role === 'vendor') {
      await queryAsUser(req.user, `UPDATE vendor_profiles SET business_photo_url = $1 WHERE user_id = $2`, [publicUrl, id]);
    }

    res.json({ success: true, data: { url: publicUrl }, message: 'Photo updated.' });
  } catch (err) {
    console.error('POST /profiles/me/photo', err);
    res.status(500).json({ success: false, message: 'Failed to upload photo.' });
  }
});

// GET /api/profiles/farmers — public farmer list
router.get('/farmers', async (req, res) => {
  try {
    const { rows } = await queryAsUser(req.user,
      `SELECT u.id, u.full_name, u.barangay,
              fp.farm_name, fp.farm_photo_url, fp.about_farm,
              COUNT(DISTINCT p.id) AS product_count
       FROM users u
       JOIN farmer_profiles fp ON fp.user_id = u.id
       LEFT JOIN products p ON p.seller_id = u.id AND p.status = 'live'
       WHERE u.role = 'farmer' AND u.account_status = 'active'
       GROUP BY u.id, u.full_name, u.barangay,
                fp.farm_name, fp.farm_photo_url, fp.about_farm
       ORDER BY u.full_name ASC`
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('GET /profiles/farmers', err);
    res.status(500).json({ success: false, message: 'Failed to load farmers.' });
  }
});

// GET /api/profiles/farmers/saved — buyer's own saved farmers list.
// MUST be registered before GET /farmers/:id below -- Express matches
// routes in registration order, and without this ordering, a request
// to /farmers/saved would incorrectly match /farmers/:id with
// id='saved' instead of this handler. Caught before this ever shipped
// in the wrong order, not discovered as a live bug.
router.get('/farmers/saved', async (req, res) => {
  try {
    if (req.user.role !== 'buyer') {
      return res.json({ success: true, data: [] });
    }
    const { rows } = await queryAsUser(req.user,
      `SELECT u.id, u.full_name, u.barangay, fp.farm_name, fp.farm_photo_url, fp.about_farm
       FROM saved_farmers sf
       JOIN users u ON u.id = sf.farmer_id
       JOIN farmer_profiles fp ON fp.user_id = u.id
       WHERE sf.buyer_id = $1
       ORDER BY sf.created_at DESC`,
      [req.user.id]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('GET /profiles/farmers/saved', err);
    res.status(500).json({ success: false, message: 'Failed to load saved farmers.' });
  }
});

// GET /api/profiles/farmers/:id — public farmer detail
router.get('/farmers/:id', async (req, res) => {
  try {
    const { rows } = await queryAsUser(req.user,
      `SELECT u.id, u.full_name, u.barangay, u.phone_number,
              fp.farm_name, fp.farm_photo_url, fp.farm_address, fp.about_farm
       FROM users u
       JOIN farmer_profiles fp ON fp.user_id = u.id
       WHERE u.id = $1 AND u.role = 'farmer' AND u.account_status = 'active'`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'Farmer not found.' });

    const { rows: products } = await queryAsUser(req.user,
      `SELECT id, name, category, unit, price_per_unit, stock_qty, image_url
       FROM products WHERE seller_id = $1 AND status = 'live'
       ORDER BY created_at DESC`,
      [req.params.id]
    );
    res.json({ success: true, data: { ...rows[0], products } });
  } catch (err) {
    console.error('GET /profiles/farmers/:id', err);
    res.status(500).json({ success: false, message: 'Failed to load farmer.' });
  }
});

// GET /api/profiles/preferences — has the current user completed onboarding, and what did they select
router.get('/preferences', async (req, res) => {
  try {
    const { id, role } = req.user;
    const tables = { buyer: 'buyer_profiles', farmer: 'farmer_profiles', vendor: 'vendor_profiles' };
    const table = tables[role];
    if (!table) return res.status(400).json({ success: false, message: 'No preferences apply to this role.' });

    const { rows } = await queryAsUser(req.user,
      `SELECT preference_onboarding_completed, selected_categories${role === 'buyer' ? ', price_preference, recommendation_priority' : ''}
       FROM ${table} WHERE user_id = $1`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'Profile not found.' });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('GET /profiles/preferences', err);
    res.status(500).json({ success: false, message: 'Failed to load preferences.' });
  }
});

// PATCH /api/profiles/preferences — submit or update onboarding preferences
router.patch('/preferences', async (req, res) => {
  try {
    const { id, role } = req.user;
    const { selected_categories, price_preference, recommendation_priority } = req.body;

    if (!Array.isArray(selected_categories) || selected_categories.length === 0) {
      return res.status(400).json({ success: false, message: 'Select at least one category.' });
    }

    const tables = { buyer: 'buyer_profiles', farmer: 'farmer_profiles', vendor: 'vendor_profiles' };
    const table = tables[role];
    if (!table) return res.status(400).json({ success: false, message: 'No preferences apply to this role.' });

    // Only buyer_profiles has price_preference/recommendation_priority
    // columns (verified against migration 004) — farmer/vendor updates
    // deliberately only ever touch the two columns that exist on
    // every role's table, never referencing the buyer-only ones.
    const sql = role === 'buyer'
      ? `UPDATE ${table}
         SET preference_onboarding_completed = true,
             selected_categories = $1,
             price_preference = $2,
             recommendation_priority = $3
         WHERE user_id = $4 RETURNING *`
      : `UPDATE ${table}
         SET preference_onboarding_completed = true,
             selected_categories = $1
         WHERE user_id = $2 RETURNING *`;
    const params = role === 'buyer'
      ? [selected_categories, price_preference || null, recommendation_priority || null, id]
      : [selected_categories, id];

    const { rows } = await queryAsUser(req.user, sql, params);
    if (!rows.length) return res.status(404).json({ success: false, message: 'Profile not found.' });
    res.json({ success: true, data: rows[0], message: 'Preferences saved.' });
  } catch (err) {
    console.error('PATCH /profiles/preferences', err);
    res.status(500).json({ success: false, message: 'Failed to save preferences.' });
  }
});

// POST /api/profiles/farmers/:id/save — buyer saves a farmer
router.post('/farmers/:id/save', async (req, res) => {
  try {
    if (req.user.role !== 'buyer') {
      return res.status(403).json({ success: false, message: 'Only buyers can save farmers.' });
    }
    if (req.user.id === req.params.id) {
      return res.status(400).json({ success: false, message: 'You can\'t save yourself.' });
    }
    await queryAsUser(req.user,
      `INSERT INTO saved_farmers (buyer_id, farmer_id) VALUES ($1, $2)
       ON CONFLICT (buyer_id, farmer_id) DO NOTHING`,
      [req.user.id, req.params.id]
    );
    res.json({ success: true, message: 'Farmer saved.' });
  } catch (err) {
    console.error('POST /profiles/farmers/:id/save', err);
    res.status(500).json({ success: false, message: 'Failed to save farmer.' });
  }
});

// DELETE /api/profiles/farmers/:id/save — buyer un-saves a farmer
router.delete('/farmers/:id/save', async (req, res) => {
  try {
    await queryAsUser(req.user,
      `DELETE FROM saved_farmers WHERE buyer_id = $1 AND farmer_id = $2`,
      [req.user.id, req.params.id]
    );
    res.json({ success: true, message: 'Farmer removed from saved.' });
  } catch (err) {
    console.error('DELETE /profiles/farmers/:id/save', err);
    res.status(500).json({ success: false, message: 'Failed to remove farmer.' });
  }
});

module.exports = router;
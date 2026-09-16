// // backend/routes/agreement.js
// const express   = require('express');
// const { queryAsUser, withTransaction } = require('../config/database');
// const { authenticate, requireVerified } = require('../middleware/auth');
// const multer    = require('multer');
// const path      = require('path');
// const { computeAgreementQuantityBounds } = require('../utils/agreementMinimums');

// const router = express.Router();
// router.use(authenticate);

// const upload = multer({
//   storage: multer.memoryStorage(),
//   limits:  { fileSize: 5 * 1024 * 1024 },
//   fileFilter: (_, file, cb) => {
//     const ok = /jpeg|jpg|png|webp|pdf/.test(path.extname(file.originalname).toLowerCase());
//     cb(ok ? null : new Error('Images or PDF only'), ok);
//   },
// });

// async function notify(client, { userId, type, title, message, agreementId }) {
//   await client.query(
//     `INSERT INTO notifications (user_id, type, title, message, agreement_id)
//      VALUES ($1, $2, $3, $4, $5)`,
//     [userId, type, title, message, agreementId]
//   );
// }

// // ── GET /api/agreements — role-aware list ─────────────────────────────────────
// router.get('/', async (req, res) => {
//   try {
//     const { id, role: userRole } = req.user;
//     const { status, role: queryRole } = req.query;

//     // queryRole from frontend overrides JWT role for vendor/farmer direction switching
//     const effectiveRole = queryRole || userRole;

//     let whereClause;
//     if (effectiveRole === 'buyer')          whereClause = `a.buyer_id = $1`;
//     else if (effectiveRole === 'vendor_seller') whereClause = `a.seller_id = $1`;
//     else if (effectiveRole === 'vendor_buyer')  whereClause = `a.buyer_id = $1`;
//     // Real, new fix: farmers were hardcoded to seller-only, with no
//     // buyer-direction equivalent at all -- despite a farmer being
//     // just as able to source bulk stock from another farmer (or a
//     // vendor) as a vendor already can. Mirrors the vendor_seller/
//     // vendor_buyer pattern exactly.
//     else if (effectiveRole === 'farmer_seller') whereClause = `a.seller_id = $1`;
//     else if (effectiveRole === 'farmer_buyer')  whereClause = `a.buyer_id = $1`;
//     else if (effectiveRole === 'farmer')        whereClause = `a.seller_id = $1`;
//     else if (userRole === 'vendor')             whereClause = `a.seller_id = $1`;
//     else                                        whereClause = `a.seller_id = $1`;

//     let sql = `
//       SELECT
//         a.*,
//         buyer.full_name    AS buyer_name,
//         buyer.barangay     AS buyer_barangay,
//         buyer.phone_number AS buyer_phone_number,
//         buyer.avatar_url   AS buyer_avatar,
//         seller.full_name AS seller_name,
//         seller.role      AS seller_role,
//         seller.phone_number AS seller_phone_number,
//         COALESCE(fp.barangay, vp.barangay) AS seller_barangay,
//         fp.farm_name,
//         vp.business_name,
//         COALESCE(fp.farm_photo_url, vp.business_photo_url) AS seller_photo
//       FROM agreements a
//       JOIN users buyer  ON buyer.id  = a.buyer_id
//       JOIN users seller ON seller.id = a.seller_id
//       LEFT JOIN farmer_profiles fp ON fp.user_id = a.seller_id
//       LEFT JOIN vendor_profiles  vp ON vp.user_id = a.seller_id
//       WHERE ${whereClause}
//     `;
//     const params = [id];

//     if (status && status !== 'all') {
//       sql += ` AND a.status = $2`;
//       params.push(status);
//     }
//     sql += ` ORDER BY a.created_at DESC`;

//     const { rows } = await queryAsUser(req.user, sql, params);
//     res.json({ success: true, data: rows });
//   } catch (err) {
//     console.error('GET /agreements', err);
//     res.status(500).json({ success: false, message: 'Failed to load agreements.' });
//   }
// });

// // ── POST /api/agreements — create ─────────────────────────────────────────────
// router.post('/', requireVerified, async (req, res) => {
//   try {
//     const { id: buyer_id, full_name } = req.user;
//     const {
//       seller_id, product_id,
//       quantity, price_per_unit,
//       delivery_date, delivery_address, notes,
//     } = req.body;

//     // Real, new requirement: a Smart Agreement is now always tied to
//     // a real, specific listing -- previously product_id was optional
//     // and product_name/unit were freely typed, meaning an agreement
//     // had no real connection to any actual stock at all, and nothing
//     // stopped a buyer from proposing a quantity the seller never
//     // actually had.
//     if (!seller_id || !product_id || !quantity || !price_per_unit) {
//       return res.status(400).json({ success: false, message: 'Missing required fields.' });
//     }

//     const result = await withTransaction(async (client) => {
//       const { rows: sellerRows } = await client.query(
//         `SELECT role FROM users WHERE id = $1 AND account_status = 'active'`,
//         [seller_id]
//       );
//       if (!sellerRows.length) throw new Error('Seller not found.');

//       const { rows: productRows } = await client.query(
//         `SELECT name, unit, stock_qty, seller_id AS product_seller_id FROM products WHERE id = $1 AND status = 'live'`,
//         [product_id]
//       );
//       if (!productRows.length) throw new Error('This listing is no longer available.');
//       const product = productRows[0];
//       if (product.product_seller_id !== seller_id) throw new Error('This listing does not belong to the selected seller.');

//       const qty = parseFloat(quantity);
//       const { min, max } = computeAgreementQuantityBounds(parseFloat(product.stock_qty), product.unit);
//       if (qty < min) {
//         throw new Error(`Minimum quantity for this agreement is ${min.toFixed(min % 1 === 0 ? 0 : 1)} ${product.unit}.`);
//       }
//       if (qty > max) {
//         throw new Error(`Only ${max.toFixed(max % 1 === 0 ? 0 : 1)} ${product.unit} available -- reduce the quantity.`);
//       }

//       const { rows } = await client.query(
//         `INSERT INTO agreements
//            (buyer_id, seller_id, seller_role, product_id, product_name,
//             quantity, unit, price_per_unit, delivery_date, delivery_address, notes)
//          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
//          RETURNING *`,
//         [
//           buyer_id,
//           seller_id,
//           sellerRows[0].role,
//           product_id,
//           product.name,
//           qty,
//           product.unit,
//           parseFloat(price_per_unit),
//           delivery_date || null,
//           delivery_address || null,
//           notes         || null,
//         ]
//       );

//       await notify(client, {
//         userId:      seller_id,
//         type:        'agreement_new',
//         title:       'New Agreement Request',
//         message:     `New agreement request from ${full_name}.`,
//         agreementId: rows[0].id,
//       });

//       return rows[0];
//     });

//     res.status(201).json({ success: true, data: result, message: 'Agreement request sent. Waiting for approval.' });
//   } catch (err) {
//     console.error('POST /agreements', err);
//     res.status(400).json({ success: false, message: err.message || 'Failed to create agreement.' });
//   }
// });

// // ── GET /api/agreements/:id ───────────────────────────────────────────────────
// router.get('/:id', async (req, res) => {
//   try {
//     const { id: userId } = req.user;
//     const { rows } = await queryAsUser(req.user,
//       `SELECT a.*,
//               buyer.full_name  AS buyer_name,
//               seller.full_name AS seller_name
//        FROM agreements a
//        JOIN users buyer  ON buyer.id  = a.buyer_id
//        JOIN users seller ON seller.id = a.seller_id
//        WHERE a.id = $1 AND (a.buyer_id = $2 OR a.seller_id = $2)`,
//       [req.params.id, userId]
//     );
//     if (!rows.length) {
//       return res.status(404).json({ success: false, message: 'Agreement not found.' });
//     }
//     res.json({ success: true, data: rows[0] });
//   } catch (err) {
//     console.error('GET /agreements/:id', err);
//     res.status(500).json({ success: false, message: 'Failed to load agreement.' });
//   }
// });

// // ── PATCH /api/agreements/:id — update status and/or proof_status ─────────────
// router.patch('/:id', async (req, res) => {
//   try {
//     const { id: userId, full_name } = req.user;
//     const { status, proof_status }  = req.body;

//     const { rows: agRows } = await queryAsUser(req.user,
//       `SELECT * FROM agreements WHERE id = $1`,
//       [req.params.id]
//     );
//     if (!agRows.length) {
//       return res.status(404).json({ success: false, message: 'Agreement not found.' });
//     }
//     const ag = agRows[0];

//     if (ag.buyer_id !== userId && ag.seller_id !== userId) {
//       return res.status(403).json({ success: false, message: 'Not authorized.' });
//     }

//     // Real gap fixed: this endpoint let either party set status to
//     // anything with no role check at all -- meaning a buyer could
//     // have set their own agreement straight to 'active' without the
//     // seller ever approving it, defeating the entire "wait for
//     // approval" requirement. Only the seller can approve
//     // (pending -> active) or decline (pending -> cancelled) a
//     // request; the buyer's own ability to cancel their own pending
//     // request already exists separately via DELETE below.
//     if (status === 'active' && ag.seller_id !== userId) {
//       return res.status(403).json({ success: false, message: 'Only the seller can approve this agreement.' });
//     }
//     if (status === 'active' && ag.status !== 'pending') {
//       return res.status(400).json({ success: false, message: 'Only a pending agreement can be approved.' });
//     }
//     if (status === 'cancelled' && ag.status !== 'pending') {
//       return res.status(400).json({ success: false, message: 'Only a pending agreement can be cancelled.' });
//     }

//     await withTransaction(async (client) => {
//       // Build dynamic SET clause
//       const updates = [];
//       const vals    = [];
//       let   idx     = 1;

//       if (status) {
//         updates.push(`status = $${idx++}`);
//         vals.push(status);
//       }

//       if (proof_status) {
//         updates.push(`proof_status = $${idx++}`);
//         vals.push(proof_status);

//         if (proof_status === 'verified') {
//           updates.push(`proof_verified_at = NOW()`);
//           updates.push(`proof_verified_by = $${idx++}`);
//           vals.push(userId);
//           updates.push(`activated_at = NOW()`);
//           // If status wasn't explicitly passed, auto-set to active
//           if (!status) {
//             updates.push(`status = 'active'`);
//           }
//         }
//       }

//       if (!updates.length) return;

//       vals.push(req.params.id);
//       await client.query(
//         `UPDATE agreements SET ${updates.join(', ')} WHERE id = $${idx}`,
//         vals
//       );

//       // ── Notifications ──
//       if (status === 'active') {
//         // Real, new notification: the buyer previously had no way to
//         // know their request was approved at all until this point --
//         // only the later proof-verification step sent anything.
//         await notify(client, {
//           userId:      ag.buyer_id,
//           type:        'agreement_confirmed',
//           title:       'Agreement Approved',
//           message:     `${full_name} approved your agreement request. You can now proceed with payment.`,
//           agreementId: req.params.id,
//         });
//       }

//       if (status === 'cancelled') {
//         const recipientId = ag.buyer_id === userId ? ag.seller_id : ag.buyer_id;
//         const isSellerDeclining = userId === ag.seller_id;
//         await notify(client, {
//           userId:      recipientId,
//           type:        'agreement_confirmed',
//           title:       isSellerDeclining ? 'Agreement Declined' : 'Agreement Cancelled',
//           message:     isSellerDeclining
//             ? `${full_name} declined your agreement request.`
//             : `Agreement was cancelled by ${full_name}.`,
//           agreementId: req.params.id,
//         });
//       }

//       if (status === 'fulfilled') {
//         await notify(client, {
//           userId:      ag.buyer_id,
//           type:        'agreement_fulfilled',
//           title:       'Agreement Fulfilled',
//           message:     'Your agreement has been fulfilled.',
//           agreementId: req.params.id,
//         });
//         // Also notify seller
//         await notify(client, {
//           userId:      ag.seller_id,
//           type:        'agreement_fulfilled',
//           title:       'Agreement Fulfilled',
//           message:     'Agreement has been marked as fulfilled.',
//           agreementId: req.params.id,
//         });
//       }

//       if (proof_status === 'verified') {
//         await notify(client, {
//           userId:      ag.buyer_id,
//           type:        'agreement_confirmed',
//           title:       'Agreement Confirmed',
//           message:     'Your payment was verified. Agreement is now active. 🎉',
//           agreementId: req.params.id,
//         });
//       }

//       if (proof_status === 'rejected') {
//         await notify(client, {
//           userId:      ag.buyer_id,
//           type:        'proof_rejected',
//           title:       'Payment Proof Rejected',
//           message:     'Your payment proof was rejected. Please re-upload.',
//           agreementId: req.params.id,
//         });
//       }
//     });

//     res.json({ success: true, message: 'Agreement updated.' });
//   } catch (err) {
//     console.error('PATCH /agreements/:id', err);
//     res.status(500).json({ success: false, message: 'Failed to update agreement.' });
//   }
// });

// // ── POST /api/agreements/:id/proof — buyer/vendor uploads payment proof ───────
// router.post('/:id/proof', upload.single('proof'), async (req, res) => {
//   try {
//     const { id: buyerId, full_name } = req.user;
//     if (!req.file) {
//       return res.status(400).json({ success: false, message: 'No file uploaded.' });
//     }

//     const { rows: agRows } = await queryAsUser(req.user,
//       `SELECT * FROM agreements WHERE id = $1 AND buyer_id = $2`,
//       [req.params.id, buyerId]
//     );
//     if (!agRows.length) {
//       return res.status(404).json({ success: false, message: 'Agreement not found.' });
//     }

//     // Real, new requirement: no COD for Smart Agreements -- payment
//     // proof can only be uploaded after the seller has approved the
//     // request. Previously nothing checked this at all, meaning a
//     // buyer could upload proof for a still-pending request the
//     // seller hadn't even seen yet.
//     if (agRows[0].status !== 'active') {
//       return res.status(400).json({
//         success: false,
//         message: agRows[0].status === 'pending'
//           ? 'Wait for the seller to approve this request before uploading payment proof.'
//           : 'This agreement is no longer awaiting payment.',
//       });
//     }

//     const { createClient } = require('@supabase/supabase-js');
//     const WebSocket = require('ws');
//     const supabase = createClient(
//       process.env.SUPABASE_URL,
//       process.env.SUPABASE_SERVICE_ROLE_KEY,
//       { realtime: { transport: WebSocket } }
//     );
//     const ext      = path.extname(req.file.originalname).toLowerCase();
//     const fileName = `proof-${req.params.id}-${Date.now()}${ext}`;

//     const { error } = await supabase.storage
//       .from('nagaguno-uploads')
//       .upload(`proofs/${fileName}`, req.file.buffer, {
//         contentType: req.file.mimetype,
//         upsert: true,
//       });
//     if (error) throw error;

//     const { data: { publicUrl } } = supabase.storage
//       .from('nagaguno-uploads')
//       .getPublicUrl(`proofs/${fileName}`);

//     await withTransaction(async (client) => {
//       await client.query(
//         `UPDATE agreements
//          SET payment_proof_url = $1,
//              proof_uploaded_at = NOW(),
//              proof_status      = 'pending'
//          WHERE id = $2`,
//         [publicUrl, req.params.id]
//       );
//       await notify(client, {
//         userId:      agRows[0].seller_id,
//         type:        'proof_uploaded',
//         title:       'Payment Proof Uploaded',
//         message:     `${full_name} uploaded payment proof. Please verify.`,
//         agreementId: req.params.id,
//       });
//     });

//     res.json({ success: true, data: { url: publicUrl }, message: 'Payment proof uploaded.' });
//   } catch (err) {
//     console.error('POST /agreements/:id/proof', err);
//     res.status(500).json({ success: false, message: 'Failed to upload proof.' });
//   }
// });

// // ── PATCH /api/agreements/:id/proof — seller confirms or rejects proof ────────
// router.patch('/:id/proof', async (req, res) => {
//   try {
//     const { id: sellerId, full_name } = req.user;
//     const { action } = req.body; // 'confirm' | 'reject'

//     if (!['confirm', 'reject'].includes(action)) {
//       return res.status(400).json({
//         success: false,
//         message: 'action must be confirm or reject.',
//       });
//     }

//     const { rows: agRows } = await queryAsUser(req.user,
//       `SELECT * FROM agreements WHERE id = $1 AND seller_id = $2`,
//       [req.params.id, sellerId]
//     );
//     if (!agRows.length) {
//       return res.status(404).json({ success: false, message: 'Agreement not found.' });
//     }

//     await withTransaction(async (client) => {
//       if (action === 'confirm') {
//         await client.query(
//           `UPDATE agreements
//            SET proof_status      = 'verified',
//                proof_verified_at = NOW(),
//                proof_verified_by = $1,
//                status            = 'active',
//                activated_at      = NOW()
//            WHERE id = $2`,
//           [sellerId, req.params.id]
//         );
//         await notify(client, {
//           userId:      agRows[0].buyer_id,
//           type:        'agreement_confirmed',
//           title:       'Agreement Confirmed',
//           message:     'Your payment was verified. Agreement is now active. 🎉',
//           agreementId: req.params.id,
//         });
//       } else {
//         await client.query(
//           `UPDATE agreements SET proof_status = 'rejected' WHERE id = $1`,
//           [req.params.id]
//         );
//         await notify(client, {
//           userId:      agRows[0].buyer_id,
//           type:        'proof_rejected',
//           title:       'Payment Proof Rejected',
//           message:     'Your payment proof was rejected. Please re-upload.',
//           agreementId: req.params.id,
//         });
//       }
//     });

//     res.json({
//       success: true,
//       message: action === 'confirm' ? 'Agreement activated.' : 'Proof rejected.',
//     });
//   } catch (err) {
//     console.error('PATCH /agreements/:id/proof', err);
//     res.status(500).json({ success: false, message: 'Failed to process proof.' });
//   }
// });

// // ── DELETE /api/agreements/:id — cancel ───────────────────────────────────────
// router.delete('/:id', async (req, res) => {
//   try {
//     const { id: userId } = req.user;
//     const { rows } = await queryAsUser(req.user,
//       `UPDATE agreements SET status = 'cancelled', cancelled_at = NOW()
//        WHERE id = $1 AND buyer_id = $2 AND status = 'pending'
//        RETURNING id`,
//       [req.params.id, userId]
//     );
//     if (!rows.length) {
//       return res.status(404).json({
//         success: false,
//         message: 'Agreement not found or cannot be cancelled.',
//       });
//     }
//     res.json({ success: true, message: 'Agreement cancelled.' });
//   } catch (err) {
//     console.error('DELETE /agreements/:id', err);
//     res.status(500).json({ success: false, message: 'Failed to cancel agreement.' });
//   }
// });

// module.exports = router;


//NEW-----------------------------------------------------------------------------------
// backend/routes/agreement.js
const express   = require('express');
const { queryAsUser, withTransaction } = require('../config/database');
const { authenticate, requireVerified } = require('../middleware/auth');
const multer    = require('multer');
const path      = require('path');
const { computeAgreementQuantityBounds } = require('../utils/agreementMinimums');

const router = express.Router();
router.use(authenticate);

// Serialize payment changes and reject actions based on stale agreement data.
async function lockAgreement(client, agreement) {
  const { rows } = await client.query('SELECT * FROM agreements WHERE id = $1 FOR UPDATE', [agreement.id]);
  const current = rows[0];
  if (!current || current.status !== agreement.status ||
      current.proof_status !== agreement.proof_status ||
      current.payment_proof_url !== agreement.payment_proof_url) {
    const error = new Error('Agreement changed. Refresh it and try again.');
    error.status = 409;
    throw error;
  }
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    const ok = /jpeg|jpg|png|webp|pdf/.test(path.extname(file.originalname).toLowerCase());
    cb(ok ? null : new Error('Images or PDF only'), ok);
  },
});

async function notify(client, { userId, type, title, message, agreementId }) {
  await client.query(
    `INSERT INTO notifications (user_id, type, title, message, agreement_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, type, title, message, agreementId]
  );
}

// ── GET /api/agreements — role-aware list ─────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { id, role: userRole } = req.user;
    const { status, role: queryRole } = req.query;

    // queryRole from frontend overrides JWT role for vendor/farmer direction switching
    const effectiveRole = queryRole || userRole;

    let whereClause;
    if (effectiveRole === 'buyer')          whereClause = `a.buyer_id = $1`;
    else if (effectiveRole === 'vendor_seller') whereClause = `a.seller_id = $1`;
    else if (effectiveRole === 'vendor_buyer')  whereClause = `a.buyer_id = $1`;
    // Real, new fix: farmers were hardcoded to seller-only, with no
    // buyer-direction equivalent at all -- despite a farmer being
    // just as able to source bulk stock from another farmer (or a
    // vendor) as a vendor already can. Mirrors the vendor_seller/
    // vendor_buyer pattern exactly.
    else if (effectiveRole === 'farmer_seller') whereClause = `a.seller_id = $1`;
    else if (effectiveRole === 'farmer_buyer')  whereClause = `a.buyer_id = $1`;
    else if (effectiveRole === 'farmer')        whereClause = `a.seller_id = $1`;
    else if (userRole === 'vendor')             whereClause = `a.seller_id = $1`;
    else                                        whereClause = `a.seller_id = $1`;

    let sql = `
      SELECT
        a.*,
        buyer.full_name    AS buyer_name,
        buyer.barangay     AS buyer_barangay,
        buyer.phone_number AS buyer_phone_number,
        buyer.avatar_url   AS buyer_avatar,
        seller.full_name AS seller_name,
        seller.role      AS seller_role,
        seller.phone_number AS seller_phone_number,
        COALESCE(fp.barangay, vp.barangay) AS seller_barangay,
        fp.farm_name,
        vp.business_name,
        COALESCE(fp.farm_photo_url, vp.business_photo_url) AS seller_photo
      FROM agreements a
      JOIN users buyer  ON buyer.id  = a.buyer_id
      JOIN users seller ON seller.id = a.seller_id
      LEFT JOIN farmer_profiles fp ON fp.user_id = a.seller_id
      LEFT JOIN vendor_profiles  vp ON vp.user_id = a.seller_id
      WHERE ${whereClause}
    `;
    const params = [id];

    if (status && status !== 'all') {
      sql += ` AND a.status = $2`;
      params.push(status);
    }
    sql += ` ORDER BY a.created_at DESC`;

    const { rows } = await queryAsUser(req.user, sql, params);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('GET /agreements', err);
    res.status(500).json({ success: false, message: 'Failed to load agreements.' });
  }
});

// ── POST /api/agreements — create ─────────────────────────────────────────────
router.post('/', requireVerified, async (req, res) => {
  try {
    const { id: buyer_id, full_name } = req.user;
    const {
      seller_id, product_id, crop_plan_id,
      quantity, price_per_unit,
      delivery_date, delivery_address, notes,
    } = req.body;

    if (!Number.isFinite(Number(quantity)) || Number(quantity) <= 0 ||
        !Number.isFinite(Number(price_per_unit)) || Number(price_per_unit) <= 0) {
      return res.status(400).json({ success: false, message: 'Quantity and price must be positive finite numbers.' });
    }

    if (seller_id === buyer_id) {
      return res.status(403).json({ success: false, message: 'You cannot request your own listing.' });
    }

    // Real, new feature: a Smart Agreement can now be tied to either
    // a real, live listing (product_id, existing stock) OR a real
    // crop plan (crop_plan_id, a farmer's own estimate for a crop
    // not yet harvested) -- exactly one of the two, never both, never
    // neither, matching the real database check constraint added
    // alongside this. This is the actual reservation-of-a-future-
    // harvest use case Smart Agreements were originally meant for:
    // previously an agreement could only reference something already
    // harvested and already listed for sale, which defeated the
    // purpose of securing a buyer AHEAD OF harvest.
    if (!seller_id || (!product_id && !crop_plan_id) || (product_id && crop_plan_id) || !quantity || !price_per_unit) {
      return res.status(400).json({
        success: false,
        message: !seller_id || !quantity || !price_per_unit
          ? 'Missing required fields.'
          : 'Provide exactly one of product_id or crop_plan_id.',
      });
    }

    const result = await withTransaction(async (client) => {
      const { rows: sellerRows } = await client.query(
        `SELECT role FROM users WHERE id = $1 AND account_status = 'active'`,
        [seller_id]
      );
      if (!sellerRows.length) throw new Error('Seller not found.');

      let sourceName, sourceUnit, sourceQtyAvailable;

      if (product_id) {
        const { rows: productRows } = await client.query(
          `SELECT name, unit, stock_qty, seller_id AS product_seller_id FROM products WHERE id = $1 AND status = 'live'`,
          [product_id]
        );
        if (!productRows.length) throw new Error('This listing is no longer available.');
        const product = productRows[0];
        if (product.product_seller_id !== seller_id) throw new Error('This listing does not belong to the selected seller.');
        sourceName = product.name;
        sourceUnit = product.unit;
        sourceQtyAvailable = parseFloat(product.stock_qty);
      } else {
        // Real, new path: reserving against a future, not-yet-
        // harvested crop plan instead of existing stock. 'done' means
        // the crop has already been fully harvested -- at that point
        // it should already exist as a real product listing instead,
        // so new reservations against the plan itself are no longer
        // meaningful.
        const { rows: cropRows } = await client.query(
          `SELECT crop_name, unit, quantity_kg, farmer_id, stage FROM crop_plans WHERE id = $1`,
          [crop_plan_id]
        );
        if (!cropRows.length) throw new Error('This crop plan no longer exists.');
        const crop = cropRows[0];
        if (crop.farmer_id !== seller_id) throw new Error('This crop plan does not belong to the selected seller.');
        if (crop.stage === 'done') throw new Error('This crop has already been harvested -- look for it as a regular listing instead.');
        sourceName = crop.crop_name;
        sourceUnit = crop.unit;
        sourceQtyAvailable = parseFloat(crop.quantity_kg);
      }

      const qty = parseFloat(quantity);
      const { min, max } = computeAgreementQuantityBounds(sourceQtyAvailable, sourceUnit);
      if (qty < min) {
        throw new Error(`Minimum quantity for this agreement is ${min.toFixed(min % 1 === 0 ? 0 : 1)} ${sourceUnit}.`);
      }
      if (qty > max) {
        throw new Error(`Only ${max.toFixed(max % 1 === 0 ? 0 : 1)} ${sourceUnit} estimated -- reduce the quantity.`);
      }

      const { rows } = await client.query(
        `INSERT INTO agreements
           (buyer_id, seller_id, seller_role, product_id, crop_plan_id, product_name,
            quantity, unit, price_per_unit, delivery_date, delivery_address, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING *`,
        [
          buyer_id,
          seller_id,
          sellerRows[0].role,
          product_id || null,
          crop_plan_id || null,
          sourceName,
          qty,
          sourceUnit,
          parseFloat(price_per_unit),
          delivery_date || null,
          delivery_address || null,
          notes         || null,
        ]
      );

      await notify(client, {
        userId:      seller_id,
        type:        'agreement_new',
        title:       'New Agreement Request',
        message:     product_id
          ? `New agreement request from ${full_name}.`
          : `New agreement request from ${full_name} for your upcoming ${sourceName} harvest.`,
        agreementId: rows[0].id,
      });

      return rows[0];
    });

    res.status(201).json({ success: true, data: result, message: 'Agreement request sent. Waiting for approval.' });
  } catch (err) {
    console.error('POST /agreements', err);
    res.status(400).json({ success: false, message: err.message || 'Failed to create agreement.' });
  }
});

// ── GET /api/agreements/:id ───────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const { id: userId } = req.user;
    const { rows } = await queryAsUser(req.user,
      `SELECT a.*,
              buyer.full_name  AS buyer_name,
              seller.full_name AS seller_name
       FROM agreements a
       JOIN users buyer  ON buyer.id  = a.buyer_id
       JOIN users seller ON seller.id = a.seller_id
       WHERE a.id = $1 AND (a.buyer_id = $2 OR a.seller_id = $2)`,
      [req.params.id, userId]
    );
    if (!rows.length) {
      return res.status(404).json({ success: false, message: 'Agreement not found.' });
    }
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('GET /agreements/:id', err);
    res.status(500).json({ success: false, message: 'Failed to load agreement.' });
  }
});

// ── PATCH /api/agreements/:id — update status and/or proof_status ─────────────
router.patch('/:id', async (req, res) => {
  try {
    const { id: userId, full_name } = req.user;
    const { status, proof_status }  = req.body;

    if ((!status && !proof_status) ||
        (status && !['active', 'cancelled', 'fulfilled'].includes(status)) ||
        (proof_status && !['verified', 'rejected'].includes(proof_status)) ||
        (status && proof_status)) {
      return res.status(400).json({ success: false, message: 'Provide one valid status or payment proof review.' });
    }

    const { rows: agRows } = await queryAsUser(req.user,
      `SELECT * FROM agreements WHERE id = $1`,
      [req.params.id]
    );
    if (!agRows.length) {
      return res.status(404).json({ success: false, message: 'Agreement not found.' });
    }
    const ag = agRows[0];

    if (ag.buyer_id !== userId && ag.seller_id !== userId) {
      return res.status(403).json({ success: false, message: 'Not authorized.' });
    }

    if (proof_status && ag.seller_id !== userId) {
      return res.status(403).json({ success: false, message: 'Only the seller can review payment proof.' });
    }
    if (proof_status && (ag.status !== 'active' || ag.proof_status !== 'pending' || !ag.payment_proof_url?.trim())) {
      return res.status(400).json({ success: false, message: 'The buyer must upload payment proof for this approved agreement before it can be reviewed.' });
    }
    if (status === 'fulfilled' && ag.buyer_id !== userId) {
      return res.status(403).json({ success: false, message: 'Only the buyer can confirm receipt of this agreement.' });
    }
    if (status === 'fulfilled' && (ag.status !== 'active' || ag.proof_status !== 'verified' || !ag.payment_proof_url?.trim())) {
      return res.status(400).json({ success: false, message: 'Payment proof must be verified before the agreement can be fulfilled.' });
    }

    // Real gap fixed: this endpoint let either party set status to
    // anything with no role check at all -- meaning a buyer could
    // have set their own agreement straight to 'active' without the
    // seller ever approving it, defeating the entire "wait for
    // approval" requirement. Only the seller can approve
    // (pending -> active) or decline (pending -> cancelled) a
    // request; the buyer's own ability to cancel their own pending
    // request already exists separately via DELETE below.
    if (status === 'active' && ag.seller_id !== userId) {
      return res.status(403).json({ success: false, message: 'Only the seller can approve this agreement.' });
    }
    if (status === 'active' && ag.status !== 'pending') {
      return res.status(400).json({ success: false, message: 'Only a pending agreement can be approved.' });
    }
    if (status === 'cancelled' && ag.status !== 'pending') {
      return res.status(400).json({ success: false, message: 'Only a pending agreement can be cancelled.' });
    }

    await withTransaction(async (client) => {
      // Build dynamic SET clause
      await lockAgreement(client, ag);
      // Reserve at approval, serialized with ordinary purchases on the source row.
      if (status === 'active') {
        if (!Number.isFinite(Number(ag.quantity)) || Number(ag.quantity) <= 0) {
          throw Object.assign(new Error('Invalid agreement quantity. Create a corrected proposal.'), { status: 409 });
        }
        if (ag.product_id) {
          const { rows } = await client.query("SELECT stock_qty FROM products WHERE id = $1 AND seller_id = $2 AND status = 'live' FOR UPDATE", [ag.product_id, ag.seller_id]);
          if (!rows.length || Number(rows[0].stock_qty) < Number(ag.quantity)) {
            throw Object.assign(new Error('Insufficient available stock to approve this agreement.'), { status: 409 });
          }
          await client.query('UPDATE products SET stock_qty = stock_qty - $1 WHERE id = $2', [ag.quantity, ag.product_id]);
        } else if (ag.crop_plan_id) {
          const { rows } = await client.query("SELECT quantity_kg FROM crop_plans WHERE id = $1 AND farmer_id = $2 AND stage != 'done' FOR UPDATE", [ag.crop_plan_id, ag.seller_id]);
          const { rows: reservations } = await client.query("SELECT COALESCE(SUM(quantity), 0) AS reserved FROM agreements WHERE crop_plan_id = $1 AND status IN ('active', 'fulfilled')", [ag.crop_plan_id]);
          if (!rows.length || Number(rows[0].quantity_kg) - Number(reservations[0].reserved) < Number(ag.quantity)) {
            throw Object.assign(new Error('Insufficient unreserved harvest to approve this agreement.'), { status: 409 });
          }
        }
      }
      const updates = [];
      const vals    = [];
      let   idx     = 1;

      if (status) {
        updates.push(`status = $${idx++}`);
        vals.push(status);
      }

      if (proof_status) {
        updates.push(`proof_status = $${idx++}`);
        vals.push(proof_status);

        if (proof_status === 'verified') {
          updates.push(`proof_verified_at = NOW()`);
          updates.push(`proof_verified_by = $${idx++}`);
          vals.push(userId);
          updates.push(`activated_at = NOW()`);
          // If status wasn't explicitly passed, auto-set to active
          if (!status) {
            updates.push(`status = 'active'`);
          }
        }
      }

      if (!updates.length) return;

      vals.push(req.params.id);
      await client.query(
        `UPDATE agreements SET ${updates.join(', ')} WHERE id = $${idx}`,
        vals
      );

      // ── Notifications ──
      if (status === 'active') {
        // Real, new notification: the buyer previously had no way to
        // know their request was approved at all until this point --
        // only the later proof-verification step sent anything.
        await notify(client, {
          userId:      ag.buyer_id,
          type:        'agreement_confirmed',
          title:       'Agreement Approved',
          message:     `${full_name} approved your agreement request. Upload proof of payment so the seller can confirm your order.`,
          agreementId: req.params.id,
        });
      }

      if (status === 'cancelled') {
        const recipientId = ag.buyer_id === userId ? ag.seller_id : ag.buyer_id;
        const isSellerDeclining = userId === ag.seller_id;
        await notify(client, {
          userId:      recipientId,
          type:        'agreement_confirmed',
          title:       isSellerDeclining ? 'Agreement Declined' : 'Agreement Cancelled',
          message:     isSellerDeclining
            ? `${full_name} declined your agreement request.`
            : `Agreement was cancelled by ${full_name}.`,
          agreementId: req.params.id,
        });
      }

      if (status === 'fulfilled') {
        await notify(client, {
          userId:      ag.buyer_id,
          type:        'agreement_fulfilled',
          title:       'Agreement Fulfilled',
          message:     'Your agreement has been fulfilled.',
          agreementId: req.params.id,
        });
        // Also notify seller
        await notify(client, {
          userId:      ag.seller_id,
          type:        'agreement_fulfilled',
          title:       'Agreement Fulfilled',
          message:     'Agreement has been marked as fulfilled.',
          agreementId: req.params.id,
        });
      }

      if (proof_status === 'verified') {
        await notify(client, {
          userId:      ag.buyer_id,
          type:        'agreement_confirmed',
          title:       'Agreement Confirmed',
          message:     'Your payment was verified. Agreement is now active. 🎉',
          agreementId: req.params.id,
        });
      }

      if (proof_status === 'rejected') {
        await notify(client, {
          userId:      ag.buyer_id,
          type:        'proof_rejected',
          title:       'Payment Proof Rejected',
          message:     'Your payment proof was rejected. Please re-upload.',
          agreementId: req.params.id,
        });
      }
    });

    res.json({ success: true, message: 'Agreement updated.' });
  } catch (err) {
    console.error('PATCH /agreements/:id', err);
    res.status(err.status || 500).json({ success: false, message: err.status === 409 ? err.message : 'Failed to update agreement.' });
  }
});

// ── POST /api/agreements/:id/proof — buyer/vendor uploads payment proof ───────
router.post('/:id/proof', upload.single('proof'), async (req, res) => {
  try {
    const { id: buyerId, full_name } = req.user;
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded.' });
    }

    const { rows: agRows } = await queryAsUser(req.user,
      `SELECT * FROM agreements WHERE id = $1 AND buyer_id = $2`,
      [req.params.id, buyerId]
    );
    if (!agRows.length) {
      return res.status(404).json({ success: false, message: 'Agreement not found.' });
    }

    // Real, new requirement: no COD for Smart Agreements -- payment
    // proof can only be uploaded after the seller has approved the
    // request. Previously nothing checked this at all, meaning a
    // buyer could upload proof for a still-pending request the
    // seller hadn't even seen yet.
    if (agRows[0].status !== 'active') {
      return res.status(400).json({
        success: false,
        message: agRows[0].status === 'pending'
          ? 'Wait for the seller to approve this request before uploading payment proof.'
          : 'This agreement is no longer awaiting payment.',
      });
    }

    const awaitingFirstProof = agRows[0].proof_status === 'pending' &&
      !agRows[0].payment_proof_url?.trim();
    if (!awaitingFirstProof && !['none', 'rejected', null].includes(agRows[0].proof_status)) {
      return res.status(400).json({ success: false, message: 'Payment proof is already awaiting review or has been verified.' });
    }

    const { createClient } = require('@supabase/supabase-js');
    const WebSocket = require('ws');
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { realtime: { transport: WebSocket } }
    );
    const ext      = path.extname(req.file.originalname).toLowerCase();
    const fileName = `proof-${req.params.id}-${Date.now()}${ext}`;

    const { error } = await supabase.storage
      .from('nagaguno-uploads')
      .upload(`proofs/${fileName}`, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: true,
      });
    if (error) throw error;

    const { data: { publicUrl } } = supabase.storage
      .from('nagaguno-uploads')
      .getPublicUrl(`proofs/${fileName}`);

    await withTransaction(async (client) => {
      await lockAgreement(client, agRows[0]);
      await client.query(
        `UPDATE agreements
         SET payment_proof_url = $1,
             proof_uploaded_at = NOW(),
             proof_status      = 'pending'
         WHERE id = $2`,
        [publicUrl, req.params.id]
      );
      await notify(client, {
        userId:      agRows[0].seller_id,
        type:        'proof_uploaded',
        title:       'Payment Proof Uploaded',
        message:     `${full_name} uploaded payment proof. Please verify.`,
        agreementId: req.params.id,
      });
    });

    res.json({ success: true, data: { url: publicUrl }, message: 'Payment proof uploaded.' });
  } catch (err) {
    console.error('POST /agreements/:id/proof', err);
    res.status(err.status || 500).json({ success: false, message: err.status === 409 ? err.message : 'Failed to upload proof.' });
  }
});

// ── PATCH /api/agreements/:id/proof — seller confirms or rejects proof ────────
router.patch('/:id/proof', async (req, res) => {
  try {
    const { id: sellerId, full_name } = req.user;
    const { action } = req.body; // 'confirm' | 'reject'

    if (!['confirm', 'reject'].includes(action)) {
      return res.status(400).json({
        success: false,
        message: 'action must be confirm or reject.',
      });
    }

    const { rows: agRows } = await queryAsUser(req.user,
      `SELECT * FROM agreements WHERE id = $1 AND seller_id = $2`,
      [req.params.id, sellerId]
    );
    if (!agRows.length) {
      return res.status(404).json({ success: false, message: 'Agreement not found.' });
    }

    const agreement = agRows[0];
    if (agreement.status !== 'active' || agreement.proof_status !== 'pending' || !agreement.payment_proof_url?.trim()) {
      return res.status(400).json({ success: false, message: 'Waiting for the buyer to upload proof of payment before confirming the order.' });
    }

    await withTransaction(async (client) => {
      if (action === 'confirm') {
        await lockAgreement(client, agreement);
        await client.query(
          `UPDATE agreements
           SET proof_status      = 'verified',
               proof_verified_at = NOW(),
               proof_verified_by = $1,
               status            = 'active',
               activated_at      = NOW()
           WHERE id = $2`,
          [sellerId, req.params.id]
        );
        await notify(client, {
          userId:      agRows[0].buyer_id,
          type:        'agreement_confirmed',
          title:       'Agreement Confirmed',
          message:     'Your payment was verified. Agreement is now active. 🎉',
          agreementId: req.params.id,
        });
      } else {
        await lockAgreement(client, agreement);
        await client.query(
          `UPDATE agreements SET proof_status = 'rejected' WHERE id = $1`,
          [req.params.id]
        );
        await notify(client, {
          userId:      agRows[0].buyer_id,
          type:        'proof_rejected',
          title:       'Payment Proof Rejected',
          message:     'Your payment proof was rejected. Please re-upload.',
          agreementId: req.params.id,
        });
      }
    });

    res.json({
      success: true,
      message: action === 'confirm' ? 'Agreement activated.' : 'Proof rejected.',
    });
  } catch (err) {
    console.error('PATCH /agreements/:id/proof', err);
    res.status(err.status || 500).json({ success: false, message: err.status === 409 ? err.message : 'Failed to process proof.' });
  }
});

// ── DELETE /api/agreements/:id — cancel ───────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const { id: userId } = req.user;
    const { rows } = await queryAsUser(req.user,
      `UPDATE agreements SET status = 'cancelled', cancelled_at = NOW()
       WHERE id = $1 AND buyer_id = $2 AND status = 'pending'
       RETURNING id`,
      [req.params.id, userId]
    );
    if (!rows.length) {
      return res.status(404).json({
        success: false,
        message: 'Agreement not found or cannot be cancelled.',
      });
    }
    res.json({ success: true, message: 'Agreement cancelled.' });
  } catch (err) {
    console.error('DELETE /agreements/:id', err);
    res.status(500).json({ success: false, message: 'Failed to cancel agreement.' });
  }
});

module.exports = router;

// backend/routes/orders.js
const express   = require('express');
const { query, queryAsUser, withTransaction } = require('../config/database');
const { authenticate, requireVerified } = require('../middleware/auth');

// ── Multer (in-memory, images only, 5 MB cap) ─────────────────
const multer = require('multer');
const path   = require('path');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    const ok = /jpeg|jpg|png|webp|pdf/.test(
      path.extname(file.originalname).toLowerCase()
    );
    cb(ok ? null : new Error('Images only'), ok);
  },
});

const router = express.Router();
router.use(authenticate);

// ── Notification helper ───────────────────────────────────────
async function notify(client, { userId, type, title, message, orderId }) {
  await client.query(
    `INSERT INTO notifications (user_id, type, title, message, order_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, type, title, message, orderId]
  );
}

// GET /api/orders — role-aware list
router.get('/', async (req, res) => {
  try {
    const { id, role: userRole } = req.user;
    const { status, role: queryRole } = req.query;
    const effectiveRole = queryRole || userRole;
    console.log('GET /orders — effectiveRole:', effectiveRole, '| id:', id);

    let whereClause;
    if (effectiveRole === 'buyer')              whereClause = `o.buyer_id = $1`;
    else if (effectiveRole === 'vendor_seller') whereClause = `o.seller_id = $1`;
    else if (effectiveRole === 'vendor_buyer')  whereClause = `o.buyer_id = $1`;
    else if (effectiveRole === 'farmer_seller') whereClause = `o.seller_id = $1`;
    else if (effectiveRole === 'farmer_buyer')  whereClause = `o.buyer_id = $1`;
    else if (effectiveRole === 'farmer')        whereClause = `o.seller_id = $1`;
    else if (userRole === 'vendor')             whereClause = `o.seller_id = $1`;
    else                                        whereClause = `o.seller_id = $1`;

    let sql = `
      SELECT
        o.id, o.buyer_id, o.seller_id, o.seller_role, o.status, o.total_amount, o.notes, o.payment_method,
        o.payment_proof_url, o.proof_status, o.proof_uploaded_at,
        o.confirmed_at, o.preparing_at, o.dispatched_at,
        o.delivered_at, o.cancelled_at, o.created_at,
        buyer.full_name    AS buyer_name,
        buyer.barangay     AS buyer_barangay,
        buyer.street_address AS buyer_street_address,
        buyer.phone_number AS buyer_phone_number,
        buyer.email        AS buyer_email,
        buyer.role         AS buyer_role,
        seller.full_name   AS seller_name,
        seller.phone_number AS seller_phone_number,
        seller.email       AS seller_email,
        seller.role        AS seller_role,
        seller.street_address AS seller_street_address,
        COALESCE(fp.barangay, vp.barangay) AS seller_barangay,
        fp.farm_name,
        vp.business_name,
        COALESCE(buyer.avatar_url, NULL) AS buyer_avatar,
        COALESCE(fp.farm_photo_url, vp.business_photo_url) AS seller_photo,
        json_agg(json_build_object(
          'id',        oi.id,
          'quantity',  oi.quantity,
          'unit',      oi.unit,
          'unit_price',oi.unit_price,
          'subtotal',  oi.subtotal,
          'name',      p.name,
          'image_url', p.image_url
        )) AS items
      FROM orders o
      JOIN users buyer  ON buyer.id  = o.buyer_id
      JOIN users seller ON seller.id = o.seller_id
      LEFT JOIN farmer_profiles fp ON fp.user_id = o.seller_id
      LEFT JOIN vendor_profiles  vp ON vp.user_id = o.seller_id
      LEFT JOIN order_items oi ON oi.order_id = o.id
      LEFT JOIN products    p  ON p.id = oi.product_id
      WHERE ${whereClause}
    `;
    const params = [id];

    if (status && status !== 'all') {
      sql += ` AND o.status = $2`;
      params.push(status);
    }

    sql += ` GROUP BY o.id, buyer.full_name, buyer.barangay, buyer.phone_number,
                  buyer.email, buyer.role, buyer.avatar_url, buyer.street_address,
                  seller.full_name, seller.phone_number, seller.email, seller.role, seller.street_address,
                  fp.barangay, vp.barangay, fp.farm_name, vp.business_name,
                  fp.farm_photo_url, vp.business_photo_url
         ORDER BY o.created_at DESC`;

    const { rows } = await queryAsUser(req.user, sql, params);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('GET /orders', err);
    res.status(500).json({ success: false, message: 'Failed to load orders.' });
  }
});

// POST /api/orders — place order
router.post('/', requireVerified, async (req, res) => {
  try {
    const { id: buyer_id, full_name } = req.user;
    const { seller_id, items, notes, payment_method } = req.body;

    if (seller_id === buyer_id) {
      return res.status(403).json({ success: false, message: 'You cannot request your own listing.' });
    }

    if (!seller_id || !Array.isArray(items) || !items.length) {
      return res.status(400).json({ success: false, message: 'seller_id and items are required.' });
    }
    // Real, new feature: defaults to 'cod' at the database level too
    // (matches the migration's DEFAULT), but validated explicitly
    // here so an invalid value fails clearly rather than silently
    // falling through to a Postgres enum error later.
    if (payment_method && !['cod', 'online'].includes(payment_method)) {
      return res.status(400).json({ success: false, message: "payment_method must be 'cod' or 'online'." });
    }

    const combined = new Map();
    for (const item of items) {
      if (!item?.product_id || !Number.isFinite(Number(item.quantity)) || Number(item.quantity) <= 0) {
        return res.status(400).json({ success: false, message: 'Each item requires a positive finite quantity.' });
      }
      combined.set(item.product_id, (combined.get(item.product_id) || 0) + Number(item.quantity));
    }
    const normalizedItems = [...combined].sort(([a], [b]) => a.localeCompare(b))
      .map(([product_id, quantity]) => ({ product_id, quantity }));

    const result = await withTransaction(async (client) => {
      const { rows: sellerRows } = await client.query(
        `SELECT role FROM users WHERE id = $1 AND account_status = 'active'`, [seller_id]
      );
      if (!sellerRows.length) throw new Error('Seller not found.');
      const seller_role = sellerRows[0].role;

      let total_amount = 0;
      const resolvedItems = [];

      for (const item of normalizedItems) {
        const { rows: pRows } = await client.query(
          `SELECT id, name, price_per_unit, stock_qty, unit
           FROM products
           WHERE id = $1 AND seller_id = $2 AND status = 'live' FOR UPDATE`,
          [item.product_id, seller_id]
        );
        if (!pRows.length) throw new Error(`Product ${item.product_id} not available.`);
        const product = pRows[0];
        if (product.stock_qty < item.quantity)
          throw new Error(`Insufficient stock for ${product.name}.`);
        const subtotal = parseFloat(product.price_per_unit) * parseFloat(item.quantity);
        total_amount += subtotal;
        resolvedItems.push({ ...item, unit_price: product.price_per_unit, unit: product.unit });
      }

      const { rows: orderRows } = await client.query(
        `INSERT INTO orders (buyer_id, seller_id, seller_role, total_amount, notes, payment_method)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [buyer_id, seller_id, seller_role, total_amount, notes || null, payment_method || 'cod']
      );
      const order = orderRows[0];

      for (const item of resolvedItems) {
        await client.query(
          `INSERT INTO order_items (order_id, product_id, quantity, unit, unit_price)
           VALUES ($1,$2,$3,$4,$5)`,
          [order.id, item.product_id, item.quantity, item.unit, item.unit_price]
        );
        await client.query(
          `UPDATE products SET stock_qty = stock_qty - $1 WHERE id = $2`,
          [item.quantity, item.product_id]
        );
      }

      await notify(client, {
        userId:  seller_id,
        type:    'order_placed',
        title:   'New Order Received',
        message: `New order from ${full_name}.`,
        orderId: order.id,
      });

      return order;
    });

    res.status(201).json({ success: true, data: result, message: 'Order placed successfully.' });
  } catch (err) {
    console.error('POST /orders', err);
    res.status(400).json({ success: false, message: err.message || 'Failed to place order.' });
  }
});

// GET /api/orders/:id — order detail
router.get('/:id', async (req, res) => {
  try {
    const { id: userId } = req.user;
    const { rows } = await queryAsUser(req.user, 
      `SELECT o.*,
              buyer.full_name  AS buyer_name,
              buyer.barangay   AS buyer_barangay,
              buyer.street_address AS buyer_street_address,
              buyer.phone_number AS buyer_phone_number,
              seller.full_name AS seller_name,
              seller.street_address AS seller_street_address,
              seller.phone_number AS seller_phone_number,
              json_agg(json_build_object(
                'id',        oi.id,
                'name',      p.name,
                'quantity',  oi.quantity,
                'unit',      oi.unit,
                'unit_price',oi.unit_price,
                'subtotal',  oi.subtotal,
                'image_url', p.image_url
              )) AS items
       FROM orders o
       JOIN users buyer  ON buyer.id  = o.buyer_id
       JOIN users seller ON seller.id = o.seller_id
       LEFT JOIN order_items oi ON oi.order_id = o.id
       LEFT JOIN products    p  ON p.id = oi.product_id
       WHERE o.id = $1
         AND (o.buyer_id = $2 OR o.seller_id = $2)
       GROUP BY o.id, buyer.full_name, buyer.barangay, buyer.street_address, buyer.phone_number,
                seller.full_name, seller.street_address, seller.phone_number`,
      [req.params.id, userId]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'Order not found.' });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('GET /orders/:id', err);
    res.status(500).json({ success: false, message: 'Failed to load order.' });
  }
});

// PATCH /api/orders/:id/status — update order status
router.patch('/:id/status', async (req, res) => {
  try {
    const { id: userId, role, full_name } = req.user;
    const { status } = req.body;

    const VALID = ['confirmed','preparing','dispatched','delivered','cancelled'];
    if (!VALID.includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status.' });
    }

    const { rows: orderRows } = await queryAsUser(req.user, 
      `SELECT * FROM orders WHERE id = $1`, [req.params.id]
    );
    if (!orderRows.length) return res.status(404).json({ success: false, message: 'Order not found.' });
    const order = orderRows[0];

    const isBuyer  = order.buyer_id  === userId;
    const isSeller = order.seller_id === userId;

    if (status === 'delivered' && !isBuyer)
      return res.status(403).json({ success: false, message: 'Only buyer can mark delivered.' });
    if (status === 'cancelled' && !isBuyer)
      return res.status(403).json({ success: false, message: 'Only buyer can cancel.' });
    if (['confirmed','preparing','dispatched'].includes(status) && !isSeller)
      return res.status(403).json({ success: false, message: 'Only seller can update this status.' });
    if (status === 'cancelled' && !['pending'].includes(order.status))
      return res.status(400).json({ success: false, message: 'Can only cancel pending orders.' });
    // Real, new gating: proof_status already existed, but nothing
    // previously checked it before letting a seller confirm an order
    // -- meaning an Online Payment order could be confirmed before
    // its proof was ever verified. COD orders need no proof at all
    // and skip this check entirely.
    if (status === 'confirmed' && order.payment_method === 'online' && order.proof_status !== 'verified') {
      return res.status(400).json({
        success: false,
        message: order.proof_status === 'rejected'
          ? 'This order\'s payment proof was rejected. Ask the buyer to upload a new one before confirming.'
          : 'This order requires a verified payment proof before it can be confirmed.',
      });
    }

    await withTransaction(async (client) => {
      const { rows } = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [req.params.id]);
      const current = rows[0];
      const allowed = { pending: ['confirmed', 'cancelled'], confirmed: ['preparing'], preparing: ['dispatched'], dispatched: ['delivered'] };
      if (!current || !(allowed[current.status] || []).includes(status)) {
        throw Object.assign(new Error('This order cannot move to the requested status. Refresh and try again.'), { status: 409 });
      }
      if (status === 'confirmed' && current.payment_method === 'online' &&
          (current.proof_status !== 'verified' || !current.payment_proof_url?.trim())) {
        throw Object.assign(new Error('Verify the uploaded payment proof before confirming.'), { status: 400 });
      }
      if (status === 'cancelled') {
        const { rows: items } = await client.query('SELECT product_id, quantity FROM order_items WHERE order_id = $1 ORDER BY product_id', [req.params.id]);
        for (const item of items) {
          await client.query('UPDATE products SET stock_qty = stock_qty + $1 WHERE id = $2', [item.quantity, item.product_id]);
        }
      }
      await client.query(
        `UPDATE orders SET status = $1 WHERE id = $2`, [status, req.params.id]
      );

      const notifMap = {
        confirmed:  { to: order.buyer_id,  type: 'order_confirmed',  title: 'Order Confirmed',       message: 'Your order has been confirmed.' },
        preparing:  { to: order.buyer_id,  type: 'order_preparing',  title: 'Order Being Prepared',  message: 'Your order is being prepared.' },
        dispatched: { to: order.buyer_id,  type: 'order_dispatched', title: 'Order On The Way',      message: 'Your order is on the way.' },
        delivered:  { to: order.seller_id, type: 'order_delivered',  title: 'Order Delivered',       message: `Order marked as delivered by ${full_name}.` },
        cancelled:  { to: order.seller_id, type: 'order_cancelled',  title: 'Order Cancelled',       message: `Order was cancelled by ${full_name}.` },
      };
      const n = notifMap[status];
      if (n) await notify(client, { userId: n.to, type: n.type, title: n.title, message: n.message, orderId: req.params.id });
    });

    res.json({ success: true, message: `Order marked as ${status}.` });
  } catch (err) {
    console.error('PATCH /orders/:id/status', err);
    res.status(err.status || 500).json({ success: false, message: err.status ? err.message : 'Failed to update order status.' });
  }
});

// POST /api/orders/:id/proof — upload payment proof
router.post('/:id/proof', upload.single('proof'), async (req, res) => {
  try {
    const { id: buyerId } = req.user;

    if (!req.file)
      return res.status(400).json({ success: false, message: 'No file uploaded.' });

    const { rows: orderRows } = await queryAsUser(req.user, 
      `SELECT * FROM orders WHERE id = $1 AND buyer_id = $2`,
      [req.params.id, buyerId]
    );
    if (!orderRows.length)
      return res.status(404).json({ success: false, message: 'Order not found.' });

    const eligible = orderRows[0];
    if (eligible.status !== 'pending' || eligible.payment_method !== 'online' ||
        eligible.proof_status === 'verified' || (eligible.proof_status === 'pending' && eligible.payment_proof_url?.trim())) {
      return res.status(409).json({ success: false, message: 'This order is not awaiting a new payment proof.' });
    }
    const { createClient } = require('@supabase/supabase-js');
    const WebSocket = require('ws');
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { realtime: { transport: WebSocket } }
    );

    const ext      = path.extname(req.file.originalname).toLowerCase();
    const fileName = `order-proof-${req.params.id}-${Date.now()}${ext}`;

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
      const { rows } = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!rows[0] || rows[0].status !== eligible.status || rows[0].proof_status !== eligible.proof_status || rows[0].payment_proof_url !== eligible.payment_proof_url) {
        throw Object.assign(new Error('Order changed. Refresh and try again.'), { status: 409 });
      }
      await client.query(
        `UPDATE orders
         SET payment_proof_url = $1,
             proof_uploaded_at = NOW(),
             proof_status      = 'pending'
         WHERE id = $2`,
        [publicUrl, req.params.id]
      );
      await notify(client, {
        userId:  orderRows[0].seller_id,
        type:    'proof_uploaded',
        title:   'Payment Proof Uploaded',
        message: 'Buyer uploaded payment proof. Please verify.',
        orderId: req.params.id,
      });
    });

    res.json({ success: true, data: { url: publicUrl } });
  } catch (err) {
    console.error('POST /orders/:id/proof', err);
    res.status(err.status || 500).json({ success: false, message: err.status ? err.message : 'Failed to upload proof.' });
  }
});

// PATCH /api/orders/:id — update proof_status / confirm payment
router.patch('/:id', async (req, res) => {
  try {
    const { id: userId } = req.user;
    const { proof_status, status } = req.body;
    if (status !== undefined || !['verified', 'rejected'].includes(proof_status)) {
      return res.status(400).json({ success: false, message: 'Use a valid payment review decision; order status has a separate endpoint.' });
    }

    const { rows: orderRows } = await queryAsUser(req.user, 
      `SELECT * FROM orders WHERE id = $1`, [req.params.id]
    );
    if (!orderRows.length)
      return res.status(404).json({ success: false, message: 'Order not found.' });
    const order = orderRows[0];

    if (order.seller_id !== userId)
      return res.status(403).json({ success: false, message: 'Only the seller can verify proof.' });

    await withTransaction(async (client) => {
      const { rows } = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [req.params.id]);
      const current = rows[0];
      if (!current || current.status !== 'pending' || current.payment_method !== 'online' || current.proof_status !== 'pending' || !current.payment_proof_url?.trim()) {
        throw Object.assign(new Error('Only uploaded payment proof on a pending online order can be reviewed.'), { status: 409 });
      }
      await client.query(
        `UPDATE orders
         SET proof_status = COALESCE($1, proof_status),
             status       = COALESCE($2, status)
         WHERE id = $3`,
        [proof_status ?? null, status ?? null, req.params.id]
      );

      if (proof_status === 'verified') {
        await notify(client, {
          userId:  order.buyer_id,
          type:    'proof_verified',
          title:   'Payment Verified',
          message: 'Your payment proof has been verified. Awaiting order confirmation.',
          orderId: req.params.id,
        });
      } else if (proof_status === 'rejected') {
        await notify(client, {
          userId:  order.buyer_id,
          type:    'proof_rejected',
          title:   'Payment Proof Rejected',
          message: 'Your payment proof was rejected. Please upload a new one.',
          orderId: req.params.id,
        });
      }
    });

    res.json({ success: true, message: 'Order updated.' });
  } catch (err) {
    console.error('PATCH /orders/:id', err);
    res.status(err.status || 500).json({ success: false, message: err.status ? err.message : 'Failed to update order.' });
  }
});

module.exports = router;

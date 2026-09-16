// backend/routes/admin.js
const express   = require('express');
const { query, queryAsUser } = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);
router.use(authorize('admin'));

// GET /api/admin/analytics
router.get('/analytics', async (req, res) => {
  try {
    const [usersRes, productsRes, ordersRes, agreementsRes, revenueRes] = await Promise.all([
      queryAsUser(req.user, `SELECT role, COUNT(*) FROM users WHERE role != 'admin' GROUP BY role`),
      queryAsUser(req.user, `SELECT status, COUNT(*) FROM products GROUP BY status`),
      queryAsUser(req.user, `SELECT status, COUNT(*) FROM orders GROUP BY status`),
      queryAsUser(req.user, `SELECT status, COUNT(*) FROM agreements GROUP BY status`),
      queryAsUser(req.user, `SELECT COALESCE(SUM(total_amount),0) AS total FROM orders WHERE status = 'delivered'`),
    ]);

    res.json({
      success: true,
      data: {
        users:      usersRes.rows,
        products:   productsRes.rows,
        orders:     ordersRes.rows,
        agreements: agreementsRes.rows,
        revenue:    revenueRes.rows[0],
      },
    });
  } catch (err) {
    console.error('GET /admin/analytics', err);
    res.status(500).json({ success: false, message: 'Failed to load analytics.' });
  }
});

// GET /api/admin/users
router.get('/users', async (req, res) => {
  try {
    const { role, status, search, limit = 50, offset = 0 } = req.query;
    let sql = `
      SELECT id, full_name, email, phone_number, barangay,
             role, account_status, created_at, last_login_at
      FROM users WHERE role != 'admin'
    `;
    const params = [];
    let i = 1;

    if (role)   { sql += ` AND role = $${i++}`;           params.push(role); }
    if (status) { sql += ` AND account_status = $${i++}`; params.push(status); }
    if (search) {
      sql += ` AND (full_name ILIKE $${i} OR email ILIKE $${i++})`;
      params.push(`%${search}%`);
    }

    sql += ` ORDER BY created_at DESC LIMIT $${i++} OFFSET $${i++}`;
    params.push(parseInt(limit), parseInt(offset));

    const { rows } = await queryAsUser(req.user, sql, params);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('GET /admin/users', err);
    res.status(500).json({ success: false, message: 'Failed to load users.' });
  }
});

// GET /api/admin/users/:id
router.get('/users/:id', async (req, res) => {
  try {
    const { rows } = await queryAsUser(req.user,
      `SELECT u.id, u.full_name, u.email, u.phone_number,
              u.barangay, u.role, u.account_status,
              u.created_at, u.last_login_at,
              COUNT(DISTINCT o.id)  AS order_count,
              COUNT(DISTINCT a.id)  AS agreement_count
       FROM users u
       LEFT JOIN orders     o ON o.buyer_id  = u.id OR o.seller_id = u.id
       LEFT JOIN agreements a ON a.buyer_id  = u.id OR a.seller_id = u.id
       WHERE u.id = $1
       GROUP BY u.id`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'User not found.' });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('GET /admin/users/:id', err);
    res.status(500).json({ success: false, message: 'Failed to load user.' });
  }
});

// PATCH /api/admin/users/:id — block / unblock
router.patch('/users/:id', async (req, res) => {
  try {
    const { account_status } = req.body;
    if (!['active','blocked'].includes(account_status)) {
      return res.status(400).json({ success: false, message: 'account_status must be active or blocked.' });
    }

    const { rows } = await queryAsUser(req.user,
      `UPDATE users SET account_status = $1
       WHERE id = $2 AND role != 'admin'
       RETURNING id, full_name, account_status`,
      [account_status, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'User not found.' });

    // Notify the user -- kept on the privileged connection: this INSERT
    // targets a DIFFERENT user's notifications row than the acting admin,
    // and notifications RLS doesn't yet have a policy for that pattern
    // (see the write-side migration notes elsewhere in this codebase).
    await query(
      `INSERT INTO notifications (user_id, type, title, message)
       VALUES ($1, 'account_blocked', $2, $3)`,
      [
        req.params.id,
        account_status === 'blocked' ? 'Account Restricted' : 'Account Restored',
        account_status === 'blocked'
          ? 'Your account has been restricted by an administrator.'
          : 'Your account has been restored. You can now log in.',
      ]
    );

    res.json({ success: true, data: rows[0], message: `User ${account_status === 'blocked' ? 'blocked' : 'unblocked'}.` });
  } catch (err) {
    console.error('PATCH /admin/users/:id', err);
    res.status(500).json({ success: false, message: 'Failed to update user.' });
  }
});

// GET /api/admin/orders — all orders
router.get('/orders', async (req, res) => {
  try {
    const { status, limit = 50, offset = 0 } = req.query;
    let sql = `
      SELECT o.id, o.status, o.total_amount, o.created_at,
             buyer.full_name  AS buyer_name,  buyer.role AS buyer_role,
             seller.full_name AS seller_name, seller.role AS seller_role
      FROM orders o
      JOIN users buyer  ON buyer.id  = o.buyer_id
      JOIN users seller ON seller.id = o.seller_id
    `;
    const params = [];
    if (status) { sql += ` WHERE o.status = $1`; params.push(status); }
    sql += ` ORDER BY o.created_at DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`;
    params.push(parseInt(limit), parseInt(offset));

    const { rows } = await queryAsUser(req.user, sql, params);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('GET /admin/orders', err);
    res.status(500).json({ success: false, message: 'Failed to load orders.' });
  }
});

// GET /api/admin/agreements — all agreements
router.get('/agreements', async (req, res) => {
  try {
    const { status, limit = 50, offset = 0 } = req.query;
    let sql = `
      SELECT a.id, a.status, a.total_price, a.product_name,
             a.payment_proof_url, a.proof_status, a.created_at,
             buyer.full_name  AS buyer_name,
             seller.full_name AS seller_name, seller.role AS seller_role
      FROM agreements a
      JOIN users buyer  ON buyer.id  = a.buyer_id
      JOIN users seller ON seller.id = a.seller_id
    `;
    const params = [];
    if (status) { sql += ` WHERE a.status = $1`; params.push(status); }
    sql += ` ORDER BY a.created_at DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`;
    params.push(parseInt(limit), parseInt(offset));

    const { rows } = await queryAsUser(req.user, sql, params);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('GET /admin/agreements', err);
    res.status(500).json({ success: false, message: 'Failed to load agreements.' });
  }
});

// GET /api/admin/listings — all product listings, any seller/status
router.get('/listings', async (req, res) => {
  try {
    const { status, category, search, limit = 50, offset = 0 } = req.query;
    let sql = `
      SELECT p.id, p.name, p.category, p.price_per_unit, p.unit, p.stock_qty,
             p.status, p.is_perishable, p.created_at,
             u.id AS seller_id, u.full_name AS seller_name, u.role AS seller_role
      FROM products p
      JOIN users u ON u.id = p.seller_id
      WHERE 1=1
    `;
    const params = [];
    let i = 1;

    if (status)   { sql += ` AND p.status = $${i++}`;   params.push(status); }
    if (category) { sql += ` AND p.category = $${i++}`; params.push(category); }
    if (search)   { sql += ` AND p.name ILIKE $${i++}`; params.push(`%${search}%`); }

    sql += ` ORDER BY p.created_at DESC LIMIT $${i++} OFFSET $${i++}`;
    params.push(parseInt(limit), parseInt(offset));

    const { rows } = await queryAsUser(req.user, sql, params);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('GET /admin/listings', err);
    res.status(500).json({ success: false, message: 'Failed to load listings.' });
  }
});

// PATCH /api/admin/listings/:id — force-hide a listing (e.g. reported/inappropriate)
router.patch('/listings/:id', async (req, res) => {
  try {
    const { status } = req.body; // expects 'live' | 'hidden'
    if (!['live', 'hidden'].includes(status)) {
      return res.status(400).json({ success: false, message: 'status must be live or hidden.' });
    }
    const { rows } = await queryAsUser(req.user,
      `UPDATE products SET status = $1 WHERE id = $2 RETURNING id, name, status`,
      [status, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'Listing not found.' });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('PATCH /admin/listings/:id', err);
    res.status(500).json({ success: false, message: 'Failed to update listing.' });
  }
});

module.exports = router;
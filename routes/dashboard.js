// backend/routes/dashboard.js
const express   = require('express');
const { query } = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');
const { sellerRevenueSql } = require('../utils/sellerRevenue');

const router = express.Router();
router.use(authenticate);

// Real, new addition: every recent-orders query below now also
// returns the first item's product name and image, via a real
// LATERAL join against order_items/products -- previously only
// seller/buyer name and a total amount were returned, with no way
// to show what was actually ordered on the dashboard.
const _firstItemJoin = `
  LEFT JOIN LATERAL (
    SELECT p.name AS item_name, p.image_url AS item_image_url
    FROM order_items oi JOIN products p ON p.id = oi.product_id
    WHERE oi.order_id = o.id
    ORDER BY oi.id LIMIT 1
  ) first_item ON true
`;

// GET /api/dashboard/buyer
router.get('/buyer', authorize('buyer'), async (req, res) => {
  try {
    const { id } = req.user;
    const { rows } = await query(
      `SELECT active_agreements, total_orders, this_month, saved_farmers
       FROM buyer_dashboard_stats WHERE user_id = $1`, [id]
    );
    const stats = rows[0] ?? { active_agreements:0, total_orders:0, this_month:0, saved_farmers:0 };

    const { rows: recentOrders } = await query(
      `SELECT o.id, o.status, o.total_amount, o.created_at,
              u.full_name AS seller_name,
              first_item.item_name, first_item.item_image_url
       FROM orders o
       JOIN users u ON u.id = o.seller_id
       ${_firstItemJoin}
       WHERE o.buyer_id = $1 ORDER BY o.created_at DESC LIMIT 3`, [id]
    );
    const { rows: recentAgreements } = await query(
      `SELECT a.id, a.status, a.total_price, a.product_name, a.delivery_date,
              u.full_name AS seller_name
       FROM agreements a JOIN users u ON u.id = a.seller_id
       WHERE a.buyer_id = $1 AND a.status IN ('pending','active')
       ORDER BY a.created_at DESC LIMIT 3`, [id]
    );

    res.json({ success: true, data: {
      active_agreements:  parseInt(stats.active_agreements ?? 0),
      total_orders:       parseInt(stats.total_orders      ?? 0),
      this_month:         parseFloat(stats.this_month      ?? 0),
      saved_farmers:      parseInt(stats.saved_farmers     ?? 0),
      recent_orders:      recentOrders,
      recent_agreements:  recentAgreements,
    }});
  } catch (err) {
    console.error('GET /dashboard/buyer', err);
    res.status(500).json({ success: false, message: 'Failed to load dashboard.' });
  }
});

// GET /api/dashboard/farmer
router.get('/farmer', authorize('farmer'), async (req, res) => {
  try {
    const { id } = req.user;
    const { rows } = await query(
      `SELECT active_agreements, incoming_orders, ${sellerRevenueSql(true)} AS this_month, next_harvest
       FROM farmer_dashboard_stats WHERE user_id = $1`, [id]
    );
    const stats = rows[0] ?? { active_agreements:0, incoming_orders:0, this_month:0, next_harvest:null };

    const { rows: incomingOrders } = await query(
      `SELECT o.id, o.status, o.total_amount, o.created_at,
              u.full_name AS buyer_name, u.barangay AS buyer_barangay,
              first_item.item_name, first_item.item_image_url
       FROM orders o
       JOIN users u ON u.id = o.buyer_id
       ${_firstItemJoin}
       WHERE o.seller_id = $1 AND o.status IN ('pending','confirmed')
       ORDER BY o.created_at DESC LIMIT 3`, [id]
    );
    const { rows: upcomingHarvests } = await query(
      `SELECT id, crop_name, quantity_kg, expected_harvest, stage,
              (expected_harvest - CURRENT_DATE) AS days_remaining
       FROM crop_plans
       WHERE farmer_id = $1 AND stage != 'done' AND expected_harvest >= CURRENT_DATE
       ORDER BY expected_harvest ASC LIMIT 3`, [id]
    );

    res.json({ success: true, data: {
      active_agreements:  parseInt(stats.active_agreements  ?? 0),
      total_orders:       parseInt(stats.incoming_orders    ?? 0),
      this_month:         parseFloat(stats.this_month       ?? 0),
      next_harvest:       stats.next_harvest
        ? new Date(stats.next_harvest).toLocaleDateString('en-PH', { month:'short', day:'numeric' })
        : '—',
      incoming_orders:    incomingOrders,
      upcoming_harvests:  upcomingHarvests,
    }});
  } catch (err) {
    console.error('GET /dashboard/farmer', err);
    res.status(500).json({ success: false, message: 'Failed to load dashboard.' });
  }
});

// GET /api/dashboard/vendor
router.get('/vendor', authorize('vendor'), async (req, res) => {
  try {
    const { id } = req.user;
    const { rows } = await query(
      `SELECT active_listings, total_orders, ${sellerRevenueSql(false)} AS total_revenue,
              ${sellerRevenueSql(true)} AS this_month, active_agreements
       FROM vendor_dashboard_stats WHERE user_id = $1`, [id]
    );
    const stats = rows[0] ?? { active_listings:0, total_orders:0, total_revenue:0, this_month:0, active_agreements:0 };

    // Real bug fixed here: this previously filtered on
    // "o.buyer_id = $1" -- meaning a vendor's own dashboard showed
    // orders where THEY were the buyer, not the seller, alongside a
    // "seller_name" column that would then confusingly show their
    // own name back to them. A vendor's recent orders should show
    // who's buying FROM them, same as the farmer dashboard's
    // incoming_orders does.
    const { rows: recentOrders } = await query(
      `SELECT o.id, o.status, o.total_amount, o.created_at,
              u.full_name AS buyer_name,
              first_item.item_name, first_item.item_image_url
       FROM orders o
       JOIN users u ON u.id = o.buyer_id
       ${_firstItemJoin}
       WHERE o.seller_id = $1 ORDER BY o.created_at DESC LIMIT 3`, [id]
    );

    res.json({ success: true, data: {
      active_listings:   parseInt(stats.active_listings   ?? 0),
      total_orders:      parseInt(stats.total_orders      ?? 0),
      total_revenue:     parseFloat(stats.total_revenue   ?? 0),
      this_month:        parseFloat(stats.this_month      ?? 0),
      active_agreements: parseInt(stats.active_agreements ?? 0),
      recent_orders:     recentOrders,
    }});
  } catch (err) {
    console.error('GET /dashboard/vendor', err);
    res.status(500).json({ success: false, message: 'Failed to load dashboard.' });
  }
});

module.exports = router;

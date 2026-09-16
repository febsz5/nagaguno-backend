// backend/routes/notifications.js
const express   = require('express');
const { queryAsUser } = require('../config/database');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

// GET /api/notifications
router.get('/', async (req, res) => {
  try {
    const { rows } = await queryAsUser(req.user, 
      `SELECT id, type, title, message, order_id, agreement_id,
              is_read, read_at, created_at
       FROM notifications
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 30`,
      [req.user.id]
    );
    const unread = rows.filter(n => !n.is_read).length;
    res.json({ success: true, data: rows, unread });
  } catch (err) {
    console.error('GET /notifications', err);
    res.status(500).json({ success: false, message: 'Failed to load notifications.' });
  }
});

// PATCH /api/notifications/read-all
router.patch('/read-all', async (req, res) => {
  try {
    await queryAsUser(req.user, 
      `UPDATE notifications
       SET is_read = true, read_at = NOW()
       WHERE user_id = $1 AND is_read = false`,
      [req.user.id]
    );
    res.json({ success: true, message: 'All notifications marked as read.' });
  } catch (err) {
    console.error('PATCH /notifications/read-all', err);
    res.status(500).json({ success: false, message: 'Failed to mark notifications.' });
  }
});

// PATCH /api/notifications/:id/read
router.patch('/:id/read', async (req, res) => {
  try {
    const { rows } = await queryAsUser(req.user, 
      `UPDATE notifications
       SET is_read = true, read_at = NOW()
       WHERE id = $1 AND user_id = $2
       RETURNING id`,
      [req.params.id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'Notification not found.' });
    res.json({ success: true, message: 'Notification marked as read.' });
  } catch (err) {
    console.error('PATCH /notifications/:id/read', err);
    res.status(500).json({ success: false, message: 'Failed to mark notification.' });
  }
});

module.exports = router;
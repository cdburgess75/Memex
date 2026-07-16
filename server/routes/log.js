'use strict';
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const db = require('../lib/db');

// Admin-only: this feed exposes other users' emails and activity. The client only
// surfaces it on the admin-gated Activity tab; enforce that on the server too.
router.get('/', auth, requireRole('admin'), async (req, res) => {
  try {
    const rows = await db.query(
      'SELECT id, event, user_email, created_at FROM activity_log ORDER BY created_at DESC LIMIT 40'
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

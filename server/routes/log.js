'use strict';
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const db = require('../lib/db');

router.get('/', auth, async (req, res) => {
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

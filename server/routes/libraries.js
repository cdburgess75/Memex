'use strict';
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const libraries = require('../lib/libraries');

// GET /api/libraries — list libraries
router.get('/', auth, async (req, res) => {
  try {
    res.json(await libraries.listLibraries());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/libraries — create a library (admin/contributor)
router.post('/', auth, requireRole('admin', 'contributor'), async (req, res) => {
  try {
    const name = (req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name required' });
    res.json(await libraries.createLibrary({ name, user: req.user }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

'use strict';
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const libraries = require('../lib/libraries');

// GET /api/libraries — list libraries the caller can access
router.get('/', auth, async (req, res) => {
  try {
    res.json(await libraries.listLibraries(req.user));
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

// GET /api/libraries/:id/members — list members (admin)
router.get('/:id/members', auth, requireRole('admin'), async (req, res) => {
  try {
    res.json(await libraries.listMembers(req.params.id));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/libraries/:id/members — add a member by email (admin)
router.post('/:id/members', auth, requireRole('admin'), async (req, res) => {
  try {
    const email = (req.body?.email || '').trim();
    if (!email) return res.status(400).json({ error: 'email required' });
    res.json(await libraries.addMember(req.params.id, { email, user: req.user }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/libraries/:id/members/:memberId — remove a member (admin)
router.delete('/:id/members/:memberId', auth, requireRole('admin'), async (req, res) => {
  try {
    const removed = await libraries.removeMember(req.params.id, req.params.memberId);
    if (!removed) return res.status(404).json({ error: 'member not found' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

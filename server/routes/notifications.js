'use strict';
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const notifications = require('../lib/notifications');
const email = require('../lib/email');

// GET /api/notifications — recent notifications + unread count + the user's pref.
router.get('/', auth, async (req, res) => {
  try {
    const [items, unread, enabled] = await Promise.all([
      notifications.listForUser(req.user, 50),
      notifications.unreadCount(req.user),
      notifications.getPref(req.user),
    ]);
    res.json({ notifications: items, unread, enabled });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/notifications/read — { all: true } or { ids: [...] }
router.post('/read', auth, async (req, res) => {
  try {
    const updated = req.body?.all
      ? await notifications.markAllRead(req.user)
      : await notifications.markRead(req.user, req.body?.ids || []);
    res.json({ updated });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/notifications/pref — { enabled: bool } (per-user in-app opt-out).
router.put('/pref', auth, async (req, res) => {
  try {
    const enabled = await notifications.setPref(req.user, req.body?.enabled !== false);
    res.json({ enabled });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/notifications/test-email — admin: verify SMTP config by mailing self.
router.post('/test-email', auth, requireRole('admin'), async (req, res) => {
  try {
    const r = await email.sendMail({
      to: req.user.email,
      subject: 'Memex test email',
      text: 'This is a test email from Memex. If you received it, your SMTP settings are working.',
    });
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;

'use strict';
const { serverError } = require('../lib/httpError');
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
    // What email this person can expect, so their Notifications tab can say so truthfully.
    // (It used to say, to everyone who was not an admin, that email was "coming soon".)
    // Only on/off facts: nothing about the mail server itself leaves the admin settings.
    let mail = { configured: false, events: {} };
    try {
      const emailLib = require('../lib/email'), emailEvents = require('../lib/emailEvents');
      const names = Object.keys(emailEvents.DEFAULTS);
      const on = await Promise.all(names.map(n => emailEvents.enabled(n)));
      mail = { configured: !!(await emailLib.isConfigured()), events: Object.fromEntries(names.map((n, i) => [n, !!on[i]])) };
    } catch (e) { /* the tab falls back to saying it could not tell */ }
    res.json({ notifications: items, unread, enabled, email: mail });
  } catch (e) { serverError(res, e); }
});

// POST /api/notifications/read — { all: true } or { ids: [...] }
router.post('/read', auth, async (req, res) => {
  try {
    const updated = req.body?.all
      ? await notifications.markAllRead(req.user)
      : await notifications.markRead(req.user, req.body?.ids || []);
    res.json({ updated });
  } catch (e) { serverError(res, e); }
});

// PUT /api/notifications/pref — { enabled: bool } (per-user in-app opt-out).
router.put('/pref', auth, async (req, res) => {
  try {
    const enabled = await notifications.setPref(req.user, req.body?.enabled !== false);
    res.json({ enabled });
  } catch (e) { serverError(res, e); }
});

// POST /api/notifications/test-email — admin: verify SMTP config by mailing self.
router.post('/test-email', auth, requireRole('admin'), async (req, res) => {
  try {
    const r = await email.sendMail({
      to: req.user.email,
      subject: 'Depot test email',
      text: 'This is a test email from Depot. If you received it, your email provider (Microsoft Graph or SMTP relay) is configured correctly.',
      actorEmail: email.actingAs(req.user).sendAs,
    });
    res.json(r);
  } catch (e) { serverError(res, e); }
});

module.exports = router;

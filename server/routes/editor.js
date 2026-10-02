'use strict';
// The in-browser editing switch (Settings → Branding & links). Any workspace admin can turn
// Office editing on or off; the host starts or stops the editor to match within a
// minute (see lib/editorStatus.js).
const express = require('express');
const router = express.Router();
const { serverError } = require('../lib/httpError');
const auth = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const editorStatus = require('../lib/editorStatus');

// GET /api/admin/editor — the switch and whether the editor is answering.
router.get('/', auth, requireRole('admin'), async (req, res) => {
  try { res.json(await editorStatus.status()); }
  catch (e) { serverError(res, e); }
});

// PUT /api/admin/editor  { enabled: true|false }
router.put('/', auth, requireRole('admin'), async (req, res) => {
  try {
    if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be true or false' });
    const before = await editorStatus.switchedOn();
    await editorStatus.setSwitch(req.body.enabled, req.user.id);
    if (before !== req.body.enabled) {
      try {
        await require('../lib/auditLog').append({
          eventType: 'settings_changed', actorId: req.user.id, actorEmail: req.user.email,
          detail: `in-browser editing switched ${req.body.enabled ? 'on' : 'off'}`,
        });
      } catch (e) { console.error('audit editor switch failed:', e.message); }
    }
    res.json(await editorStatus.status());
  } catch (e) { serverError(res, e); }
});

module.exports = router;

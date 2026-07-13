'use strict';
// License status + an OPT-IN one-click updater. The header's "Update available"
// action is gated on GET /api/license reporting updatesEntitled=true.
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const license = require('../lib/license');

// GET /api/license — entitlement status for the signed-in user. Safe fields only
// (never the signature). Any authenticated user may read it; only the client's
// admin UI acts on it.
router.get('/', auth, async (req, res) => {
  try {
    res.json(await license.status());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/license/update-run — perform the operator-configured update, but ONLY
// when ALL of these hold, so this can never become an on-demand RCE:
//   1. caller is an admin,
//   2. the license currently entitles updates,
//   3. the operator set MEMEX_UPDATE_COMMAND in the container env (never via the
//      web settings — it is deliberately absent from ENV_MAP).
// With no command configured the endpoint is inert and the UI shows manual steps.
router.post('/update-run', auth, requireRole('admin'), async (req, res) => {
  try {
    const st = await license.status();
    if (!st.updatesEntitled) {
      return res.status(403).json({ ok: false, reason: st.reason || 'not_entitled' });
    }
    const cmd = String(process.env.MEMEX_UPDATE_COMMAND || '').trim();
    if (!cmd) return res.json({ ok: false, reason: 'no_updater_configured' });

    const { exec } = require('child_process');
    exec(cmd, { timeout: 15 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const clip = (s) => String(s || '').slice(-4000);
      if (err && err.killed) return res.json({ ok: false, reason: 'timeout', output: clip(stdout) + clip(stderr) });
      if (err) return res.json({ ok: false, reason: 'command_failed', code: err.code ?? null, output: clip(stdout) + clip(stderr) });
      res.json({ ok: true, output: clip(stdout) + clip(stderr) });
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

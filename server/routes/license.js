'use strict';
const { serverError } = require('../lib/httpError');
// License status + an OPT-IN one-click updater. The header's "Update available"
// action is gated on GET /api/license reporting updatesEntitled=true.
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const license = require('../lib/license');
const enforce = require('../lib/licenseEnforce');
const licenseWatch = require('../lib/licenseWatch');
const auditLog = require('../lib/auditLog');

// The status as the client sees it: what the server evaluated, plus the seats in use.
async function withSeats(st) {
  st.enforcing = enforce.enforcing();
  if (st.seats) {
    st.seats.used = await enforce.seatsUsed();
    st.seats.overCap = st.seats.licensed != null && st.seats.used != null && st.seats.used > st.seats.licensed;
  }
  return st;
}

// GET /api/license — entitlement status for the signed-in user. Safe fields only
// (never the signature). Any authenticated user may read it; only the client's
// admin UI acts on it.
router.get('/', auth, async (req, res) => {
  try {
    const st = await license.status();
    enforce.prime(st);
    res.json(await withSeats(st));
  } catch (e) {
    serverError(res, e);
  }
});

// POST /api/license — an administrator installs a renewed license: { license } is the
// file's text, the parsed object, or the same JSON base64-encoded. Only a version 2
// license this server would accept is kept (lib/license.js install). Works while the
// server is read-only, because this is how read-only ends (middleware/licenseGate).
// Both outcomes go to the audit log; a refusal says why in `reason`.
router.post('/', auth, requireRole('admin'), async (req, res) => {
  const actor = { actorId: req.user.id, actorEmail: req.user.email || null };
  try {
    const r = await license.install(req.body?.license, req.user.id);
    if (!r.ok) {
      auditLog.append({ eventType: 'license_install_refused', ...actor, detail: `${r.reason}${r.serial ? ` (${r.serial})` : ''}` }).catch(() => {});
      return res.status(400).json({ error: 'That license cannot be installed on this server.', code: 'LICENSE_REFUSED', reason: r.reason });
    }
    const st = r.status;
    enforce.prime(st); // read-only lifts on this request, not at the next refresh
    auditLog.append({ eventType: 'license_installed', ...actor, detail: `${st.serial || 'license'}${st.expires ? `, term through ${st.expires}` : ''}` }).catch(() => {});
    await licenseWatch.check().catch(() => {}); // records the state change and sends "renewed" now
    res.json(await withSeats(st));
  } catch (e) {
    serverError(res, e);
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
    serverError(res, e);
  }
});

module.exports = router;

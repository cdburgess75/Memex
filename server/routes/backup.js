'use strict';
const express = require('express');
const router = express.Router();
const fs = require('fs');
const auth = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const settings = require('../lib/settings');
const backup = require('../lib/backup');

const MASKED = '●●●●●●●●';

function parseDest(json) {
  if (!json) return [];
  try { const p = JSON.parse(json); return Array.isArray(p) ? p : []; } catch { return []; }
}
const destKey = d => d.id || `${d.type}:${d.label || ''}`;
function maskDest(arr) {
  return arr.map(d => ({ ...d, secret_access_key: d.secret_access_key ? MASKED : '' }));
}
// A still-masked secret means "keep current" — restore it from the stored destination.
function mergeDest(incoming, stored) {
  return incoming.map(d => {
    if (d.secret_access_key === MASKED) {
      const prev = stored.find(s => destKey(s) === destKey(d));
      return { ...d, secret_access_key: prev ? (prev.secret_access_key || '') : '' };
    }
    return d;
  });
}

// GET /api/backup/config — current config (secrets masked) + status
router.get('/config', auth, requireRole('admin'), async (_req, res) => {
  try {
    const cfg = await backup.getConfig();
    res.json({ config: { ...cfg, destinations: maskDest(cfg.destinations) }, status: await backup.status() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/backup/config — update schedule/retention/destinations
router.put('/config', auth, requireRole('admin'), async (req, res) => {
  try {
    const b = req.body || {};
    if (b.enabled !== undefined) await settings.set('backup_enabled', b.enabled ? 'true' : 'false', req.user.id);
    if (b.interval_hours !== undefined) await settings.set('backup_interval_hours', String(Math.max(1, Number(b.interval_hours) || 24)), req.user.id);
    if (b.retention !== undefined) await settings.set('backup_retention', String(Math.max(1, Number(b.retention) || 7)), req.user.id);
    if (Array.isArray(b.destinations)) {
      const merged = mergeDest(b.destinations, parseDest(await settings.getOrEnv('backup_destinations')));
      await settings.set('backup_destinations', merged.length ? JSON.stringify(merged) : null, req.user.id);
    }
    await settings.refresh();
    await backup.reschedule();
    const cfg = await backup.getConfig();
    res.json({ ok: true, config: { ...cfg, destinations: maskDest(cfg.destinations) }, status: await backup.status() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/backup/run — run a backup now
router.post('/run', auth, requireRole('admin'), async (_req, res) => {
  try {
    const result = await backup.runBackup({ manual: true });
    res.json({ ok: true, result, status: await backup.status() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/backup/download/:name?token=... — signed, no session (for the "pull" destination)
router.get('/download/:name', async (req, res) => {
  const name = req.params.name;
  const p = backup.stagingPath(name);
  if (!p || !fs.existsSync(p)) return res.status(404).json({ error: 'not found' });
  if (!(await backup.verifyToken(name, req.query.token))) return res.status(403).json({ error: 'invalid or expired token' });
  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  fs.createReadStream(p).pipe(res);
});

module.exports = router;

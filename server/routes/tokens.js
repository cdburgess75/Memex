'use strict';
// Personal access tokens, managed from Settings (lib/apiTokens). These routes take the
// ordinary sign-in only: a token cannot make or list tokens.
const { serverError } = require('../lib/httpError');
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const apiTokens = require('../lib/apiTokens');
const auditLog = require('../lib/auditLog');

const failed = (res, e) => (e && e.status ? res.status(e.status).json({ error: e.message }) : serverError(res, e));

// GET /api/tokens — the caller's live tokens (never the tokens themselves).
router.get('/', auth, async (req, res) => {
  try { res.json({ tokens: await apiTokens.listFor(req.user.id), scopes: apiTokens.SCOPES }); }
  catch (e) { failed(res, e); }
});

// POST /api/tokens { name, scope, expires_in_days? } — make one. The token is in the
// answer this once and nowhere else.
router.post('/', auth, async (req, res) => {
  try {
    const enforce = require('../lib/licenseEnforce');
    if (!(await enforce.feature('api'))) return enforce.refuseFeature(res, 'The API');
    const days = req.body?.expires_in_days;
    let expiresAt = null;
    if (days != null && days !== '' && days !== 0 && days !== '0') {
      const n = Number(days);
      if (!Number.isFinite(n) || n <= 0 || n > 3650) return res.status(400).json({ error: 'expires_in_days must be between 1 and 3650, or left out' });
      expiresAt = new Date(Date.now() + n * 86400000);
    }
    const out = await apiTokens.create({ user: req.user, name: req.body?.name, scope: req.body?.scope, expiresAt });
    auditLog.append({ eventType: 'api_token_created', actorId: req.user.id, actorEmail: req.user.email,
      detail: `token ${JSON.stringify(out.record.name)} · ${out.record.scope}${expiresAt ? ` · expires ${expiresAt.toISOString().slice(0, 10)}` : ' · no expiry'}` }).catch(() => {});
    res.status(201).json({ token: out.token, ...out.record });
  } catch (e) { failed(res, e); }
});

// DELETE /api/tokens/:id — revoke one of the caller's own.
router.delete('/:id', auth, async (req, res) => {
  try {
    const gone = await apiTokens.revoke(req.params.id, { byUser: req.user });
    if (!gone) return res.status(404).json({ error: 'Token not found' });
    auditLog.append({ eventType: 'api_token_revoked', actorId: req.user.id, actorEmail: req.user.email, detail: `token ${JSON.stringify(gone.name)}` }).catch(() => {});
    res.json({ ok: true });
  } catch (e) { failed(res, e); }
});

// Administrators: every live token in the workspace, and revoking any of them.
router.get('/all', auth, requireRole('admin'), async (_req, res) => {
  try { res.json({ tokens: await apiTokens.listAll() }); } catch (e) { failed(res, e); }
});
router.delete('/all/:id', auth, requireRole('admin'), async (req, res) => {
  try {
    const gone = await apiTokens.revoke(req.params.id, { byUser: req.user, anyUser: true });
    if (!gone) return res.status(404).json({ error: 'Token not found' });
    auditLog.append({ eventType: 'api_token_revoked', actorId: req.user.id, actorEmail: req.user.email, detail: `token ${JSON.stringify(gone.name)} of user ${gone.user_id} · by an administrator` }).catch(() => {});
    res.json({ ok: true });
  } catch (e) { failed(res, e); }
});

module.exports = router;

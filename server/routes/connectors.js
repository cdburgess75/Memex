'use strict';
// External storage connections — browse and stream files that live in systems Depot
// does not own (SMB shares, SharePoint libraries, and whatever adapters follow).
//
// Pass-through by design: nothing here writes to `documents`. A connector request
// reaches the remote system on the caller's behalf and streams the result, so the
// remote system stays the source of truth.
const express = require('express');
const { Readable } = require('stream');
const router = express.Router();
const auth = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const connectors = require('../lib/connectors');
const base = require('../lib/connectors/base');
const audit = require('../lib/auditLog');
const keycloakAdmin = require('../lib/keycloakAdmin');
const smbSessionCreds = require('../lib/smbSessionCreds');
const { rateLimit } = require('express-rate-limit');
const { rateLimitEnabled, intFromEnv } = require('../lib/rateLimiters');

// Tight limiter on the per-user SMB unlock endpoint. That route live-authenticates
// the domain credentials in its body against the real file server, so without a cap a
// signed-in user could turn it into a password-spraying tool OR an account-lockout DoS
// (repeated wrong passwords for a colleague's username trips AD lockout). Keyed by the
// authenticated user — a legitimate unlock needs a couple of tries at most.
const smbUnlockLimiter = rateLimitEnabled()
  ? rateLimit({
      windowMs: intFromEnv('RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000),
      limit: intFromEnv('RATE_LIMIT_SMB_UNLOCK_MAX', 10),
      standardHeaders: 'draft-7', legacyHeaders: false,
      keyGenerator: (req) => (req.user && req.user.id) || req.ip,
      message: { error: 'Too many unlock attempts. Wait a few minutes and try again.' },
    })
  : (_req, _res, next) => next();

// Gate content access to a connector, then hand the adapter what it needs.
//
// Delegated connectors defer ENTIRELY to the upstream system: SharePoint/365 (and,
// for SMB, NTFS) is the sole authority over what each user may read or write, so
// Depot adds no permission layer of its own — it just supplies the caller's own
// identity and lets the remote system decide per file:
//   - SharePoint: the user's Microsoft Graph token, from Keycloak's broker.
//   - SMB: the user's own domain credentials, unlocked for this session (they have no
//     browser SSO), so NTFS decides. A 428 tells the client to prompt for them.
// App-only connectors reach the remote system as a single shared service identity that
// does NOT reflect the caller, so Depot must gate those itself: real members only.
//
// (Connector management — create / edit / delete / test — stays admin-only via
// requireRole on those routes; this governs only the browse/read/write data path.)
async function accessConnector(req, row, cfg) {
  if (cfg && cfg.delegated) {
    if (row.kind === 'sharepoint') {
      cfg.delegatedToken = await keycloakAdmin.getBrokerToken(req.headers.authorization);
    } else if (row.kind === 'smb') {
      const creds = smbSessionCreds.get(req.user.id, row.id);
      if (!creds) {
        const e = new Error('Unlock this share with your own network credentials to continue.');
        e.status = 428; e.code = 'SMB_CREDENTIALS_REQUIRED';
        throw e;
      }
      cfg.domain = creds.domain || cfg.domain;
      cfg.username = creds.username;
      cfg.password = creds.password;
    }
    return;
  }
  const role = req.user && req.user.role;
  if (role !== 'admin' && role !== 'contributor') {
    const e = new Error('You don’t have access to this connection.');
    e.status = 403;
    throw e;
  }
}

// Adapters and the registry throw errors carrying an HTTP status; anything without
// one is a genuine surprise and should not leak its message to the client.
function fail(res, e, fallback = 'connector error') {
  const status = e && e.status ? e.status : 500;
  if (status >= 500) console.error('[connectors]', e);
  // A machine-readable `code` (e.g. SMB_CREDENTIALS_REQUIRED) rides along for the
  // client to branch on — never a raw internal message.
  res.status(status).json({ error: status >= 500 ? fallback : e.message, ...(e && e.code ? { code: e.code } : {}) });
}

// Fire-and-forget: auditing must never block or fail a file operation.
function record(req, eventType, detail) {
  audit.append({
    eventType, actorId: req.user?.id, actorEmail: req.user?.email, detail: String(detail).slice(0, 500),
  }).catch(() => {});
}

/* ---------- catalog + management (admin) ---------- */

// The provider catalog the Settings UI renders its forms from.
router.get('/kinds', auth, requireRole('admin'), (_req, res) => {
  res.json({ kinds: connectors.catalog() });
});

// Admins get the full record; everyone else gets just enough to browse a mount, since
// `config` can carry internal hostnames and share paths.
router.get('/', auth, async (req, res) => {
  try {
    const all = await connectors.list();
    if (req.user.role === 'admin') return res.json({ connectors: all });
    res.json({
      connectors: all.filter((c) => c.enabled).map((c) => ({
        id: c.id, name: c.name, kind: c.kind, label: c.label, readOnly: c.readOnly, caps: c.caps,
        // Non-secret: lets the UI know a mount is per-user (offer a "lock" action) —
        // never exposes the connector's config or service credentials.
        delegated: !!(c.config && c.config.delegated),
      })),
    });
  } catch (e) { fail(res, e, 'could not list connections'); }
});

router.post('/', auth, requireRole('admin'), async (req, res) => {
  try {
    const created = await connectors.create(req.body || {}, req.user.id);
    record(req, 'connector_created', `${created.kind} "${created.name}"`);
    res.status(201).json(created);
  } catch (e) { fail(res, e, 'could not create the connection'); }
});

router.put('/:id', auth, requireRole('admin'), async (req, res) => {
  try {
    const updated = await connectors.update(req.params.id, req.body || {});
    record(req, 'connector_updated', `${updated.kind} "${updated.name}"`);
    res.json(updated);
  } catch (e) { fail(res, e, 'could not update the connection'); }
});

router.delete('/:id', auth, requireRole('admin'), async (req, res) => {
  try {
    const row = await connectors.getRow(req.params.id);
    await connectors.remove(req.params.id);
    record(req, 'connector_deleted', `${row.kind} "${row.name}"`);
    res.json({ ok: true });
  } catch (e) { fail(res, e, 'could not delete the connection'); }
});

// Prove the credentials and the root path before a user ever trips over a broken mount.
router.post('/:id/test', auth, requireRole('admin'), async (req, res) => {
  let id = req.params.id;
  try {
    const { row, adapter, cfg } = await connectors.resolve(id);
    await accessConnector(req, row, cfg);
    const result = await adapter.test(cfg);
    await connectors.recordTest(id, true, null);
    res.json({ ok: true, message: result?.message || 'Connected.' });
  } catch (e) {
    // A delegated SMB connector has no service credential to test — each user verifies
    // it when they unlock with their own sign-in. Don't mark it failed for that.
    if (e.code === 'SMB_CREDENTIALS_REQUIRED') {
      return res.status(200).json({ ok: true, message: 'Per-user connection — each user unlocks it with their own network sign-in.' });
    }
    await connectors.recordTest(id, false, e.message).catch(() => {});
    res.status(200).json({ ok: false, message: e.message });
  }
});

/* ---------- pass-through file operations ---------- */
// Content access is gated per connector by accessConnector(): delegated connectors
// defer to the upstream system (365/NTFS decides), app-only connectors are gated by
// Depot (real members only). See the accessConnector comment above.
router.get('/:id/browse', auth, async (req, res) => {
  try {
    const { row, adapter, cfg } = await connectors.resolve(req.params.id);
    await accessConnector(req, row, cfg);
    const path = base.normalizePath(req.query.path || '');
    const entries = await adapter.list(cfg, path);
    res.json({ path, entries });
  } catch (e) { fail(res, e, 'could not browse that location'); }
});

router.get('/:id/file', auth, async (req, res) => {
  try {
    const { row, adapter, cfg } = await connectors.resolve(req.params.id);
    await accessConnector(req, row, cfg);
    const path = base.normalizePath(req.query.path || '');
    if (!path) return res.status(400).json({ error: 'path required' });

    // Honor a byte range where the adapter supports it, so media scrubbing and
    // resumable downloads work against the remote system rather than pulling it whole.
    let range;
    const hdr = req.headers.range;
    if (hdr && adapter.caps.range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(String(hdr).trim());
      if (m && m[1]) range = { start: Number(m[1]), end: m[2] ? Number(m[2]) : undefined };
    }

    const out = await adapter.read(cfg, path, { range });
    const name = path.split('/').pop();
    res.setHeader('Content-Type', out.mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${name.replace(/"/g, '')}"`);
    if (out.size != null && !range) res.setHeader('Content-Length', String(out.size));
    if (range) res.status(206);

    record(req, 'connector_read', `${row.name}:${path}`);

    // SMB hands back a Node stream; Graph hands back a web ReadableStream.
    const stream = typeof out.stream?.pipe === 'function' ? out.stream : Readable.fromWeb(out.stream);
    stream.on('error', (err) => {
      console.error('[connectors] stream', err);
      if (!res.headersSent) res.status(502).json({ error: 'read failed' }); else res.destroy();
    });
    stream.pipe(res);
  } catch (e) { fail(res, e, 'could not read that file'); }
});

router.put('/:id/file', auth, async (req, res) => {
  try {
    const { row, adapter, cfg } = await connectors.resolve(req.params.id);
    await accessConnector(req, row, cfg);
    if (!cfg.delegated) base.assertCapability(adapter, row, 'write');
    const path = base.normalizePath(req.query.path || '');
    if (!path) return res.status(400).json({ error: 'path required' });
    await adapter.write(cfg, path, req);
    record(req, 'connector_write', `${row.name}:${path}`);
    res.json({ ok: true, path });
  } catch (e) { fail(res, e, 'could not write that file'); }
});

router.delete('/:id/file', auth, async (req, res) => {
  try {
    const { row, adapter, cfg } = await connectors.resolve(req.params.id);
    await accessConnector(req, row, cfg);
    if (!cfg.delegated) base.assertCapability(adapter, row, 'remove');
    const path = base.normalizePath(req.query.path || '');
    if (!path) return res.status(400).json({ error: 'path required' });
    await adapter.remove(cfg, path);
    record(req, 'connector_delete', `${row.name}:${path}`);
    res.json({ ok: true });
  } catch (e) { fail(res, e, 'could not delete that file'); }
});

router.post('/:id/folder', auth, async (req, res) => {
  try {
    const { row, adapter, cfg } = await connectors.resolve(req.params.id);
    await accessConnector(req, row, cfg);
    if (!cfg.delegated) base.assertCapability(adapter, row, 'mkdir');
    const path = base.normalizePath(req.body?.path || '');
    if (!path) return res.status(400).json({ error: 'path required' });
    await adapter.mkdir(cfg, path);
    record(req, 'connector_mkdir', `${row.name}:${path}`);
    res.status(201).json({ ok: true, path });
  } catch (e) { fail(res, e, 'could not create that folder'); }
});

/* ---------- per-user unlock for delegated SMB shares ---------- */

// Unlock a delegated SMB connection with the caller's OWN domain credentials, held in
// memory for this session only (never stored). We prove them against the share before
// keeping them, so a wrong password fails immediately and we never cache a bad one. The
// credentials are never logged or echoed back.
router.post('/:id/credentials', auth, smbUnlockLimiter, async (req, res) => {
  try {
    const { row, adapter, cfg } = await connectors.resolve(req.params.id);
    if (row.kind !== 'smb' || !cfg.delegated) {
      const e = new Error('This connection does not use per-user credentials.'); e.status = 400; throw e;
    }
    const domain = String(req.body?.domain || '').trim();
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    if (!username || !password) return res.status(400).json({ error: 'Username and password are required.' });
    // Verify by connecting AS the user before storing. Don't surface the raw SMB error
    // (it can leak server internals); a wrong-credential result is a clean ok:false.
    try {
      await adapter.test({ ...cfg, domain: domain || cfg.domain, username, password });
    } catch {
      return res.status(200).json({ ok: false, error: 'Could not connect with those credentials. Check your domain, username, and password.' });
    }
    smbSessionCreds.set(req.user.id, row.id, { domain: domain || cfg.domain, username, password });
    record(req, 'connector_unlock', `${row.name} (per-user)`);
    res.json({ ok: true });
  } catch (e) { fail(res, e, 'could not verify those credentials'); }
});

// Lock: forget the caller's stored credentials for this connection.
router.delete('/:id/credentials', auth, (req, res) => {
  smbSessionCreds.forget(req.user.id, req.params.id);
  res.json({ ok: true });
});

module.exports = router;

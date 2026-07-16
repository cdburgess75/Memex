require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const express = require('express');
const cors = require('cors');
const path = require('path');
const settings = require('./lib/settings');
const { makeRateLimiters } = require('./lib/rateLimiters');

const app = express();

// App version (vYYYY.MM.DD.NNN) — read from the VERSION file at the repo root
let VERSION = 'dev';
try {
  VERSION = require('fs').readFileSync(path.join(__dirname, '..', 'VERSION'), 'utf8').trim() || 'dev';
} catch { /* VERSION file optional */ }

// Dynamic CORS — origins configurable via admin settings.
// Default (no cors_origins set) is same-origin only: the SPA is served by this same
// server, so cross-origin XHR is not needed and reflecting arbitrary origins would be
// an unnecessary exposure. Admins widen it explicitly via Settings → cors_origins.
// Falls back to the last known-good value (or env var) on DB error rather than opening up.
let _lastCorsOpts = null;
app.use(cors((_req, callback) => {
  settings.getOrEnv('cors_origins').then(raw => {
    _lastCorsOpts = (!raw || raw === '*')
      ? { origin: false }
      : { origin: raw.split(',').map(o => o.trim()).filter(Boolean) };
    callback(null, _lastCorsOpts);
  }).catch(() => {
    const fallback = _lastCorsOpts
      ?? (process.env.CORS_ORIGINS && process.env.CORS_ORIGINS !== '*'
        ? { origin: process.env.CORS_ORIGINS.split(',').map(o => o.trim()).filter(Boolean) }
        : { origin: false });
    callback(null, fallback);
  });
}));

// Dynamic reverse-proxy trust level — only calls app.set when value changes
let _lastTrustProxy;
app.use((_req, _res, next) => {
  settings.getOrEnv('trust_proxy').then(tp => {
    const val = (tp && tp !== 'false') ? (isNaN(Number(tp)) ? tp : Number(tp)) : false;
    if (val !== _lastTrustProxy) { _lastTrustProxy = val; app.set('trust proxy', val); }
    next();
  }).catch(() => next());
});

// Same-origin reverse proxy for the Collabora editor — registered before
// express.json() so the editor's binary asset/endpoint streams pass through
// untouched. The editing WebSocket is handled in the server 'upgrade' listener.
const collaboraProxy = require('./lib/collaboraProxy');
app.use((req, res, next) => (collaboraProxy.isCollaboraPath(req.path) ? collaboraProxy.httpMiddleware(req, res) : next()));

// Baseline security headers — placed AFTER the Collabora proxy so the editor's
// proxied responses keep Collabora's own CSP/frame headers untouched.
app.use(require('./lib/securityHeaders'));

// Body limit raised from the 100 KB default so branding can carry a logo: the client
// caps logos at 256 KB, which becomes ~342 KB once base64-encoded into the settings
// JSON. 1 MB leaves headroom for that plus the rest of the payload. (Bulk file uploads
// don't go through this parser — they stream via the upload routes.)
app.use(express.json({ limit: '1mb' }));

const { apiLimiter, authLimiter, shareLimiter, uploadLimiter } = makeRateLimiters();
app.use('/api/auth', authLimiter);
app.use('/api/files/share', shareLimiter);
// Public folder ZIP downloads. Mount matches only the token route
// (/api/files/folder/share/:token), not the authed /folder/shares create/list —
// Express requires a segment boundary, and "shares" continues past "share".
app.use('/api/files/folder/share', shareLimiter);
// Bulk/resumable uploads (one request per file + per chunk) get a high limiter and
// are skipped by the general apiLimiter, so a large folder upload isn't 429'd mid-batch.
app.use('/api/files/upload', uploadLimiter);
app.use('/api/files/upload-stream', uploadLimiter);
app.use('/api/files/uploads', uploadLimiter);
app.use('/api', apiLimiter);

function browserUrlFromRequest(req, fallbackPort) {
  const proto = req.protocol || 'http';
  const host = req.get('host') || '';
  if (!host) return null;

  const bracketedIpv6 = host.startsWith('[');
  const hostname = bracketedIpv6
    ? host.slice(0, host.indexOf(']') + 1)
    : host.split(':')[0];

  // Behind a TLS-terminating proxy (Caddy), Keycloak is served on the same https
  // origin on 443 — don't append the internal Keycloak port.
  if (proto === 'https') return `https://${hostname}`;
  return `${proto}://${hostname}:${fallbackPort}`;
}

function browserKeycloakUrl(req) {
  const configured = (process.env.KEYCLOAK_URL || '').trim();
  if (configured && configured.toLowerCase() !== 'auto') return configured;
  return browserUrlFromRequest(req, process.env.KEYCLOAK_PUBLIC_PORT || 8080) || configured || 'http://localhost:8080';
}

// Public config — lets the frontend bootstrap auth without a build step
app.get('/api/config', async (req, res) => {
  // In-browser Office editing is on when Collabora is proxied same-origin
  // (collabora_enabled) or a direct browser URL is configured (collabora_url).
  let editingEnabled = false;
  try {
    editingEnabled = String((await settings.getOrEnv('collabora_enabled')) || '').toLowerCase() === 'true'
      || !!(await settings.getOrEnv('collabora_url'));
  } catch { /* default off */ }
  // Workspace branding (admin-set). Public so the login card — shown before
  // auth — can render the org's name/logo/accent.
  let brand = { name: '', logo: '', accent: '' };
  try {
    brand = {
      name: (await settings.getOrEnv('brand_name')) || '',
      logo: (await settings.getOrEnv('brand_logo')) || '',
      accent: (await settings.getOrEnv('brand_accent')) || '',
    };
  } catch { /* defaults */ }
  // Upload guardrails, so the client can warn/cap before sending (server still enforces).
  let maxUploadMb = 8192, maxUploadFiles = 4096;
  try { const v = parseInt((await settings.getOrEnv('max_upload_mb')) || '8192', 10); if (Number.isFinite(v) && v > 0) maxUploadMb = v; } catch { /* default */ }
  try { const v = parseInt((await settings.getOrEnv('max_upload_files')) || '4096', 10); if (Number.isFinite(v) && v > 0) maxUploadFiles = v; } catch { /* default */ }
  // First-boot gate: the client routes the admin to the Setup Wizard until the durable
  // setup_completed flag is set. FIRST_BOOT=force re-opens setup on a configured box.
  let setupRequired = false;
  try { setupRequired = String((await settings.get('setup_completed')) || '').toLowerCase() !== 'true'; } catch { /* if the DB is unreadable, don't spuriously gate a running system */ }
  if (String(process.env.FIRST_BOOT || '').toLowerCase() === 'force') setupRequired = true;
  res.json({
    keycloakUrl: browserKeycloakUrl(req),
    keycloakRealm: process.env.KEYCLOAK_REALM || 'memex',
    keycloakClientId: process.env.KEYCLOAK_CLIENT_ID || 'memex-app',
    version: VERSION,
    editingEnabled,
    brand,
    maxUploadMb,
    maxUploadFiles,
    setupRequired,
  });
});

// Caddy On-Demand TLS gate: only let Caddy obtain a certificate for the hostname
// configured as this deployment's app_url (so the domain is settings-driven, and
// arbitrary hosts can't trigger cert issuance). TLS_DOMAINS env adds extras.
app.get('/api/tls/check', async (req, res) => {
  try {
    const domain = String(req.query.domain || '').toLowerCase().trim();
    if (!domain) return res.sendStatus(400);
    let allowed = '';
    try { allowed = new URL(await settings.getOrEnv('app_url') || '').hostname.toLowerCase(); } catch { /* not set yet */ }
    const extras = String(process.env.TLS_DOMAINS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    return (domain === allowed || extras.includes(domain)) ? res.sendStatus(200) : res.sendStatus(403);
  } catch { return res.sendStatus(403); }
});

// ICE servers for WebRTC calls (STUN + optional TURN), auth-gated so TURN creds aren't public.
app.get('/api/webrtc/ice', require('./middleware/auth'), async (_req, res) => {
  try {
    const list = s => String(s || '').split(',').map(x => x.trim()).filter(Boolean);
    const stun = list(await settings.getOrEnv('stun_url'));
    const iceServers = [{ urls: stun.length ? stun : ['stun:stun.l.google.com:19302'] }];
    const turn = list(await settings.getOrEnv('turn_url'));
    if (turn.length) iceServers.push({ urls: turn, username: (await settings.getOrEnv('turn_username')) || '', credential: (await settings.getOrEnv('turn_credential')) || '' });
    res.json({ iceServers, screenconnectUrl: (await settings.getOrEnv('screenconnect_url')) || '' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.use('/api/auth', require('./routes/auth'));
app.use('/api/ai', require('./routes/ai'));
app.use('/api/log', require('./routes/log'));
app.use('/api/security', require('./routes/security'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/admin/settings', require('./routes/settings'));
app.use('/api/files', require('./routes/files'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/preferences', require('./routes/preferences'));
app.use('/api/csp-report', require('./routes/cspReport')); // CSP (report-only) violation sink — unauthenticated by design
app.use('/api/libraries', require('./routes/libraries'));
app.use('/api/version', require('./routes/version'));
app.use('/api/license', require('./routes/license'));
app.use('/api/setup', require('./routes/setup'));
app.use('/api/meetings', require('./routes/meetings'));
app.use('/api/backup', require('./routes/backup'));
app.use('/wopi', require('./routes/wopi'));

// Liveness/readiness probe. Unlike the SPA catch-all (which returns 200 with
// index.html even when the backend is dead), this actually pings the database, so
// installers, upgraders, and orchestrators can tell a real boot from a shell that
// only serves static HTML. Unauthenticated and never cached. 503 when the DB is
// unreachable; a 2.5s race keeps the probe responsive if the DB hangs.
app.get(['/healthz', '/api/health'], async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    await Promise.race([
      require('./lib/db').query('SELECT 1'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('db check timed out')), 2500)),
    ]);
    res.json({ status: 'ok', version: VERSION, db: 'up' });
  } catch (e) {
    res.status(503).json({ status: 'error', version: VERSION, db: 'down', error: e.message });
  }
});

// Public inbound-upload page (file requests) — a self-contained page that lets a
// non-member upload without an account. Served here (before the SPA catch-all)
// so it doesn't require auth. The token is only used client-side to hit the
// public /api/files/upload-link/:token endpoints.
app.get('/u/:token', (req, res) => {
  const token = String(req.params.token || '').replace(/[^a-zA-Z0-9]/g, '');
  res.type('html').send(require('./lib/uploadPage')(token));
});

// Serve only the vendored client libraries statically — NOT the repo root, which
// would expose server source, compose, and config files. The SPA itself is
// returned by the catch-all below.
app.use('/vendor', express.static(path.join(__dirname, '..', 'vendor'), { maxAge: '7d', immutable: true }));
// The SPA shell must never be cached: after an upgrade, browsers holding an old
// index.html would keep running stale client code (mismatched version, missing
// fixes) until a hard refresh. no-cache forces revalidation on every load so a
// new deploy is picked up on the next navigation.
app.get('*', (_req, res) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, '..', 'index.html'));
});

const PORT = process.env.PORT || 3000;
const BIND = process.env.BIND_ADDRESS || '0.0.0.0';
const server = app.listen(PORT, BIND, async () => {
  console.log(`Memex running on http://${BIND}:${PORT}`);
  // Apply forward-only schema migrations before anything reads or writes the schema.
  try {
    const r = await require('./lib/migrations').run({ log: console.log });
    console.log(r.applied.length ? `[startup] applied ${r.applied.length} migration(s)` : '[startup] schema migrations up to date');
  } catch (e) {
    console.error('[startup] schema migrations FAILED:', e.message);
  }
  // One-time, idempotent: ensure every existing document has an owner/admin ACL row
  // (the historical grantOwnerAdmin bug left pre-existing docs without one).
  try {
    const granted = await require('./lib/documentAccess').backfillOwnerGrants();
    console.log(`[startup] owner-ACL backfill: ${granted} grant(s) created`);
  } catch (e) {
    console.error('[startup] owner-ACL backfill failed:', e.message);
  }
  // Arm the scheduled-backup timer (no-op unless backups are enabled).
  try { await require('./lib/backup').reschedule(); } catch (e) { console.error('[startup] backup scheduler failed:', e.message); }
  // Add the tamper-evident audit-log columns before the first event append.
  try { await require('./lib/auditLog').ensureChain(); console.log('[startup] audit-log chain ready'); }
  catch (e) { console.error('[startup] audit-log chain init failed:', e.message); }
  // Periodically reclaim staged chunks from abandoned resumable uploads.
  try { require('./lib/uploadSweeper').start(); console.log('[startup] upload-session sweeper armed'); }
  catch (e) { console.error('[startup] upload sweeper failed:', e.message); }
  // Periodically hard-delete trashed documents past the retention window.
  try { require('./lib/trashSweeper').start(); console.log('[startup] trash sweeper armed'); }
  catch (e) { console.error('[startup] trash sweeper failed:', e.message); }
});

// Timeouts tuned for large/slow uploads (U9). keepAliveTimeout sits above the common
// 60s reverse-proxy idle timeout so a connection reused between chunks isn't closed
// out from under an in-flight upload (a frequent source of 502s behind a proxy);
// headersTimeout must exceed keepAliveTimeout (Node requirement). requestTimeout still
// bounds a whole request (a slowloris guard) but is generous so a slow multi-GB upload
// on a poor link isn't cut off mid-transfer. All override-able via env.
const timeoutMs = (name, def) => { const v = parseInt(process.env[name] || '', 10); return Number.isFinite(v) && v >= 0 ? v : def; };
server.keepAliveTimeout = timeoutMs('KEEPALIVE_TIMEOUT_MS', 65_000);
server.headersTimeout   = timeoutMs('HEADERS_TIMEOUT_MS', 66_000);
server.requestTimeout   = timeoutMs('REQUEST_TIMEOUT_MS', 30 * 60 * 1000);

// WebSocket signaling for member video/audio calls (presence + WebRTC brokering).
try { require('./lib/signaling').init(server); console.log('[startup] WebRTC signaling on /ws'); }
catch (e) { console.error('[startup] signaling init failed:', e.message); }

// Route the Collabora editor WebSocket (/cool/.../ws) through the same-origin proxy.
// Anything that is neither the signaling socket (/ws) nor a Collabora path —
// including the blocked Collabora admin websocket — is closed instead of hanging.
server.on('upgrade', (req, socket, head) => {
  let pathname;
  try { pathname = new URL(req.url, 'http://x').pathname; } catch { pathname = req.url; }
  if (collaboraProxy.isCollaboraPath(pathname)) collaboraProxy.handleUpgrade(req, socket, head);
  else if (pathname !== '/ws') socket.destroy();
});

// Graceful shutdown. A redeploy/`docker compose up` sends SIGTERM; without this Node
// exits instantly, cutting in-flight uploads/requests and leaking DB connections.
// Stop background timers, let the HTTP server drain, close the pool, then exit —
// with a hard cap so a hung connection can't block shutdown forever.
let _shuttingDown = false;
function shutdown(signal) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  console.log(`[shutdown] ${signal} received — draining…`);
  try { require('./lib/uploadSweeper').stop(); } catch { /* not started */ }
  try { require('./lib/trashSweeper').stop(); } catch { /* not started */ }
  const forced = setTimeout(() => { console.error('[shutdown] forced exit after 25s'); process.exit(1); }, 25_000);
  forced.unref?.();
  server.close(() => {
    Promise.resolve(require('./lib/db').end?.()).catch(() => {}).finally(() => {
      console.log('[shutdown] http server + db pool closed. bye.');
      process.exit(0);
    });
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

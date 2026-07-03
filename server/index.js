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

// Dynamic CORS — origins configurable via admin settings
// Falls back to last known-good value (or env var) on DB error rather than opening up
let _lastCorsOpts = null;
app.use(cors((_req, callback) => {
  settings.getOrEnv('cors_origins').then(raw => {
    _lastCorsOpts = (!raw || raw === '*')
      ? { origin: true }
      : { origin: raw.split(',').map(o => o.trim()).filter(Boolean) };
    callback(null, _lastCorsOpts);
  }).catch(() => {
    const fallback = _lastCorsOpts
      ?? (process.env.CORS_ORIGINS && process.env.CORS_ORIGINS !== '*'
        ? { origin: process.env.CORS_ORIGINS.split(',').map(o => o.trim()).filter(Boolean) }
        : { origin: true });
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

app.use(express.json());

const { apiLimiter, authLimiter, shareLimiter } = makeRateLimiters();
app.use('/api/auth', authLimiter);
app.use('/api/files/share', shareLimiter);
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
  // In-browser Office editing is available only when a Collabora URL is set.
  let editingEnabled = false;
  try { editingEnabled = !!(await settings.getOrEnv('collabora_url')); } catch { /* default off */ }
  res.json({
    keycloakUrl: browserKeycloakUrl(req),
    keycloakRealm: process.env.KEYCLOAK_REALM || 'memex',
    keycloakClientId: process.env.KEYCLOAK_CLIENT_ID || 'memex-app',
    version: VERSION,
    editingEnabled,
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
app.use('/api/pages', require('./routes/pages'));
app.use('/api/ai', require('./routes/ai'));
app.use('/api/log', require('./routes/log'));
app.use('/api/security', require('./routes/security'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/admin/settings', require('./routes/settings'));
app.use('/api/files', require('./routes/files'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/libraries', require('./routes/libraries'));
app.use('/api/version', require('./routes/version'));
app.use('/api/backup', require('./routes/backup'));
app.use('/wopi', require('./routes/wopi'));

// Serve only the vendored client libraries statically — NOT the repo root, which
// would expose server source, compose, and config files. The SPA itself is
// returned by the catch-all below.
app.use('/vendor', express.static(path.join(__dirname, '..', 'vendor'), { maxAge: '7d', immutable: true }));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, '..', 'index.html')));

const PORT = process.env.PORT || 3000;
const BIND = process.env.BIND_ADDRESS || '0.0.0.0';
const server = app.listen(PORT, BIND, async () => {
  console.log(`Memex running on http://${BIND}:${PORT}`);
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
});

// WebSocket signaling for member video/audio calls (presence + WebRTC brokering).
try { require('./lib/signaling').init(server); console.log('[startup] WebRTC signaling on /ws'); }
catch (e) { console.error('[startup] signaling init failed:', e.message); }

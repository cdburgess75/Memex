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

  return `${proto}://${hostname}:${fallbackPort}`;
}

function browserKeycloakUrl(req) {
  const configured = (process.env.KEYCLOAK_URL || '').trim();
  if (configured && configured.toLowerCase() !== 'auto') return configured;
  return browserUrlFromRequest(req, process.env.KEYCLOAK_PUBLIC_PORT || 8080) || configured || 'http://localhost:8080';
}

// Public config — lets the frontend bootstrap auth without a build step
app.get('/api/config', (req, res) => {
  res.json({
    keycloakUrl: browserKeycloakUrl(req),
    keycloakRealm: process.env.KEYCLOAK_REALM || 'memex',
    keycloakClientId: process.env.KEYCLOAK_CLIENT_ID || 'memex-app',
    version: VERSION,
  });
});

app.use('/api/auth', require('./routes/auth'));
app.use('/api/pages', require('./routes/pages'));
app.use('/api/ai', require('./routes/ai'));
app.use('/api/log', require('./routes/log'));
app.use('/api/security', require('./routes/security'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/admin/settings', require('./routes/settings'));
app.use('/api/files', require('./routes/files'));
app.use('/api/libraries', require('./routes/libraries'));
app.use('/wopi', require('./routes/wopi'));

app.use(express.static(path.join(__dirname, '..')));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, '..', 'index.html')));

const PORT = process.env.PORT || 3000;
const BIND = process.env.BIND_ADDRESS || '0.0.0.0';
app.listen(PORT, BIND, async () => {
  console.log(`Memex running on http://${BIND}:${PORT}`);
  // One-time, idempotent: ensure every existing document has an owner/admin ACL row
  // (the historical grantOwnerAdmin bug left pre-existing docs without one).
  try {
    const granted = await require('./lib/documentAccess').backfillOwnerGrants();
    console.log(`[startup] owner-ACL backfill: ${granted} grant(s) created`);
  } catch (e) {
    console.error('[startup] owner-ACL backfill failed:', e.message);
  }
});

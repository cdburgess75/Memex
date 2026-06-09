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

const { apiLimiter, authLimiter } = makeRateLimiters();
app.use('/api/auth', authLimiter);
app.use('/api', apiLimiter);

// Public config — lets the frontend bootstrap auth without a build step
app.get('/api/config', (_req, res) => {
  res.json({
    keycloakUrl: process.env.KEYCLOAK_URL,
    keycloakRealm: process.env.KEYCLOAK_REALM || 'memex',
    keycloakClientId: process.env.KEYCLOAK_CLIENT_ID || 'memex-app',
    version: VERSION,
  });
});

app.use('/api/auth', require('./routes/auth'));
app.use('/api/pages', require('./routes/pages'));
app.use('/api/ai', require('./routes/ai'));
app.use('/api/log', require('./routes/log'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/admin/settings', require('./routes/settings'));
app.use('/api/files', require('./routes/files'));
app.use('/wopi', require('./routes/wopi'));

app.use(express.static(path.join(__dirname, '..')));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, '..', 'index.html')));

const PORT = process.env.PORT || 3000;
const BIND = process.env.BIND_ADDRESS || '0.0.0.0';
app.listen(PORT, BIND, () => console.log(`Memex running on http://${BIND}:${PORT}`));

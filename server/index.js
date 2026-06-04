require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const express = require('express');
const cors = require('cors');
const path = require('path');
const settings = require('./lib/settings');

const app = express();

// App version (vYYYY.MM.DD.NNN) — read from the VERSION file at the repo root
let VERSION = 'dev';
try {
  VERSION = require('fs').readFileSync(path.join(__dirname, '..', 'VERSION'), 'utf8').trim() || 'dev';
} catch { /* VERSION file optional */ }

// Dynamic CORS — origins configurable via admin settings
app.use(cors((_req, callback) => {
  settings.getOrEnv('cors_origins').then(raw => {
    if (!raw || raw === '*') return callback(null, { origin: true });
    const origins = raw.split(',').map(o => o.trim()).filter(Boolean);
    callback(null, { origin: origins });
  }).catch(() => callback(null, { origin: true }));
}));

// Dynamic reverse-proxy trust level — configurable without restart for most changes
app.use((_req, _res, next) => {
  settings.getOrEnv('trust_proxy').then(tp => {
    if (tp && tp !== 'false') app.set('trust proxy', isNaN(Number(tp)) ? tp : Number(tp));
    else app.set('trust proxy', false);
    next();
  }).catch(() => next());
});

app.use(express.json());

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

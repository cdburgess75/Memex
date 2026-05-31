require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// Public config — lets the frontend bootstrap auth without a build step
app.get('/api/config', (_req, res) => {
  res.json({
    keycloakUrl: process.env.KEYCLOAK_URL,
    keycloakRealm: process.env.KEYCLOAK_REALM || 'memex',
    keycloakClientId: process.env.KEYCLOAK_CLIENT_ID || 'memex-app',
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
app.listen(PORT, () => console.log(`Memex running on http://localhost:${PORT}`));

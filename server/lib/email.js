'use strict';
// Outbound email with two backends:
//   • Microsoft Graph sendMail (app-only client credentials) — the primary,
//     durable path. Reuses the Ptech 365 app registration; sends as a mailbox in
//     the deployment's tenant. Auth via a client secret OR a certificate
//     client-assertion (no MSAL dependency — jsonwebtoken signs the assertion).
//   • SMTP (nodemailer) — the settings-configurable backup path.
// Provider is chosen by the `email_provider` setting ('graph' | 'smtp'), or auto:
// prefer Graph when it's fully configured, else SMTP.
// Email is best-effort for notifications: sendMail never throws, it reports.
const crypto = require('crypto');
const settings = require('./settings');

let _transport = null;
let _transportKey = '';
let _graphToken = null; // { token, exp (epoch ms), key }

/* ---------------- SMTP ---------------- */
async function smtpConfig() {
  const host = String((await settings.getOrEnv('smtp_host')) || '').trim();
  if (!host) return null;
  const port = Number(await settings.getOrEnv('smtp_port')) || 587;
  const secureSetting = String((await settings.getOrEnv('smtp_secure')) || '').toLowerCase();
  const secure = secureSetting === 'true' || (secureSetting !== 'false' && port === 465);
  const user = String((await settings.getOrEnv('smtp_user')) || '').trim() || null;
  const pass = (await settings.getOrEnv('smtp_pass')) || null;
  const from = String((await settings.getOrEnv('email_from')) || user || '').trim();
  return { host, port, secure, user, pass, from };
}

function transportFor(cfg) {
  // Include the password (hashed — never keep it in plaintext state) in the cache
  // key so rotating the SMTP password invalidates the pooled transport instead of
  // silently reusing the old credentials until another field changes / restart.
  const passHash = cfg.pass
    ? crypto.createHash('sha256').update(String(cfg.pass)).digest('hex')
    : '';
  const key = JSON.stringify({ h: cfg.host, p: cfg.port, s: cfg.secure, u: cfg.user, p2: passHash });
  if (_transport && _transportKey === key) return _transport;
  const nodemailer = require('nodemailer');
  _transport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
  });
  _transportKey = key;
  return _transport;
}

async function smtpSend(cfg, { to, subject, text, html }) {
  const from = cfg.from || cfg.user || 'memex@localhost';
  await transportFor(cfg).sendMail({ from, to, subject, text, html });
  return { sent: true, via: 'smtp' };
}

/* ---------------- Microsoft Graph ---------------- */
async function graphConfig() {
  const tenant = String((await settings.getOrEnv('graph_tenant_id')) || '').trim();
  const clientId = String((await settings.getOrEnv('graph_client_id')) || '').trim();
  const from = String((await settings.getOrEnv('email_from')) || '').trim();
  if (!tenant || !clientId || !from) return null;
  const secret = String((await settings.getOrEnv('graph_client_secret')) || '').trim() || null;
  const thumbprint = String((await settings.getOrEnv('graph_cert_thumbprint')) || '').replace(/[^a-fA-F0-9]/g, '') || null;
  let privateKey = (await settings.getOrEnv('graph_cert_key')) || null;
  if (!privateKey) {
    const keyPath = String((await settings.getOrEnv('graph_cert_key_path')) || '').trim();
    if (keyPath) { try { privateKey = require('fs').readFileSync(keyPath, 'utf8'); } catch { /* unreadable → no cert cred */ } }
  }
  const hasSecret = !!secret;
  const hasCert = !!(thumbprint && privateKey);
  if (!hasSecret && !hasCert) return null; // no usable credential
  return { tenant, clientId, from, secret, thumbprint, privateKey, hasSecret, hasCert };
}

// Build a signed JWT client-assertion for certificate-based client credentials.
function certAssertion(cfg) {
  const jwt = require('jsonwebtoken');
  // x5t = base64url of the raw SHA-1 cert thumbprint bytes.
  const x5t = Buffer.from(cfg.thumbprint, 'hex').toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    aud: `https://login.microsoftonline.com/${cfg.tenant}/oauth2/v2.0/token`,
    iss: cfg.clientId,
    sub: cfg.clientId,
    jti: crypto.randomUUID(),
    nbf: now,
    iat: now,
    exp: now + 600, // 10 minutes
  };
  return jwt.sign(payload, cfg.privateKey, { algorithm: 'RS256', header: { alg: 'RS256', typ: 'JWT', x5t } });
}

function graphCredKey(cfg) {
  return cfg.hasSecret
    ? 's:' + crypto.createHash('sha256').update(cfg.secret).digest('hex')
    : 'c:' + cfg.thumbprint;
}

async function graphToken(cfg) {
  const key = `${cfg.tenant}|${cfg.clientId}|${graphCredKey(cfg)}`;
  // Reuse a cached token until ~2 min before expiry.
  if (_graphToken && _graphToken.key === key && Date.now() < _graphToken.exp - 120000) {
    return _graphToken.token;
  }
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });
  if (cfg.hasSecret) {
    body.set('client_secret', cfg.secret);
  } else {
    body.set('client_assertion_type', 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
    body.set('client_assertion', certAssertion(cfg));
  }
  const r = await fetch(`https://login.microsoftonline.com/${cfg.tenant}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(10000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.access_token) {
    throw new Error(`graph token ${r.status}: ${data.error_description || data.error || 'no access_token'}`);
  }
  _graphToken = { token: data.access_token, exp: Date.now() + (Number(data.expires_in) || 3600) * 1000, key };
  return _graphToken.token;
}

async function graphSend(cfg, { to, subject, text, html }) {
  const token = await graphToken(cfg);
  const recipients = String(to).split(',').map(s => s.trim()).filter(Boolean)
    .map(addr => ({ emailAddress: { address: addr } }));
  const message = {
    subject: subject || '',
    body: html ? { contentType: 'HTML', content: html } : { contentType: 'Text', content: text || '' },
    toRecipients: recipients,
  };
  const r = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(cfg.from)}/sendMail`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, saveToSentItems: false }),
    signal: AbortSignal.timeout(15000),
  });
  if (r.status === 202) return { sent: true, via: 'graph' };
  let detail = '';
  try { detail = (await r.json())?.error?.message || ''; } catch { /* non-JSON */ }
  throw new Error(`graph sendMail ${r.status}${detail ? ': ' + detail : ''}`);
}

/* ---------------- provider selection ---------------- */
// Resolve which backend to use. Explicit `email_provider` wins; otherwise auto:
// Graph if configured, else SMTP.
async function resolveProvider() {
  const explicit = String((await settings.getOrEnv('email_provider')) || '').trim().toLowerCase();
  const graph = await graphConfig();
  if (explicit === 'graph') return graph ? { kind: 'graph', cfg: graph } : null;
  if (explicit === 'smtp') { const s = await smtpConfig(); return s ? { kind: 'smtp', cfg: s } : null; }
  if (graph) return { kind: 'graph', cfg: graph };
  const s = await smtpConfig();
  return s ? { kind: 'smtp', cfg: s } : null;
}

async function isConfigured() {
  return !!(await resolveProvider());
}

// Send an email. Returns { sent: true, via } or { sent: false, reason }. Never throws.
async function sendMail({ to, subject, text, html }) {
  try {
    if (!to) return { sent: false, reason: 'no_recipient' };
    const provider = await resolveProvider();
    if (!provider) return { sent: false, reason: 'not_configured' };
    return provider.kind === 'graph'
      ? await graphSend(provider.cfg, { to, subject, text, html })
      : await smtpSend(provider.cfg, { to, subject, text, html });
  } catch (e) {
    console.error('email send failed:', e.message);
    return { sent: false, reason: e.message };
  }
}

function _resetForTests() { _transport = null; _transportKey = ''; _graphToken = null; }

module.exports = { sendMail, isConfigured, smtpConfig, graphConfig, resolveProvider, _resetForTests };

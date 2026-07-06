'use strict';
// Outbound email. SMTP backend (nodemailer) — the settings-configurable "backup"
// path. Microsoft Graph sendMail (reusing the 365 app-reg) is the planned primary
// and can slot in behind sendMail() by inspecting an `email_provider` setting.
// Email is best-effort for notifications: sendMail never throws, it reports.
const settings = require('./settings');

let _transport = null;
let _transportKey = '';

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

async function isConfigured() {
  return !!(await smtpConfig());
}

function transportFor(cfg) {
  // Include the password (hashed — never keep it in plaintext state) in the cache
  // key so rotating the SMTP password invalidates the pooled transport instead of
  // silently reusing the old credentials until another field changes / restart.
  const passHash = cfg.pass
    ? require('crypto').createHash('sha256').update(String(cfg.pass)).digest('hex')
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

// Send an email. Returns { sent: true } or { sent: false, reason }. Never throws.
async function sendMail({ to, subject, text, html }) {
  try {
    if (!to) return { sent: false, reason: 'no_recipient' };
    const cfg = await smtpConfig();
    if (!cfg) return { sent: false, reason: 'not_configured' };
    const from = cfg.from || cfg.user || 'memex@localhost';
    await transportFor(cfg).sendMail({ from, to, subject, text, html });
    return { sent: true };
  } catch (e) {
    console.error('email send failed:', e.message);
    return { sent: false, reason: e.message };
  }
}

function _resetForTests() { _transport = null; _transportKey = ''; }

module.exports = { sendMail, isConfigured, smtpConfig, _resetForTests };

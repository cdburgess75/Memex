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
  // Relay controls for corporate smarthosts (Proofpoint, on-prem gateways):
  //  • reject_unauthorized=false accepts a self-signed / private-CA relay cert.
  //    Defaults to true — you must opt OUT of certificate validation.
  //  • require_tls forces STARTTLS on a non-465 port (refuse to send in the clear).
  const rejectUnauthorized = String((await settings.getOrEnv('smtp_reject_unauthorized')) || '').toLowerCase() !== 'false';
  const requireTLS = String((await settings.getOrEnv('smtp_require_tls')) || '').toLowerCase() === 'true';
  return { host, port, secure, user, pass, from, rejectUnauthorized, requireTLS };
}

function transportFor(cfg) {
  // Include the password (hashed — never keep it in plaintext state) in the cache
  // key so rotating the SMTP password invalidates the pooled transport instead of
  // silently reusing the old credentials until another field changes / restart.
  const passHash = cfg.pass
    ? crypto.createHash('sha256').update(String(cfg.pass)).digest('hex')
    : '';
  const key = JSON.stringify({ h: cfg.host, p: cfg.port, s: cfg.secure, u: cfg.user, p2: passHash, ru: cfg.rejectUnauthorized, rt: cfg.requireTLS });
  if (_transport && _transportKey === key) return _transport;
  const nodemailer = require('nodemailer');
  _transport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    requireTLS: cfg.requireTLS || undefined,
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
    // Only relax cert validation when the operator explicitly opted out (private-CA relays).
    tls: cfg.rejectUnauthorized === false ? { rejectUnauthorized: false } : undefined,
  });
  _transportKey = key;
  return _transport;
}

async function smtpSend(cfg, { to, subject, text, html, attachments, icalEvent, sendAs }) {
  const account = cfg.from || cfg.user || 'depot@localhost';
  const from = sendAs || account;
  const mail = { from, to, subject, text, html };
  // When sending on a member's behalf, keep the SMTP envelope on the account the
  // relay authenticated as — SPF/DMARC align on the envelope, so a per-user From
  // header would otherwise fail authentication at the recipient. Replies still
  // reach the person.
  if (sendAs && sendAs !== account) {
    mail.envelope = { from: account, to };
    mail.replyTo = sendAs;
  }
  if (Array.isArray(attachments) && attachments.length) mail.attachments = attachments;
  // nodemailer's icalEvent makes the message a real calendar invite (multipart with
  // a text/calendar part carrying the method), so clients show accept/decline.
  if (icalEvent) mail.icalEvent = { method: icalEvent.method || 'REQUEST', filename: icalEvent.filename || 'invite.ics', content: icalEvent.content };
  await transportFor(cfg).sendMail(mail);
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

// Signed JWT client-assertion for certificate-based client credentials — shared
// with the SharePoint connector (single implementation of the x5t header).
const { certAssertion } = require('./graphClientAssertion');

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

function graphAttachment(name, contentType, content) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
  return {
    '@odata.type': '#microsoft.graph.fileAttachment',
    name: name || 'attachment',
    contentType: contentType || 'application/octet-stream',
    contentBytes: bytes.toString('base64'),
  };
}

// Graph failures that mean "this mailbox cannot be sent from" — as opposed to a
// transient or global fault. Each maps to a real tenant condition: no such user,
// no Exchange licence, an on-prem/unsupported mailbox, or the app not being
// authorised for that mailbox. On any of these we fall back to the workspace
// mailbox rather than silently dropping a notification.
function senderIneligible(status, detail) {
  const d = String(detail || '');
  if (status === 404) return true;                                   // ResourceNotFound / MailboxNotEnabledForRESTAPI
  if (status === 401) return /mailbox|not.*found|licen/i.test(d);    // unlicensed reports as 401 or 403
  if (status === 403) return /ErrorAccessDenied|Access to OData is disabled|RAOP|MailboxNotEnabled|SendAsDenied/i.test(d);
  return false;
}

async function graphSend(cfg, { to, subject, text, html, attachments, icalEvent, sendAs }) {
  const token = await graphToken(cfg);
  const recipients = String(to).split(',').map(s => s.trim()).filter(Boolean)
    .map(addr => ({ emailAddress: { address: addr } }));
  const message = {
    subject: subject || '',
    body: html ? { contentType: 'HTML', content: html } : { contentType: 'Text', content: text || '' },
    toRecipients: recipients,
  };
  // Graph has no icalEvent field; attach the invite as an .ics fileAttachment.
  // Outlook renders a text/calendar attachment as an accept/decline event.
  const atts = [];
  if (icalEvent) atts.push(graphAttachment(icalEvent.filename || 'invite.ics', `text/calendar; method=${icalEvent.method || 'REQUEST'}; charset=UTF-8`, icalEvent.content));
  for (const a of attachments || []) atts.push(graphAttachment(a.filename, a.contentType, a.content));
  if (atts.length) message.attachments = atts;

  // Under app-only auth the mailbox in the URL *is* the From address — there is
  // no header to set. Sending as a member therefore means POSTing to their
  // mailbox, and the message lands in their Sent Items so the trail is theirs.
  const post = async (mailbox, saveToSentItems) => fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/sendMail`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, saveToSentItems }),
      signal: AbortSignal.timeout(15000),
    },
  );
  const readDetail = async (r) => { try { return (await r.json())?.error?.message || ''; } catch { return ''; } };

  const asUser = sendAs && sendAs.toLowerCase() !== cfg.from.toLowerCase();
  if (asUser) {
    const r = await post(sendAs, true);
    if (r.status === 202) return { sent: true, via: 'graph', from: sendAs };
    const detail = await readDetail(r);
    // Not every Depot member has a mailbox in this tenant (local and AD accounts
    // often do not), and a customer may keep the app scoped to one mailbox. A
    // notification that never arrives is worse than one from the workspace
    // address, so fall back instead of failing.
    if (!senderIneligible(r.status, detail)) {
      throw new Error(`graph sendMail ${r.status}${detail ? ': ' + detail : ''}`);
    }
    console.warn(`email: cannot send as ${sendAs} (${r.status}${detail ? ': ' + detail : ''}) — falling back to ${cfg.from}`);
  }

  const r = await post(cfg.from, false);
  if (r.status === 202) return { sent: true, via: 'graph', from: cfg.from, ...(asUser ? { fellBack: true } : {}) };
  const detail = await readDetail(r);
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

// A member's address is only usable as a sender if it is a real, routable
// mailbox. Depot identities come from three places (local accounts, AD/LDAP,
// M365) and only the M365 ones are guaranteed to have one, so this is a shape
// check — the authoritative answer comes from the provider, which falls back.
function usableSender(addr) {
  const a = String(addr || '').trim();
  // One address only: a newline or comma here would be header injection.
  return /^[^\s,;<>"]+@[^\s,;<>"]+\.[a-z]{2,}$/i.test(a) ? a.toLowerCase() : null;
}

// Send an email. Returns { sent: true, via } or { sent: false, reason }. Never throws.
// `attachments`: [{ filename, contentType, content:Buffer|string }]. `icalEvent`:
// { method, filename, content } for calendar invites. `actorEmail`: the member
// this message is being sent on behalf of — when the workspace has send-as-user
// enabled and their mailbox accepts it, the mail comes from them rather than
// from the shared workspace address.
async function sendMail({ to, subject, text, html, attachments, icalEvent, actorEmail }) {
  try {
    if (!to) return { sent: false, reason: 'no_recipient' };
    const provider = await resolveProvider();
    if (!provider) return { sent: false, reason: 'not_configured' };
    let sendAs = null;
    if (actorEmail) {
      const on = String((await settings.getOrEnv('email_send_as_user')) || 'true').toLowerCase() !== 'false';
      if (on) sendAs = usableSender(actorEmail);
    }
    const payload = { to, subject, text, html, attachments, icalEvent, sendAs };
    return provider.kind === 'graph'
      ? await graphSend(provider.cfg, payload)
      : await smtpSend(provider.cfg, payload);
  } catch (e) {
    console.error('email send failed:', e.message);
    return { sent: false, reason: e.message };
  }
}

function _resetForTests() { _transport = null; _transportKey = ''; _graphToken = null; }

module.exports = { sendMail, isConfigured, smtpConfig, graphConfig, resolveProvider, _resetForTests };

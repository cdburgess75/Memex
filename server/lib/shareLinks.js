'use strict';
// Share-link primitives shared by the per-file share routes and the folder share
// routes: token hashing, password hashing/verification, the client-facing shapes,
// the boot-time download-ticket HMAC, and the public base-URL resolver.
// Extracted from routes/files.js (ST-1).
const crypto = require('crypto');
const settings = require('./settings');

function folderShareClientShape(row, url = null) {
  return {
    id: row.id,
    folder_path: row.folder_path,
    file_count: Array.isArray(row.document_ids) ? row.document_ids.length : Number(row.file_count || 0),
    expires_at: row.expires_at,
    revoked_at: row.revoked_at,
    created_at: row.created_at,
    created_by_email: row.created_by_email,
    last_accessed_at: row.last_accessed_at,
    access_count: Number(row.access_count || 0),
    has_password: !!row.password_hash,
    url,
  };
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function passwordParts(password) {
  if (!password) return { salt: null, hash: null };
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return { salt, hash };
}

function verifySharePassword(password, salt, expectedHash) {
  if (!expectedHash) return true;
  if (!password || !salt) return false;
  const actual = crypto.scryptSync(String(password), salt, 32);
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function shareLinkClientShape(row, url = null) {
  return {
    id: row.id,
    document_id: row.document_id,
    expires_at: row.expires_at,
    revoked_at: row.revoked_at,
    created_at: row.created_at,
    created_by_email: row.created_by_email,
    recipient_email: row.recipient_email || null,   // null = anonymous copy-link
    allow_upload: !!row.allow_upload,
    last_accessed_at: row.last_accessed_at,
    access_count: Number(row.access_count || 0),
    has_password: !!row.password_hash,
    url
  };
}

// Short-lived, single-purpose download tickets so a password never rides in a
// URL (query strings land in proxy access logs and browser history, defeating
// the password as a second factor). The recipient's page exchanges the password
// — sent in a header — for a ticket, and the download link carries the ticket.
// Signed with a boot-time key: no storage, and a server restart just means the
// recipient re-enters the password. Not the password, so safe to log.
const SHARE_TICKET_KEY = crypto.randomBytes(32);
function issueShareTicket(shareId, ttlMs = 30 * 60 * 1000) {
  const exp = Date.now() + ttlMs;
  const mac = crypto.createHmac('sha256', SHARE_TICKET_KEY).update(`${shareId}.${exp}`).digest('base64url');
  return `${exp}.${mac}`;
}
function verifyShareTicket(shareId, ticket) {
  const [expStr, mac] = String(ticket || '').split('.');
  const exp = Number(expStr);
  if (!exp || exp < Date.now() || !mac) return false;
  const expected = crypto.createHmac('sha256', SHARE_TICKET_KEY).update(`${shareId}.${exp}`).digest('base64url');
  try { return crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected)); } catch { return false; }
}

async function publicAppBase(req) {
  const configured = (await settings.getOrEnv('app_url') || '').replace(/\/$/, '');
  const host = req.get('host') || '';
  // Prefer the host the user actually reached Memex on, so the share link is
  // reachable from their vantage point. The configured app_url can be stale (a
  // dead dev/LAN host) and would otherwise poison every share link. Fall back to
  // app_url only when the request host is internal — e.g. a reverse proxy that
  // didn't forward the original Host header (localhost/loopback/0.0.0.0).
  const hostname = (host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':')[0]).toLowerCase();
  const internal = !host || hostname === 'localhost' || hostname === '::1' || hostname === '0.0.0.0' || /^127\./.test(hostname);
  if (!internal) return `${req.protocol}://${host}`;
  return configured || `${req.protocol}://${host}`;
}

module.exports = {
  folderShareClientShape,
  tokenHash,
  passwordParts,
  verifySharePassword,
  shareLinkClientShape,
  SHARE_TICKET_KEY,
  issueShareTicket,
  verifyShareTicket,
  publicAppBase,
};

'use strict';
// Short-lived, user-scoped tickets for inline media requests.
//
// Image/video requests from the page (<img src>, <video src>) can't carry the
// Authorization header the rest of the API uses, so they can't authenticate the
// normal way. The page fetches a ticket over an authed call once, then appends
// it to inline media URLs (e.g. /files/:id/thumbnail?t=<ticket>). The ticket only
// identifies the user; per-file read access is still enforced on every request.
// Mirrors the in-memory, TTL'd token map storage.js already uses for downloads.
const crypto = require('crypto');

const TTL_MS = 60 * 60 * 1000;
const tickets = new Map(); // token -> { user, expires }

function sweep() {
  const now = Date.now();
  for (const [k, v] of tickets) if (v.expires < now) tickets.delete(k);
}

function issue(user) {
  sweep();
  const token = crypto.randomBytes(24).toString('base64url');
  tickets.set(token, {
    user: { id: user.id, email: user.email, role: user.role },
    expires: Date.now() + TTL_MS,
  });
  return { ticket: token, ttl: Math.floor(TTL_MS / 1000) };
}

function resolve(token) {
  if (!token || typeof token !== 'string') return null;
  const entry = tickets.get(token);
  if (!entry) return null;
  if (entry.expires < Date.now()) { tickets.delete(token); return null; }
  return entry.user;
}

module.exports = { issue, resolve, _tickets: tickets, TTL_MS };

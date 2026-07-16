// WOPI access tokens: map token → { fileId, userId, userEmail, expires }
const tokens = new Map();

function generateToken(fileId, userId, userEmail, canWrite = false) {
  const crypto = require('crypto');
  const token = crypto.randomBytes(32).toString('hex');
  const expires = Date.now() + 60 * 60 * 1000; // 1 hour
  tokens.set(token, { fileId, userId, userEmail, canWrite: !!canWrite, expires });
  // Prune expired tokens
  if (tokens.size > 500) {
    const now = Date.now();
    for (const [k, v] of tokens) if (v.expires < now) tokens.delete(k);
  }
  return token;
}

function validateToken(token) {
  const entry = tokens.get(token);
  if (!entry) return null;
  if (entry.expires < Date.now()) { tokens.delete(token); return null; }
  return entry;
}

// File locks: map fileId → { lockToken, expires }
const locks = new Map();

function getLock(fileId) {
  const lock = locks.get(fileId);
  if (!lock) return null;
  if (lock.expires < Date.now()) { locks.delete(fileId); return null; }
  return lock.lockToken;
}

function setLock(fileId, lockToken) {
  locks.set(fileId, { lockToken, expires: Date.now() + 30 * 60 * 1000 }); // 30 min
}

function clearLock(fileId) { locks.delete(fileId); }

// Periodic cleanup of expired tokens and locks every 15 minutes
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of tokens) if (v.expires < now) tokens.delete(k);
  for (const [k, v] of locks) if (v.expires < now) locks.delete(k);
}, 15 * 60 * 1000).unref();

module.exports = { generateToken, validateToken, getLock, setLock, clearLock };

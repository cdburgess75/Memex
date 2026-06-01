'use strict';
const crypto = require('crypto');

const MAGIC = Buffer.from('MXEC');
const ALGO  = 'aes-256-gcm';

// Derive a 32-byte key from a passphrase using scrypt.
// Salt is fixed because this is at-rest encryption, not password hashing.
function deriveKey(passphrase) {
  return crypto.scryptSync(passphrase, 'memex-local-enc-v1', 32);
}

// Accept either a 64-char hex string (used verbatim as 32 raw bytes)
// or any other string (scrypt-derived). Returns null for falsy input.
function resolveKey(raw) {
  if (!raw) return null;
  return /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : deriveKey(raw);
}

// Wire format: MAGIC(4) + IV(12) + AUTH_TAG(16) + CIPHERTEXT(n)
function encrypt(buf, key) {
  const iv     = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct     = Buffer.concat([cipher.update(buf), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ct]);
}

function decrypt(buf, key) {
  if (buf.length < 32 || !buf.slice(0, 4).equals(MAGIC)) return buf;
  const iv  = buf.slice(4, 16);
  const tag = buf.slice(16, 32);
  const ct  = buf.slice(32);
  const dec = crypto.createDecipheriv(ALGO, key, iv);
  dec.setAuthTag(tag);
  return Buffer.concat([dec.update(ct), dec.final()]);
}

module.exports = { deriveKey, resolveKey, encrypt, decrypt, MAGIC };

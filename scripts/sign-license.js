#!/usr/bin/env node
'use strict';
// Mint a signed license.json for one customer.
//
//   node scripts/sign-license.js <payload.json> <private-key.pem> > license.json
//
// A version 2 payload (docs/LICENSING.md) looks like:
//   {
//     "v": 2,
//     "id": "acme-0001",              per-customer serial: <slug>-<number>, higher supersedes lower
//     "customer": "Acme Corp",
//     "slug": "acme",
//     "domain": "docs.acme.com",      the host of the server's app_url, or "*" for unbound
//     "type": "standard",             or "trial"
//     "plan": "care",
//     "issued": "2026-10-14",
//     "expires": "2027-10-14",        the software term; null = perpetual
//     "updates_until": "2027-10-14",  the maintenance term
//     "grace_days": 30,
//     "seats": 30,                    null = unlimited
//     "seat_policy": "soft",          or "hard"
//     "storage_gb": null,             null = unlimited
//     "features": ["updates", "editor", "api"]   absent = everything
//   }
// `kid` (which public key verifies it) is filled in from the signing key; if the
// payload already carries one it must match. A payload without `v` is signed as
// a version 1 license (only `customer` is required) and keeps that meaning.
//
// The signature covers a CANONICAL serialization of the payload (keys sorted
// recursively). server/lib/license.js#canonical MUST stay identical to this.
const fs = require('fs');
const crypto = require('crypto');

function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  }
  return JSON.stringify(v === undefined ? null : v);
}

// Same derivation as server/lib/license.js#keyId.
function keyId(privateKeyObj) {
  const pub = crypto.createPublicKey(privateKeyObj);
  return crypto.createHash('sha256').update(pub.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);
}

function die(msg) { process.stderr.write(msg + '\n'); process.exit(1); }

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (v) => typeof v === 'string' && DATE_RE.test(v) && !isNaN(new Date(v).getTime());
const isDateOrNull = (v) => v === null || v === undefined || isDate(v);
const isPosIntOrNull = (v) => v === null || v === undefined || (Number.isInteger(v) && v > 0);

function validateV2(p) {
  const errs = [];
  if (!/^[a-z0-9][a-z0-9-]*-\d{1,9}$/i.test(String(p.id || ''))) errs.push('id must look like <slug>-<number>, e.g. acme-0001');
  if (!p.customer || typeof p.customer !== 'string') errs.push('customer is required');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(String(p.slug || ''))) errs.push('slug must be lowercase letters, digits and dashes');
  else if (p.id && !String(p.id).toLowerCase().startsWith(p.slug + '-')) errs.push('id must start with the slug');
  if (!p.domain || typeof p.domain !== 'string') errs.push('domain is required ("*" for unbound)');
  else if (p.domain !== '*' && !/^[a-z0-9.-]+$/i.test(p.domain)) errs.push('domain must be a hostname or "*"');
  if (p.type !== undefined && p.type !== 'standard' && p.type !== 'trial') errs.push('type must be standard or trial');
  if (!isDate(p.issued)) errs.push('issued must be YYYY-MM-DD');
  if (!isDateOrNull(p.expires)) errs.push('expires must be YYYY-MM-DD or null');
  if (!isDateOrNull(p.updates_until)) errs.push('updates_until must be YYYY-MM-DD or null');
  if (p.expires && p.issued && p.expires < p.issued) errs.push('expires is before issued');
  if (p.grace_days !== undefined && !(Number.isInteger(p.grace_days) && p.grace_days >= 0)) errs.push('grace_days must be a whole number of days');
  if (!isPosIntOrNull(p.seats)) errs.push('seats must be a positive whole number or null');
  if (p.seat_policy !== undefined && p.seat_policy !== 'soft' && p.seat_policy !== 'hard') errs.push('seat_policy must be soft or hard');
  if (!isPosIntOrNull(p.storage_gb)) errs.push('storage_gb must be a positive whole number or null');
  if (p.features !== undefined && !(Array.isArray(p.features) && p.features.every((f) => typeof f === 'string' && f))) errs.push('features must be an array of names');
  return errs;
}

const [payloadPath, keyPath] = process.argv.slice(2);
if (!payloadPath || !keyPath) die('usage: sign-license.js <payload.json> <private-key.pem>');

let payload;
try { payload = JSON.parse(fs.readFileSync(payloadPath, 'utf8')); }
catch (e) { die('cannot read/parse payload: ' + e.message); }
if (!payload || typeof payload !== 'object' || Array.isArray(payload)) die('payload must be a JSON object');

let key;
try { key = crypto.createPrivateKey(fs.readFileSync(keyPath, 'utf8')); }
catch (e) { die('cannot read private key: ' + e.message); }
if (key.asymmetricKeyType !== 'ed25519') die('private key must be Ed25519');

if (payload.v === 2) {
  const errs = validateV2(payload);
  if (errs.length) die('payload is not a valid version 2 license:\n  - ' + errs.join('\n  - '));
  const kid = keyId(key);
  if (payload.kid !== undefined && String(payload.kid).toLowerCase() !== kid) die(`payload.kid ${payload.kid} does not match the signing key (${kid})`);
  payload.kid = kid;
} else if (payload.v !== undefined) {
  die('payload.v must be 2, or absent for a version 1 license');
} else if (!payload.customer) {
  die('payload.customer is required');
}

const signature = crypto.sign(null, Buffer.from(canonical(payload), 'utf8'), key).toString('base64');
process.stdout.write(JSON.stringify({ payload, alg: 'ed25519', signature }, null, 2) + '\n');

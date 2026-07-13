#!/usr/bin/env node
'use strict';
// Mint a signed license.json for one customer.
//
//   node scripts/sign-license.js <payload.json> <private-key.pem> > license.json
//
// <payload.json> is the customer entitlement, e.g.:
//   {
//     "customer": "Acme Corp",
//     "plan": "care",
//     "issued": "2026-07-12",
//     "updates_until": "2027-07-12",
//     "features": ["updates"]
//   }
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

function die(msg) { process.stderr.write(msg + '\n'); process.exit(1); }

const [payloadPath, keyPath] = process.argv.slice(2);
if (!payloadPath || !keyPath) die('usage: sign-license.js <payload.json> <private-key.pem>');

let payload;
try { payload = JSON.parse(fs.readFileSync(payloadPath, 'utf8')); }
catch (e) { die('cannot read/parse payload: ' + e.message); }
if (!payload || typeof payload !== 'object' || Array.isArray(payload)) die('payload must be a JSON object');
if (!payload.customer) die('payload.customer is required');

let key;
try { key = crypto.createPrivateKey(fs.readFileSync(keyPath, 'utf8')); }
catch (e) { die('cannot read private key: ' + e.message); }
if (key.asymmetricKeyType !== 'ed25519') die('private key must be Ed25519');

const signature = crypto.sign(null, Buffer.from(canonical(payload), 'utf8'), key).toString('base64');
process.stdout.write(JSON.stringify({ payload, alg: 'ed25519', signature }, null, 2) + '\n');

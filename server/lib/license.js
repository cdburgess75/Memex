'use strict';
// License / entitlement check. A license.json is a small payload signed (Ed25519)
// by Ptech. The matching PRIVATE key lives only with Ptech and is never in this
// repo or referenced here; the app only ever holds the PUBLIC key, so it can
// verify but never mint a license. Everything fails CLOSED: any missing key,
// missing file, bad signature, or parse error yields updatesEntitled=false, so a
// licensed action is hidden rather than wrongly enabled.
//
// license.json shape:
//   { "payload": { "customer": "...", "plan": "care",
//                  "issued": "2026-07-12", "updates_until": "2027-07-12",
//                  "features": ["updates"] },
//     "alg": "ed25519",
//     "signature": "<base64 of Ed25519 sig over canonical(payload)>" }
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Canonical JSON: object keys sorted recursively, no incidental whitespace. The
// signer MUST serialize the payload identically (scripts/sign-license.js does).
function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  }
  return JSON.stringify(v === undefined ? null : v);
}

// env-provided PEMs are often single-line with literal "\n" — restore newlines.
function normalizePem(s) {
  return String(s || '').replace(/\\n/g, '\n').trim();
}

// License config is read from the OPERATOR ENVIRONMENT ONLY (never DB / web
// settings). The license entitles the CUSTOMER, and the customer's own admin must
// not be able to swap the trust anchor or point at a forged file via the settings
// API, so these deliberately bypass settings.getOrEnv (which prefers a DB override).
function publicKeyPem() {
  const inline = normalizePem(process.env.LICENSE_PUBLIC_KEY);
  if (inline) return inline;
  const p = String(process.env.LICENSE_PUBLIC_KEY_PATH || '').trim();
  if (p) { try { return fs.readFileSync(p, 'utf8'); } catch { /* unreadable */ } }
  return null;
}

function licenseFilePath() {
  const configured = String(process.env.LICENSE_FILE || '').trim();
  return configured || path.join(__dirname, '..', '..', 'license.json');
}

function readLicenseFile(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object' || !obj.payload || !obj.signature) return null;
    return obj;
  } catch { return null; }
}

// Verify the Ed25519 signature over the canonical payload. Never throws.
function verifySignature(lic, pubPem) {
  try {
    if (String(lic.alg || 'ed25519').toLowerCase() !== 'ed25519') return false;
    const key = crypto.createPublicKey(pubPem);
    const data = Buffer.from(canonical(lic.payload), 'utf8');
    const sig = Buffer.from(String(lic.signature), 'base64');
    return crypto.verify(null, data, key, sig);
  } catch { return false; }
}

// updates_until is a date (YYYY-MM-DD or ISO). Entitlement lasts through the END
// of that day (UTC) so a license dated today is still valid all of today.
function entitledThrough(updatesUntil, now) {
  if (!updatesUntil) return true; // perpetual updates
  const end = new Date(updatesUntil);
  if (isNaN(end.getTime())) return false;
  // If only a date was given, extend to 23:59:59.999Z of that day.
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(updatesUntil).trim())) end.setUTCHours(23, 59, 59, 999);
  return now.getTime() <= end.getTime();
}

// Pure evaluator (no I/O) so it unit-tests without files. Given the parsed license
// object, the public key PEM, and `now`, return the entitlement status.
function evaluate(lic, pubPem, now = new Date()) {
  if (!pubPem) return { configured: false, present: !!lic, valid: false, updatesEntitled: false, reason: 'no_public_key' };
  if (!lic) return { configured: true, present: false, valid: false, updatesEntitled: false, reason: 'no_license' };
  if (!verifySignature(lic, pubPem)) {
    return { configured: true, present: true, valid: false, updatesEntitled: false, reason: 'bad_signature' };
  }
  const p = lic.payload || {};
  const updatesUntil = p.updates_until || null;
  const features = Array.isArray(p.features) ? p.features : null;
  // "updates" entitlement: signature valid, not expired, and (if a feature list is
  // present) it must include "updates".
  const featureOk = !features || features.includes('updates');
  const withinWindow = entitledThrough(updatesUntil, now);
  const updatesEntitled = featureOk && withinWindow;
  return {
    configured: true,
    present: true,
    valid: true,
    customer: p.customer || null,
    plan: p.plan || null,
    issued: p.issued || null,
    updatesUntil,
    features,
    expired: !!updatesUntil && !withinWindow,
    updatesEntitled,
    reason: updatesEntitled ? 'ok' : (!withinWindow ? 'expired' : 'feature_not_licensed'),
  };
}

async function status(now = new Date()) {
  try {
    const pubPem = await publicKeyPem();
    const lic = readLicenseFile(await licenseFilePath());
    return evaluate(lic, pubPem, now);
  } catch (e) {
    return { configured: false, present: false, valid: false, updatesEntitled: false, reason: 'error:' + e.message };
  }
}

module.exports = { canonical, evaluate, verifySignature, entitledThrough, status, publicKeyPem, licenseFilePath, readLicenseFile };

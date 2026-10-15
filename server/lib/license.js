'use strict';
// License / entitlement check. A license.json is a small payload signed (Ed25519)
// by Ptech. The matching PRIVATE key lives only with Ptech and is never in this
// repo or referenced here; the app only ever holds PUBLIC keys, so it can verify
// but never mint a license. Everything fails CLOSED: any missing key, missing
// file, bad signature, unknown key id, wrong domain, or parse error yields an
// `unlicensed` state with updatesEntitled=false, so a licensed action is hidden
// rather than wrongly enabled.
//
// Two payload versions are understood.
//
// Version 1 (no `v` field) is the original shape and keeps its original meaning:
// unbound to any domain, never expires, updates entitled through `updates_until`.
//   { "payload": { "customer": "...", "plan": "care",
//                  "issued": "2026-07-12", "updates_until": "2027-07-12",
//                  "features": ["updates"] },
//     "alg": "ed25519", "signature": "<base64 of Ed25519 sig over canonical(payload)>" }
//
// Version 2 adds an entitlement the app can enforce (docs/LICENSING.md):
//   { "v": 2,
//     "id": "acme-0002",                 per-customer serial; a lower one is refused once a higher one was seen
//     "kid": "3f9a1c0b7e2d4a6f",         which trusted public key signed it (see keyId)
//     "customer": "Acme Corp", "slug": "acme",
//     "domain": "docs.acme.com",         must equal the host of app_url; "*" = unbound
//     "type": "standard",                or "trial"
//     "plan": "care",
//     "issued": "2026-10-14",
//     "expires": "2027-10-14",           the software term; null = perpetual
//     "updates_until": "2027-10-14",     the maintenance term
//     "grace_days": 30,                  read-only this long after `expires`
//     "seats": 30, "seat_policy": "soft", null seats = unlimited
//     "storage_gb": null,                null = unlimited
//     "features": ["updates", "editor", "api"] }   absent = everything
//
// States (lib consumers read `state`, `readOnly`, `seatFreeze`, `updatesEntitled`):
//   ok         accepted, more than 30 days of term left (or perpetual)
//   expiring   accepted, 30 days or fewer of term left
//   lapsed     term ended, within the grace period: no new accounts, no updates
//   readonly   term ended and the grace period is over
//   unlicensed no file, bad signature, unknown key, wrong domain, lower serial:
//              behaves as lapsed, and as readonly 30 days after it was first seen
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DAY_MS = 86_400_000;
const EXPIRING_DAYS = 30;       // "expiring" starts this many days before the term ends
const DEFAULT_GRACE_DAYS = 30;  // after the term ends, or after an unlicensed state was first seen
const STATES = ['ok', 'expiring', 'lapsed', 'readonly', 'unlicensed'];
const SERIAL_RE = /^([a-z0-9][a-z0-9-]*?)-(\d{1,9})$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Persisted memory lives in system_settings under these keys. They are NOT in
// settings.ENV_MAP, so the admin settings API cannot read or write them.
const MEM_SERIAL = 'license_serial_seen';
const MEM_UNLICENSED_SINCE = 'license_unlicensed_since';

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

// ---- trusted keys -----------------------------------------------------------
// A key id is the first 16 hex characters of SHA-256 over the key's SPKI DER, so
// it can be derived from either half of the pair and never has to be configured.
function keyId(keyObj) {
  const pub = keyObj.type === 'private' ? crypto.createPublicKey(keyObj) : keyObj;
  return crypto.createHash('sha256').update(pub.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);
}

function keysFromPems(pems) {
  const out = [];
  const seen = new Set();
  for (const pem of pems) {
    try {
      const key = crypto.createPublicKey(normalizePem(pem));
      if (key.asymmetricKeyType !== 'ed25519') continue;
      const kid = keyId(key);
      if (seen.has(kid)) continue;
      seen.add(kid);
      out.push({ kid, key });
    } catch { /* not a public key */ }
  }
  return out;
}

// License config is read from the OPERATOR ENVIRONMENT ONLY (never DB / web
// settings). The license entitles the CUSTOMER, and the customer's own admin must
// not be able to swap the trust anchor or point at a forged file via the settings
// API, so these deliberately bypass settings.getOrEnv (which prefers a DB override).
//   LICENSE_PUBLIC_KEY       one PEM inline
//   LICENSE_PUBLIC_KEY_PATH  one PEM file
//   LICENSE_PUBLIC_KEYS_DIR  every *.pem in a directory (default: the repo's keys/;
//                            set it to an empty string to disable the default)
function trustedKeys() {
  const pems = [];
  const inline = normalizePem(process.env.LICENSE_PUBLIC_KEY);
  if (inline) pems.push(inline);
  const one = String(process.env.LICENSE_PUBLIC_KEY_PATH || '').trim();
  if (one) { try { pems.push(fs.readFileSync(one, 'utf8')); } catch { /* unreadable */ } }
  const dir = process.env.LICENSE_PUBLIC_KEYS_DIR === undefined
    ? path.join(__dirname, '..', '..', 'keys')
    : String(process.env.LICENSE_PUBLIC_KEYS_DIR).trim();
  if (dir) {
    let names = [];
    try { names = fs.readdirSync(dir).filter((f) => /\.pem$/i.test(f)).sort(); } catch { /* no such dir */ }
    for (const f of names) { try { pems.push(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { /* unreadable */ } }
  }
  return keysFromPems(pems);
}

// Kept for callers that want a single PEM (the first trusted key), or null.
function publicKeyPem() {
  const k = trustedKeys()[0];
  return k ? k.key.export({ type: 'spki', format: 'pem' }) : null;
}

function licenseFilePath() {
  const configured = String(process.env.LICENSE_FILE || '').trim();
  return configured || path.join(__dirname, '..', '..', 'license.json');
}

function readLicenseFile(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
  return parseLicense(raw);
}

// A license as JSON text or an already-parsed object; null when it is not one.
function parseLicense(raw) {
  try {
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!obj || typeof obj !== 'object' || !obj.payload || typeof obj.payload !== 'object' || !obj.signature) return null;
    return obj;
  } catch { return null; }
}

// ---- signature --------------------------------------------------------------
function verifyWith(lic, keyObj) {
  try {
    if (String(lic.alg || 'ed25519').toLowerCase() !== 'ed25519') return false;
    const data = Buffer.from(canonical(lic.payload), 'utf8');
    const sig = Buffer.from(String(lic.signature), 'base64');
    return crypto.verify(null, data, keyObj, sig);
  } catch { return false; }
}

// Verify the Ed25519 signature over the canonical payload with one PEM. Never throws.
function verifySignature(lic, pubPem) {
  try { return verifyWith(lic, crypto.createPublicKey(normalizePem(pubPem))); } catch { return false; }
}

// Accepts a PEM string, one {kid,key}, or an array of them. Returns [{kid,key}].
function toKeyList(keys) {
  if (!keys) return [];
  if (typeof keys === 'string') return keysFromPems([keys]);
  if (Array.isArray(keys)) return keys.filter((k) => k && k.key);
  return keys.key ? [keys] : [];
}

// ---- dates ------------------------------------------------------------------
// A date-only value (YYYY-MM-DD) lasts through the END of that day (UTC), so a
// license dated today is still valid all of today. Returns ms, or NaN.
function endOfDay(value) {
  if (value === null || value === undefined || value === '') return NaN;
  const s = String(value).trim();
  const d = new Date(s);
  if (isNaN(d.getTime())) return NaN;
  if (DATE_RE.test(s)) d.setUTCHours(23, 59, 59, 999);
  return d.getTime();
}

// updates_until: absent means perpetual updates.
function entitledThrough(updatesUntil, now) {
  if (!updatesUntil) return true;
  const end = endOfDay(updatesUntil);
  if (isNaN(end)) return false;
  return now.getTime() <= end;
}

function isoDay(ms) { return new Date(ms).toISOString(); }

function parseSerial(id) {
  const m = SERIAL_RE.exec(String(id || '').trim());
  return m ? { lineage: m[1].toLowerCase(), n: Number(m[2]) } : null;
}

function hostOf(url) {
  try { return new URL(String(url)).hostname.toLowerCase() || null; } catch { return null; }
}

// ---- evaluation ---------------------------------------------------------------
// Pure (no I/O) so it unit-tests without files or a database.
//   lic   the parsed license object, or null
//   keys  trusted public keys (PEM string, {kid,key}, or an array of them)
//   now   the clock
//   ctx   { appHost, serialSeen, unlicensedSince } from loadContext(): the host of
//         app_url, the highest serial accepted so far, and when an unlicensed
//         state was first recorded (ISO) — all optional
function evaluate(lic, keys, now = new Date(), ctx = {}) {
  const trusted = toKeyList(keys);
  const t = now.getTime();
  const base = {
    configured: trusted.length > 0, present: !!lic, valid: false, accepted: false,
    version: null, state: 'unlicensed', stateReason: null, readOnly: false, seatFreeze: true,
    updatesEntitled: false, reason: null,
    customer: null, plan: null, issued: null, updatesUntil: null, features: null, expired: false,
    serial: null, kid: null, slug: null, domain: null, domainMatch: null, type: null,
    expires: null, graceDays: DEFAULT_GRACE_DAYS, graceEnds: null, daysLeft: null,
    seats: { licensed: null, policy: null, used: null }, storageGb: null,
    source: 'file', warnings: [],
  };
  // The unlicensed grace: read-only 30 days after the state was first seen.
  const unlicensed = (reason) => {
    const since = ctx.unlicensedSince ? new Date(ctx.unlicensedSince).getTime() : NaN;
    const graceEnd = isNaN(since) ? null : since + DEFAULT_GRACE_DAYS * DAY_MS;
    return { ...base, stateReason: reason, reason, graceEnds: graceEnd ? isoDay(graceEnd) : null, readOnly: !!graceEnd && t > graceEnd };
  };

  if (!trusted.length) return unlicensed('no_public_key');
  if (!lic) return unlicensed('no_license');

  const p = lic.payload || {};
  const version = p.v === 2 ? 2 : (p.v === undefined || p.v === null) ? 1 : null;
  if (version === null) return { ...unlicensed('bad_payload'), present: true };

  // Which key? v2 names it; v1 predates key ids, so any trusted key may vouch.
  let signer = null;
  if (version === 2) {
    const kid = String(p.kid || '').toLowerCase();
    signer = trusted.find((k) => k.kid === kid) || null;
    if (!signer) return { ...unlicensed('unknown_kid'), kid: kid || null, version };
    if (!verifyWith(lic, signer.key)) return { ...unlicensed('bad_signature'), kid, version };
  } else {
    signer = trusted.find((k) => verifyWith(lic, k.key)) || null;
    if (!signer) return { ...unlicensed('bad_signature'), version };
  }

  const features = Array.isArray(p.features) ? p.features.map(String) : null;
  const updatesUntil = p.updates_until || null;
  const withinUpdates = entitledThrough(updatesUntil, now);
  const featureOk = !features || features.includes('updates');
  const common = {
    ...base, valid: true, version, kid: signer.kid,
    customer: p.customer || null, plan: p.plan || null, issued: p.issued || null,
    updatesUntil, features, expired: !!updatesUntil && !withinUpdates,
  };

  if (version === 1) {
    const updatesEntitled = featureOk && withinUpdates;
    return {
      ...common, accepted: true, state: 'ok', stateReason: 'ok', readOnly: false, seatFreeze: false,
      domainMatch: true, updatesEntitled,
      reason: updatesEntitled ? 'ok' : (!withinUpdates ? 'expired' : 'feature_not_licensed'),
    };
  }

  // ---- version 2 ----
  const serial = parseSerial(p.id);
  const domain = p.domain ? String(p.domain).trim().toLowerCase() : null;
  const type = p.type === 'trial' ? 'trial' : 'standard';
  const graceDays = Number.isInteger(p.grace_days) && p.grace_days >= 0 ? p.grace_days : DEFAULT_GRACE_DAYS;
  const seatsLicensed = Number.isInteger(p.seats) && p.seats > 0 ? p.seats : null;
  const seatPolicy = p.seat_policy === 'hard' ? 'hard' : 'soft';
  const storageGb = Number.isInteger(p.storage_gb) && p.storage_gb > 0 ? p.storage_gb : null;
  const v2 = {
    ...common, serial: serial ? `${serial.lineage}-${String(serial.n).padStart(4, '0')}` : (p.id || null),
    slug: p.slug || null, domain, type, graceDays,
    seats: { licensed: seatsLicensed, policy: seatPolicy, used: null }, storageGb,
  };
  const refuse = (reason) => ({ ...unlicensed(reason), ...pick(v2, ['valid', 'version', 'kid', 'customer', 'plan', 'issued', 'updatesUntil', 'features', 'expired', 'serial', 'slug', 'domain', 'type', 'seats']), domainMatch: v2.domainMatch ?? null });

  if (!serial || !domain) return refuse('bad_payload');
  const expiresAt = p.expires === null || p.expires === undefined ? null : endOfDay(p.expires);
  if (expiresAt !== null && isNaN(expiresAt)) return refuse('bad_payload');

  v2.domainMatch = domain === '*' || (!!ctx.appHost && domain === String(ctx.appHost).toLowerCase());
  if (!v2.domainMatch) return refuse('domain_mismatch');

  const seen = parseSerial(ctx.serialSeen);
  if (seen) {
    if (seen.lineage !== serial.lineage) return refuse('serial_mismatch');
    if (serial.n < seen.n) return refuse('serial_regressed');
  }

  // Accepted. Now where in its term is it?
  let state = 'ok';
  let daysLeft = null;
  let graceEnds = null;
  if (expiresAt !== null) {
    const graceEnd = expiresAt + graceDays * DAY_MS;
    graceEnds = isoDay(graceEnd);
    daysLeft = Math.floor((expiresAt - t) / DAY_MS); // whole days; 0 = ends today
    if (t > graceEnd) state = 'readonly';
    else if (t > expiresAt) state = 'lapsed';
    else if (daysLeft <= EXPIRING_DAYS) state = 'expiring';
  }
  const live = state === 'ok' || state === 'expiring';
  const updatesEntitled = live && featureOk && withinUpdates;
  const warnings = [];
  if (state === 'expiring') warnings.push(daysLeft === 0 ? 'term ends today' : `term ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`);
  if (state === 'lapsed') warnings.push(`term ended ${p.expires}; read-only from ${graceEnds.slice(0, 10)}`);
  if (state === 'readonly') warnings.push(`read-only since ${graceEnds.slice(0, 10)}`);
  return {
    ...v2, accepted: true, state, stateReason: state, readOnly: state === 'readonly', seatFreeze: !live,
    expires: p.expires ?? null, graceEnds, daysLeft, updatesEntitled, warnings,
    reason: updatesEntitled ? 'ok' : (!live ? state : !withinUpdates ? 'expired' : 'feature_not_licensed'),
  };
}

function pick(obj, keys) { const o = {}; for (const k of keys) o[k] = obj[k]; return o; }

// ---- persistence -------------------------------------------------------------
// What evaluate() needs from the running install. Any failure degrades to an
// empty context: the signature still decides, memory just does not apply.
async function loadContext() {
  const ctx = { appHost: null, serialSeen: null, unlicensedSince: null };
  try {
    const settings = require('./settings');
    ctx.appHost = hostOf(await settings.getOrEnv('app_url'));
    ctx.serialSeen = await settings.get(MEM_SERIAL);
    ctx.unlicensedSince = await settings.get(MEM_UNLICENSED_SINCE);
  } catch { /* settings unavailable (no DB yet) */ }
  return ctx;
}

// Remember the highest accepted serial, and when an unlicensed state began.
// Best effort: a failed write must never change the answer.
async function remember(st, ctx, now) {
  try {
    const settings = require('./settings');
    if (st.accepted) {
      const mine = parseSerial(st.serial);
      const seen = parseSerial(ctx.serialSeen);
      if (mine && (!seen || mine.n > seen.n)) await settings.set(MEM_SERIAL, st.serial);
      if (ctx.unlicensedSince) await settings.set(MEM_UNLICENSED_SINCE, null);
    } else if (!ctx.unlicensedSince) {
      await settings.set(MEM_UNLICENSED_SINCE, now.toISOString());
      st.graceEnds = isoDay(now.getTime() + DEFAULT_GRACE_DAYS * DAY_MS);
    }
  } catch { /* no DB: nothing to remember */ }
}

// The live status: trusted keys + the mounted license file + what the install
// remembers. Never throws.
async function status(now = new Date()) {
  try {
    const keys = trustedKeys();
    const lic = readLicenseFile(licenseFilePath());
    const ctx = await loadContext();
    const st = evaluate(lic, keys, now, ctx);
    await remember(st, ctx, now);
    return st;
  } catch (e) {
    return { configured: false, present: false, valid: false, accepted: false, state: 'unlicensed', stateReason: 'error', readOnly: false, seatFreeze: true, updatesEntitled: false, reason: 'error:' + e.message, warnings: [] };
  }
}

module.exports = {
  canonical, evaluate, verifySignature, entitledThrough, status, publicKeyPem, licenseFilePath, readLicenseFile,
  parseLicense, trustedKeys, keyId, keysFromPems, parseSerial, endOfDay, loadContext,
  STATES, EXPIRING_DAYS, DEFAULT_GRACE_DAYS, MEM_SERIAL, MEM_UNLICENSED_SINCE,
};

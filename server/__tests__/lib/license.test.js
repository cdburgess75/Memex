'use strict';
// Covers license entitlement evaluation: canonical signing, Ed25519 verification,
// the update window, and fail-closed behavior on every missing/invalid input.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const license = require('../../lib/license');

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const PUB = publicKey.export({ type: 'spki', format: 'pem' });
const OTHER = crypto.generateKeyPairSync('ed25519').privateKey;

const NOW = new Date('2026-07-12T12:00:00.000Z');

// Sign exactly like scripts/sign-license.js: Ed25519 over canonical(payload).
function mkLicense(payload, signer = privateKey) {
  const sig = crypto.sign(null, Buffer.from(license.canonical(payload), 'utf8'), signer).toString('base64');
  return { payload, alg: 'ed25519', signature: sig };
}

const GOOD = { customer: 'Acme', plan: 'care', issued: '2026-01-01', updates_until: '2027-07-12', features: ['updates'] };

describe('canonical', () => {
  test('sorts object keys recursively and is stable', () => {
    expect(license.canonical({ b: 1, a: [{ y: 2, x: 1 }] })).toBe('{"a":[{"x":1,"y":2}],"b":1}');
  });
});

describe('entitledThrough', () => {
  test('perpetual (no date) is always entitled', () => {
    expect(license.entitledThrough(null, NOW)).toBe(true);
  });
  test('a date-only value lasts through the end of that UTC day', () => {
    expect(license.entitledThrough('2026-07-12', NOW)).toBe(true);        // same day, still valid
    expect(license.entitledThrough('2026-07-11', NOW)).toBe(false);       // yesterday, expired
  });
  test('an unparseable date is not entitled', () => {
    expect(license.entitledThrough('whenever', NOW)).toBe(false);
  });
});

describe('evaluate', () => {
  test('fails closed with no public key', () => {
    const r = license.evaluate(mkLicense(GOOD), null, NOW);
    expect(r).toMatchObject({ configured: false, updatesEntitled: false, reason: 'no_public_key' });
  });

  test('fails closed with no license file', () => {
    const r = license.evaluate(null, PUB, NOW);
    expect(r).toMatchObject({ configured: true, present: false, updatesEntitled: false, reason: 'no_license' });
  });

  test('a valid, in-window license entitles updates', () => {
    const r = license.evaluate(mkLicense(GOOD), PUB, NOW);
    expect(r).toMatchObject({ valid: true, customer: 'Acme', plan: 'care', updatesEntitled: true, reason: 'ok' });
  });

  test('an expired license is valid but not entitled', () => {
    const r = license.evaluate(mkLicense({ ...GOOD, updates_until: '2026-06-01' }), PUB, NOW);
    expect(r).toMatchObject({ valid: true, expired: true, updatesEntitled: false, reason: 'expired' });
  });

  test('a tampered payload no longer verifies', () => {
    const lic = mkLicense(GOOD);
    lic.payload = { ...lic.payload, updates_until: '2099-01-01' }; // change after signing
    const r = license.evaluate(lic, PUB, NOW);
    expect(r).toMatchObject({ valid: false, updatesEntitled: false, reason: 'bad_signature' });
  });

  test('a signature from a different key is rejected', () => {
    const r = license.evaluate(mkLicense(GOOD, OTHER), PUB, NOW);
    expect(r.reason).toBe('bad_signature');
  });

  test('a non-ed25519 alg is rejected', () => {
    const lic = mkLicense(GOOD); lic.alg = 'rs256';
    expect(license.evaluate(lic, PUB, NOW).reason).toBe('bad_signature');
  });

  test('a valid license lacking the updates feature is not entitled', () => {
    const r = license.evaluate(mkLicense({ ...GOOD, features: ['reports'] }), PUB, NOW);
    expect(r).toMatchObject({ valid: true, updatesEntitled: false, reason: 'feature_not_licensed' });
  });

  test('no features array means all features (updates entitled)', () => {
    const { features, ...noFeatures } = GOOD;
    expect(license.evaluate(mkLicense(noFeatures), PUB, NOW).updatesEntitled).toBe(true);
  });
});

describe('status (config is env-only, never web/DB settable)', () => {
  const saved = {};
  const tmp = path.join(os.tmpdir(), `memex-license-${process.pid}.json`);
  beforeEach(() => {
    for (const k of ['LICENSE_PUBLIC_KEY', 'LICENSE_PUBLIC_KEY_PATH', 'LICENSE_FILE']) saved[k] = process.env[k];
  });
  afterEach(() => {
    for (const k of ['LICENSE_PUBLIC_KEY', 'LICENSE_PUBLIC_KEY_PATH', 'LICENSE_FILE']) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
    try { fs.unlinkSync(tmp); } catch { /* not written */ }
  });

  test('reads the public key + license file from the operator env and entitles', async () => {
    fs.writeFileSync(tmp, JSON.stringify(mkLicense(GOOD)));
    process.env.LICENSE_PUBLIC_KEY = PUB;
    process.env.LICENSE_FILE = tmp;
    const r = await license.status(NOW);
    expect(r).toMatchObject({ configured: true, present: true, valid: true, customer: 'Acme', updatesEntitled: true });
  });

  test('no env public key fails closed even if a license file exists', async () => {
    fs.writeFileSync(tmp, JSON.stringify(mkLicense(GOOD)));
    delete process.env.LICENSE_PUBLIC_KEY;
    delete process.env.LICENSE_PUBLIC_KEY_PATH;
    process.env.LICENSE_FILE = tmp;
    const r = await license.status(NOW);
    expect(r).toMatchObject({ configured: false, updatesEntitled: false, reason: 'no_public_key' });
  });
});

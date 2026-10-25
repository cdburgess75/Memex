'use strict';
// Covers license entitlement evaluation: canonical signing, Ed25519 verification,
// trusted-key loading and key ids, the version 1 updates window, the version 2
// term / grace / domain / serial rules, what the install remembers, and the
// fail-closed answer for every bad input.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The install's memory (system_settings) lives in a Map here, so no database.
const mockStore = new Map();
jest.mock('../../lib/settings', () => ({
  get: async (k) => (mockStore.has(k) ? mockStore.get(k) : null),
  getOrEnv: async (k) => (mockStore.has(k) ? mockStore.get(k) : (k === 'app_url' ? (process.env.APP_URL || null) : null)),
  set: async (k, v) => { if (v === null || v === undefined || v === '') mockStore.delete(k); else mockStore.set(k, String(v)); },
}));
const license = require('../../lib/license');

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const PUB = publicKey.export({ type: 'spki', format: 'pem' });
const KID = license.keyId(publicKey);
const OTHER = crypto.generateKeyPairSync('ed25519');
const OTHER_PUB = OTHER.publicKey.export({ type: 'spki', format: 'pem' });
const OTHER_KID = license.keyId(OTHER.publicKey);

const NOW = new Date('2026-07-12T12:00:00.000Z');
const DAY = 86_400_000;
const at = (days) => new Date(NOW.getTime() + days * DAY);
const dateIn = (days) => at(days).toISOString().slice(0, 10);
const endOf = (days) => dateIn(days) + 'T23:59:59.999Z';

// Sign exactly like scripts/sign-license.js: Ed25519 over canonical(payload).
function mkLicense(payload, signer = privateKey) {
  const sig = crypto.sign(null, Buffer.from(license.canonical(payload), 'utf8'), signer).toString('base64');
  return { payload, alg: 'ed25519', signature: sig };
}

async function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k];
  }
  try { return await fn(); } finally {
    for (const k of Object.keys(vars)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

const GOOD = { customer: 'Acme', plan: 'care', issued: '2026-01-01', updates_until: '2027-07-12', features: ['updates'] };
const V2 = {
  v: 2, id: 'acme-0003', kid: KID, customer: 'Acme Corp', slug: 'acme', domain: 'docs.acme.com', type: 'standard',
  plan: 'care', issued: '2026-01-01', expires: '2027-01-01', updates_until: '2027-01-01', grace_days: 30,
  seats: 25, seat_policy: 'soft', storage_gb: null, features: ['updates', 'editor', 'api'],
};
const CTX = { appHost: 'docs.acme.com', serialSeen: null, unlicensedSince: null };
const ev2 = (over = {}, ctx = CTX, signer = privateKey) => license.evaluate(mkLicense({ ...V2, ...over }, signer), PUB, NOW, ctx);

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

describe('trusted keys', () => {
  test('a key id is 16 hex characters and the same from either half of the pair', () => {
    expect(KID).toMatch(/^[0-9a-f]{16}$/);
    expect(license.keyId(privateKey)).toBe(KID);
    expect(OTHER_KID).not.toBe(KID);
  });

  test('keysFromPems dedupes and ignores what is not an Ed25519 public key', () => {
    const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' });
    const keys = license.keysFromPems([PUB, PUB, rsa, 'garbage', OTHER_PUB]);
    expect(keys.map((k) => k.kid)).toEqual([KID, OTHER_KID]);
  });

  test('trustedKeys reads every .pem in LICENSE_PUBLIC_KEYS_DIR plus the inline key, once each', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memex-keys-'));
    fs.writeFileSync(path.join(dir, 'a.pem'), PUB);
    fs.writeFileSync(path.join(dir, 'b.pem'), OTHER_PUB);
    fs.writeFileSync(path.join(dir, 'notes.txt'), PUB);
    await withEnv({ LICENSE_PUBLIC_KEY: PUB, LICENSE_PUBLIC_KEY_PATH: '', LICENSE_PUBLIC_KEYS_DIR: dir }, () => {
      expect(license.trustedKeys().map((k) => k.kid).sort()).toEqual([KID, OTHER_KID].sort());
    });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('an empty LICENSE_PUBLIC_KEYS_DIR disables the default keys/ directory', async () => {
    await withEnv({ LICENSE_PUBLIC_KEY: '', LICENSE_PUBLIC_KEY_PATH: '', LICENSE_PUBLIC_KEYS_DIR: '' }, () => {
      expect(license.trustedKeys()).toEqual([]);
    });
  });

  test('the shipped verify key loads from the default keys/ directory', async () => {
    await withEnv({ LICENSE_PUBLIC_KEY: '', LICENSE_PUBLIC_KEY_PATH: '', LICENSE_PUBLIC_KEYS_DIR: undefined }, () => {
      const shipped = crypto.createPublicKey(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'keys', 'ptech-license-public.pem'), 'utf8'));
      expect(license.trustedKeys().map((k) => k.kid)).toContain(license.keyId(shipped));
    });
  });
});

describe('evaluate, version 1', () => {
  test('fails closed with no public key', () => {
    const r = license.evaluate(mkLicense(GOOD), null, NOW);
    expect(r).toMatchObject({ configured: false, accepted: false, state: 'unlicensed', stateReason: 'no_public_key', updatesEntitled: false, reason: 'no_public_key' });
  });

  test('fails closed with no license file', () => {
    const r = license.evaluate(null, PUB, NOW);
    expect(r).toMatchObject({ configured: true, present: false, accepted: false, state: 'unlicensed', seatFreeze: true, updatesEntitled: false, reason: 'no_license' });
  });

  test('a valid, in-window license entitles updates', () => {
    const r = license.evaluate(mkLicense(GOOD), PUB, NOW);
    expect(r).toMatchObject({ valid: true, accepted: true, version: 1, state: 'ok', kid: KID, domainMatch: true, customer: 'Acme', plan: 'care', updatesEntitled: true, reason: 'ok' });
  });

  test('an expired license is valid but not entitled, and never lapses', () => {
    const r = license.evaluate(mkLicense({ ...GOOD, updates_until: '2026-06-01' }), PUB, NOW);
    expect(r).toMatchObject({ valid: true, accepted: true, expired: true, state: 'ok', readOnly: false, seatFreeze: false, updatesEntitled: false, reason: 'expired' });
  });

  test('a tampered payload no longer verifies', () => {
    const lic = mkLicense(GOOD);
    lic.payload = { ...lic.payload, updates_until: '2099-01-01' }; // change after signing
    const r = license.evaluate(lic, PUB, NOW);
    expect(r).toMatchObject({ valid: false, accepted: false, state: 'unlicensed', updatesEntitled: false, reason: 'bad_signature' });
  });

  test('a signature from an untrusted key is rejected', () => {
    expect(license.evaluate(mkLicense(GOOD, OTHER.privateKey), PUB, NOW).reason).toBe('bad_signature');
  });

  test('any trusted key may vouch for a version 1 license', () => {
    const r = license.evaluate(mkLicense(GOOD, OTHER.privateKey), license.keysFromPems([PUB, OTHER_PUB]), NOW);
    expect(r).toMatchObject({ accepted: true, kid: OTHER_KID });
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

describe('evaluate, version 2', () => {
  test('an accepted license in its term reports ok with its entitlements', () => {
    const r = ev2({ expires: dateIn(100) });
    expect(r).toMatchObject({
      valid: true, accepted: true, version: 2, state: 'ok', stateReason: 'ok', readOnly: false, seatFreeze: false,
      updatesEntitled: true, reason: 'ok', serial: 'acme-0003', kid: KID, slug: 'acme', domain: 'docs.acme.com', domainMatch: true,
      type: 'standard', plan: 'care', customer: 'Acme Corp', expires: dateIn(100), graceDays: 30, graceEnds: endOf(130), daysLeft: 100,
      seats: { licensed: 25, policy: 'soft', used: null }, storageGb: null, features: ['updates', 'editor', 'api'], warnings: [],
    });
  });

  test('expiring starts at 30 whole days left and counts down to "today"', () => {
    expect(ev2({ expires: dateIn(31) })).toMatchObject({ state: 'ok', daysLeft: 31 });
    expect(ev2({ expires: dateIn(30) })).toMatchObject({ state: 'expiring', daysLeft: 30, updatesEntitled: true, seatFreeze: false, warnings: ['term ends in 30 days'] });
    expect(ev2({ expires: dateIn(1) })).toMatchObject({ state: 'expiring', daysLeft: 1, warnings: ['term ends in 1 day'] });
    expect(ev2({ expires: dateIn(0) })).toMatchObject({ state: 'expiring', daysLeft: 0, warnings: ['term ends today'] });
  });

  test('lapsed: the day after the term, inside the grace period, freezes seats and updates', () => {
    const r = ev2({ expires: dateIn(-1) });
    expect(r).toMatchObject({ accepted: true, state: 'lapsed', readOnly: false, seatFreeze: true, updatesEntitled: false, reason: 'lapsed', graceEnds: endOf(29), daysLeft: -1 });
    expect(r.warnings).toEqual([`term ended ${dateIn(-1)}; read-only from ${dateIn(29)}`]);
  });

  test('readonly: the day after the grace period ends', () => {
    expect(ev2({ expires: dateIn(-30) })).toMatchObject({ state: 'lapsed', readOnly: false });
    expect(ev2({ expires: dateIn(-31) })).toMatchObject({ state: 'readonly', readOnly: true, seatFreeze: true, updatesEntitled: false, reason: 'readonly', warnings: [`read-only since ${dateIn(-1)}`] });
  });

  test('grace_days 0 goes straight to readonly; a missing grace_days means 30', () => {
    expect(ev2({ expires: dateIn(-1), grace_days: 0 })).toMatchObject({ state: 'readonly', graceDays: 0 });
    const { grace_days, ...noGrace } = V2;
    expect(license.evaluate(mkLicense({ ...noGrace, expires: dateIn(-1) }), PUB, NOW, CTX)).toMatchObject({ state: 'lapsed', graceDays: 30 });
  });

  test('a perpetual term is always ok; updates still stop at updates_until', () => {
    expect(ev2({ expires: null })).toMatchObject({ state: 'ok', graceEnds: null, daysLeft: null, updatesEntitled: true });
    expect(ev2({ expires: null, updates_until: '2026-01-01' })).toMatchObject({ state: 'ok', expired: true, updatesEntitled: false, reason: 'expired' });
  });

  test('features gate updates as before; an absent list means everything', () => {
    expect(ev2({ features: ['editor'] })).toMatchObject({ state: 'ok', updatesEntitled: false, reason: 'feature_not_licensed' });
    const { features, ...all } = V2;
    expect(license.evaluate(mkLicense(all), PUB, NOW, CTX)).toMatchObject({ features: null, updatesEntitled: true });
  });

  test('type, seats and storage are reported with safe defaults', () => {
    expect(ev2({ type: 'trial' }).type).toBe('trial');
    expect(ev2({ type: 'weird' }).type).toBe('standard');
    expect(ev2({ seats: null, seat_policy: 'hard', storage_gb: 500 })).toMatchObject({ seats: { licensed: null, policy: 'hard' }, storageGb: 500 });
    expect(ev2({ seats: -4, storage_gb: 'lots' })).toMatchObject({ seats: { licensed: null, policy: 'soft' }, storageGb: null });
  });

  test('a serial is normalised to four digits', () => {
    expect(ev2({ id: 'acme-7' }).serial).toBe('acme-0007');
  });

  test('an unknown key id fails closed without trying other keys', () => {
    expect(ev2({ kid: 'deadbeefdeadbeef' })).toMatchObject({ present: true, version: 2, valid: false, accepted: false, state: 'unlicensed', stateReason: 'unknown_kid', kid: 'deadbeefdeadbeef' });
  });

  test('a known key id with a signature from another key is a bad signature', () => {
    expect(ev2({}, CTX, OTHER.privateKey)).toMatchObject({ valid: false, accepted: false, stateReason: 'bad_signature' });
  });

  test('the domain must match the host of app_url, case-insensitively', () => {
    expect(ev2({}, { ...CTX, appHost: 'other.example.com' })).toMatchObject({ valid: true, accepted: false, state: 'unlicensed', stateReason: 'domain_mismatch', domainMatch: false, customer: 'Acme Corp', seatFreeze: true });
    expect(ev2({}, { ...CTX, appHost: null })).toMatchObject({ accepted: false, stateReason: 'domain_mismatch' });
    expect(ev2({ domain: 'Docs.ACME.com' }, { ...CTX, appHost: 'docs.acme.com' })).toMatchObject({ accepted: true, domain: 'docs.acme.com' });
  });

  test('a "*" domain is unbound', () => {
    expect(ev2({ domain: '*' }, { ...CTX, appHost: null })).toMatchObject({ accepted: true, domainMatch: true });
  });

  test('a serial lower than one already seen is refused; equal or higher is accepted', () => {
    expect(ev2({}, { ...CTX, serialSeen: 'acme-0005' })).toMatchObject({ valid: true, accepted: false, stateReason: 'serial_regressed' });
    expect(ev2({}, { ...CTX, serialSeen: 'acme-0003' })).toMatchObject({ accepted: true });
    expect(ev2({}, { ...CTX, serialSeen: 'acme-0002' })).toMatchObject({ accepted: true });
    expect(ev2({}, { ...CTX, serialSeen: 'beta-0001' })).toMatchObject({ accepted: false, stateReason: 'serial_mismatch' });
  });

  test('a malformed payload fails closed', () => {
    expect(ev2({ id: 'nope' })).toMatchObject({ accepted: false, stateReason: 'bad_payload' });
    expect(ev2({ expires: 'soon' })).toMatchObject({ accepted: false, stateReason: 'bad_payload' });
    expect(ev2({ domain: '' })).toMatchObject({ accepted: false, stateReason: 'bad_payload' });
    expect(ev2({ v: 3 })).toMatchObject({ present: true, accepted: false, stateReason: 'bad_payload' });
  });

  test('an unlicensed install turns read-only 30 days after that was first seen', () => {
    expect(license.evaluate(null, PUB, NOW, {})).toMatchObject({ readOnly: false, graceEnds: null });
    expect(license.evaluate(null, PUB, NOW, { unlicensedSince: at(-10).toISOString() })).toMatchObject({ readOnly: false, graceEnds: at(20).toISOString() });
    expect(license.evaluate(null, PUB, NOW, { unlicensedSince: at(-31).toISOString() })).toMatchObject({ state: 'unlicensed', readOnly: true });
    expect(ev2({ kid: 'deadbeefdeadbeef' }, { ...CTX, unlicensedSince: at(-31).toISOString() })).toMatchObject({ stateReason: 'unknown_kid', readOnly: true });
  });
});

describe('status (config is env-only; memory is in system_settings)', () => {
  let tmp, licFile;
  const ENV = { LICENSE_PUBLIC_KEY: PUB, LICENSE_PUBLIC_KEY_PATH: '', LICENSE_PUBLIC_KEYS_DIR: '', APP_URL: 'https://docs.acme.com' };
  const write = (lic) => fs.writeFileSync(licFile, JSON.stringify(lic));
  beforeEach(() => {
    mockStore.clear();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memex-license-'));
    licFile = path.join(tmp, 'license.json');
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  test('reads the public key + license file from the operator env and entitles', async () => {
    write(mkLicense(GOOD));
    const r = await withEnv({ ...ENV, LICENSE_FILE: licFile }, () => license.status(NOW));
    expect(r).toMatchObject({ configured: true, present: true, valid: true, accepted: true, state: 'ok', customer: 'Acme', updatesEntitled: true });
  });

  test('no trusted key fails closed even if a license file exists', async () => {
    write(mkLicense(GOOD));
    const r = await withEnv({ ...ENV, LICENSE_PUBLIC_KEY: '', LICENSE_FILE: licFile }, () => license.status(NOW));
    expect(r).toMatchObject({ configured: false, accepted: false, updatesEntitled: false, reason: 'no_public_key' });
  });

  test('trusts every key in LICENSE_PUBLIC_KEYS_DIR', async () => {
    fs.writeFileSync(path.join(tmp, 'second.pem'), OTHER_PUB);
    write(mkLicense(GOOD, OTHER.privateKey));
    const r = await withEnv({ ...ENV, LICENSE_PUBLIC_KEY: '', LICENSE_PUBLIC_KEYS_DIR: tmp, LICENSE_FILE: licFile }, () => license.status(NOW));
    expect(r).toMatchObject({ accepted: true, kid: OTHER_KID });
  });

  test('a version 2 license is matched against the host of app_url', async () => {
    write(mkLicense(V2));
    expect(await withEnv({ ...ENV, LICENSE_FILE: licFile }, () => license.status(NOW))).toMatchObject({ accepted: true, state: 'ok', domainMatch: true });
    expect(await withEnv({ ...ENV, APP_URL: 'https://elsewhere.example.com', LICENSE_FILE: licFile }, () => license.status(NOW))).toMatchObject({ accepted: false, stateReason: 'domain_mismatch' });
  });

  test('remembers the highest serial and refuses a lower one afterwards', async () => {
    const run = () => withEnv({ ...ENV, LICENSE_FILE: licFile }, () => license.status(NOW));
    write(mkLicense(V2));
    expect(await run()).toMatchObject({ accepted: true, serial: 'acme-0003' });
    expect(mockStore.get(license.MEM_SERIAL)).toBe('acme-0003');
    write(mkLicense({ ...V2, id: 'acme-0002' }));
    expect(await run()).toMatchObject({ accepted: false, stateReason: 'serial_regressed' });
    expect(mockStore.get(license.MEM_SERIAL)).toBe('acme-0003');
    write(mkLicense({ ...V2, id: 'acme-0004' }));
    expect(await run()).toMatchObject({ accepted: true, serial: 'acme-0004' });
    expect(mockStore.get(license.MEM_SERIAL)).toBe('acme-0004');
  });

  test('records when an unlicensed state began, turns read-only after 30 days, and clears it on acceptance', async () => {
    const run = (now) => withEnv({ ...ENV, LICENSE_FILE: licFile }, () => license.status(now));
    expect(await run(NOW)).toMatchObject({ present: false, stateReason: 'no_license', readOnly: false, graceEnds: at(30).toISOString() });
    expect(mockStore.get(license.MEM_UNLICENSED_SINCE)).toBe(NOW.toISOString());
    expect(await run(at(29))).toMatchObject({ stateReason: 'no_license', readOnly: false });
    expect(await run(at(31))).toMatchObject({ stateReason: 'no_license', readOnly: true });
    expect(mockStore.get(license.MEM_UNLICENSED_SINCE)).toBe(NOW.toISOString()); // first-seen is never moved
    write(mkLicense(V2));
    expect(await run(at(31))).toMatchObject({ accepted: true, state: 'ok' });
    expect(mockStore.has(license.MEM_UNLICENSED_SINCE)).toBe(false);
  });

  test('a database that is not there leaves the signature answer unchanged', async () => {
    const settings = require('../../lib/settings');
    const real = { get: settings.get, getOrEnv: settings.getOrEnv, set: settings.set };
    const boom = async () => { throw new Error('no db'); };
    settings.get = boom; settings.getOrEnv = boom; settings.set = boom;
    try {
      write(mkLicense(V2));
      const r = await withEnv({ ...ENV, LICENSE_FILE: licFile }, () => license.status(NOW));
      expect(r).toMatchObject({ valid: true, accepted: false, stateReason: 'domain_mismatch', readOnly: false }); // app_url unknown without settings
      write(mkLicense({ ...V2, domain: '*' }));
      expect(await withEnv({ ...ENV, LICENSE_FILE: licFile }, () => license.status(NOW))).toMatchObject({ accepted: true, state: 'ok' });
      expect(mockStore.size).toBe(0); // nothing could be remembered, and nothing broke
    } finally { Object.assign(settings, real); }
  });
});

describe('install: a renewed license from Settings', () => {
  let tmp, licFile;
  const ENV = { LICENSE_PUBLIC_KEY: PUB, LICENSE_PUBLIC_KEY_PATH: '', LICENSE_PUBLIC_KEYS_DIR: '', APP_URL: 'https://docs.acme.com' };
  const env = (fn, extra = {}) => withEnv({ ...ENV, LICENSE_FILE: licFile, ...extra }, fn);
  const write = (lic) => fs.writeFileSync(licFile, JSON.stringify(lic));
  const RENEWED = { ...V2, id: 'acme-0004', issued: '2026-12-01', expires: '2028-01-01', updates_until: '2028-01-01' };
  beforeEach(() => {
    mockStore.clear();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memex-license-'));
    licFile = path.join(tmp, 'license.json');
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  test('a higher serial for this server is kept, and from then on it is the license that counts', async () => {
    write(mkLicense(V2));
    expect(await env(() => license.status(NOW))).toMatchObject({ serial: 'acme-0003', source: 'file' });
    const r = await env(() => license.install(JSON.stringify(mkLicense(RENEWED)), 'admin-1', NOW));
    expect(r.ok).toBe(true);
    expect(r.status).toMatchObject({ accepted: true, state: 'ok', serial: 'acme-0004', expires: '2028-01-01', source: 'upload' });
    expect(JSON.parse(mockStore.get(license.MEM_UPLOADED)).payload.id).toBe('acme-0004');
    expect(await env(() => license.status(NOW))).toMatchObject({ serial: 'acme-0004', source: 'upload' });
    expect(mockStore.get(license.MEM_SERIAL)).toBe('acme-0004');
  });

  test('takes the parsed object and the base64 form an email carries', async () => {
    write(mkLicense(V2));
    expect((await env(() => license.install(mkLicense(RENEWED), null, NOW))).ok).toBe(true);
    mockStore.clear();
    const b64 = Buffer.from(JSON.stringify(mkLicense(RENEWED))).toString('base64').replace(/(.{60})/g, '$1\n');
    expect((await env(() => license.install(b64, null, NOW))).ok).toBe(true);
  });

  test.each([
    ['signed by a key this server does not trust', () => mkLicense({ ...RENEWED, kid: OTHER_KID }, OTHER.privateKey), 'unknown_kid'],
    ['a signature that does not match the payload', () => ({ ...mkLicense(RENEWED), payload: { ...RENEWED, seats: null } }), 'bad_signature'],
    ['issued for another address', () => mkLicense({ ...RENEWED, domain: 'docs.other.com' }), 'domain_mismatch'],
    ['older than the one in use', () => mkLicense({ ...V2, id: 'acme-0002' }), 'serial_regressed'],
    ['another installation\'s serial', () => mkLicense({ ...RENEWED, id: 'other-0009' }), 'serial_mismatch'],
    ['a version 1 license', () => mkLicense(GOOD), 'not_v2'],
  ])('refuses one %s, and keeps nothing', async (_name, make, reason) => {
    write(mkLicense(V2));
    await env(() => license.status(NOW)); // the server has seen acme-0003
    const r = await env(() => license.install(make(), 'admin-1', NOW));
    expect(r).toMatchObject({ ok: false, reason });
    expect(mockStore.has(license.MEM_UPLOADED)).toBe(false);
    expect(await env(() => license.status(NOW))).toMatchObject({ accepted: true, serial: 'acme-0003', source: 'file' });
  });

  test.each([['empty', ''], ['not JSON', 'hello there'], ['JSON that is not a license', '{"a":1}'], ['too long', '{' + 'x'.repeat(70 * 1024)], ['nothing', undefined]])(
    'refuses %s as not a license', async (_name, input) => {
      expect(await env(() => license.install(input, null, NOW))).toEqual({ ok: false, reason: 'not_a_license' });
    });

  test('with no trusted key nothing can be installed: the trust anchor stays in the environment', async () => {
    const r = await env(() => license.install(mkLicense(RENEWED), null, NOW), { LICENSE_PUBLIC_KEY: '' });
    expect(r).toEqual({ ok: false, reason: 'no_public_key' });
    expect(mockStore.has(license.MEM_UPLOADED)).toBe(false);
  });

  test('installs where no file was ever mounted, and ends the unlicensed clock', async () => {
    expect(await env(() => license.status(NOW))).toMatchObject({ stateReason: 'no_license', source: null });
    expect(mockStore.has(license.MEM_UNLICENSED_SINCE)).toBe(true);
    const r = await env(() => license.install(mkLicense(RENEWED), null, at(40)));
    expect(r.status).toMatchObject({ accepted: true, readOnly: false, source: 'upload' });
    expect(mockStore.has(license.MEM_UNLICENSED_SINCE)).toBe(false);
  });

  test('a renewal lifts read-only at once', async () => {
    write(mkLicense({ ...V2, expires: dateIn(-60), updates_until: dateIn(-60) }));
    expect(await env(() => license.status(NOW))).toMatchObject({ state: 'readonly', readOnly: true });
    const r = await env(() => license.install(mkLicense({ ...RENEWED, expires: dateIn(365), updates_until: dateIn(365) }), null, NOW));
    expect(r.status).toMatchObject({ state: 'ok', readOnly: false, seatFreeze: false });
  });

  test('a newer file mounted later wins over the installed copy', async () => {
    write(mkLicense(V2));
    await env(() => license.install(mkLicense(RENEWED), null, NOW));
    write(mkLicense({ ...RENEWED, id: 'acme-0005' }));
    expect(await env(() => license.status(NOW))).toMatchObject({ serial: 'acme-0005', source: 'file' });
  });

  test('an installed copy altered in the database is ignored in favour of the file', async () => {
    write(mkLicense(V2));
    await env(() => license.install(mkLicense(RENEWED), null, NOW));
    const stored = JSON.parse(mockStore.get(license.MEM_UPLOADED));
    stored.payload.seats = null; // edited by hand: the signature no longer matches
    mockStore.set(license.MEM_UPLOADED, JSON.stringify(stored));
    mockStore.set(license.MEM_SERIAL, 'acme-0003');
    expect(await env(() => license.status(NOW))).toMatchObject({ accepted: true, serial: 'acme-0003', source: 'file' });
  });

  test('installing the license already in use again is harmless', async () => {
    write(mkLicense(V2));
    expect((await env(() => license.install(mkLicense(V2), null, NOW))).status).toMatchObject({ accepted: true, serial: 'acme-0003' });
  });
});

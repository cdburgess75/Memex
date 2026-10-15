'use strict';
// scripts/sign-license.js and scripts/license-keygen.sh: what they mint verifies
// with lib/license.js, the key id they derive is the one the server derives, and
// a bad version 2 payload is refused with every problem named.
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const license = require('../../lib/license');

const ROOT = path.join(__dirname, '..', '..', '..');
const SIGN = path.join(ROOT, 'scripts', 'sign-license.js');
const KEYGEN = path.join(ROOT, 'scripts', 'license-keygen.sh');
const NOW = new Date('2026-10-15T00:00:00.000Z');

let tmp, privPath, pubPem, kid, n = 0;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memex-sign-'));
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  privPath = path.join(tmp, 'priv.pem');
  fs.writeFileSync(privPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  pubPem = publicKey.export({ type: 'spki', format: 'pem' });
  kid = license.keyId(publicKey);
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function sign(payload) {
  const p = path.join(tmp, `payload-${++n}.json`);
  fs.writeFileSync(p, JSON.stringify(payload));
  const r = spawnSync(process.execPath, [SIGN, p, privPath], { encoding: 'utf8' });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

const V2 = {
  v: 2, id: 'acme-0001', customer: 'Acme Corp', slug: 'acme', domain: 'docs.acme.com', type: 'standard', plan: 'care',
  issued: '2026-10-14', expires: '2027-10-14', updates_until: '2027-10-14', grace_days: 30, seats: 30, seat_policy: 'soft',
  storage_gb: null, features: ['updates', 'editor', 'api'],
};

test('a version 2 payload is signed, gets its kid, and is accepted by the server', () => {
  const r = sign(V2);
  expect(r.status).toBe(0);
  const lic = JSON.parse(r.out);
  expect(lic).toMatchObject({ alg: 'ed25519' });
  expect(lic.payload.kid).toBe(kid);
  const st = license.evaluate(lic, pubPem, NOW, { appHost: 'docs.acme.com' });
  expect(st).toMatchObject({ accepted: true, state: 'ok', serial: 'acme-0001', kid, seats: { licensed: 30, policy: 'soft' } });
});

test('a kid that is not the signing key is refused', () => {
  const r = sign({ ...V2, kid: 'deadbeefdeadbeef' });
  expect(r.status).toBe(1);
  expect(r.err).toMatch(/kid .* does not match the signing key/);
});

test('a bad version 2 payload is refused with every problem named', () => {
  const r = sign({ ...V2, id: 'nope', domain: '', seats: -1, expires: '2020-01-01', seat_policy: 'maybe' });
  expect(r.status).toBe(1);
  for (const msg of ['id must look like', 'domain is required', 'seats must be', 'expires is before issued', 'seat_policy must be']) expect(r.err).toContain(msg);
  expect(r.out).toBe('');
});

test('an id that does not start with the slug is refused', () => {
  const r = sign({ ...V2, id: 'beta-0001' });
  expect(r.status).toBe(1);
  expect(r.err).toContain('id must start with the slug');
});

test('an unknown version is refused', () => {
  const r = sign({ ...V2, v: 3 });
  expect(r.status).toBe(1);
  expect(r.err).toContain('payload.v must be 2');
});

test('a version 1 payload still signs, verifies, and needs only a customer', () => {
  const r = sign({ customer: 'Acme', plan: 'care', issued: '2026-01-01', updates_until: '2027-01-01', features: ['updates'] });
  expect(r.status).toBe(0);
  const lic = JSON.parse(r.out);
  expect(lic.payload.kid).toBeUndefined();
  expect(license.evaluate(lic, pubPem, NOW)).toMatchObject({ accepted: true, version: 1, updatesEntitled: true });
  expect(sign({ plan: 'care' }).err).toContain('customer is required');
});

test('license-keygen.sh writes a locked-down pair and prints the key id the server derives', () => {
  const dir = path.join(tmp, 'keygen');
  fs.mkdirSync(dir);
  const r = spawnSync('bash', [KEYGEN, dir, 'test-key'], { encoding: 'utf8' });
  expect(r.stderr).toBe('');
  expect(r.status).toBe(0);
  const pub = crypto.createPublicKey(fs.readFileSync(path.join(dir, 'test-key-public.pem'), 'utf8'));
  const printed = /key id \(kid\):\s+([0-9a-f]{16})/.exec(r.stdout);
  expect(printed && printed[1]).toBe(license.keyId(pub));
  expect(fs.statSync(path.join(dir, 'test-key-private.pem')).mode & 0o777).toBe(0o600);
  // Refuses to overwrite a key that exists.
  expect(spawnSync('bash', [KEYGEN, dir, 'test-key'], { encoding: 'utf8' }).status).toBe(1);
});

'use strict';
// The read-only gate in front of the WHOLE file router, with a REAL signed license and a
// REAL, THROWAWAY Postgres: the license is evaluated from its file, the install's memory
// lives in system_settings, and the gate refuses content changes while reads go through.
// DROPS AND RECREATES the public schema; refuses to run unless the database name contains
// "test".
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const PG = process.env.MEMEX_TEST_PG_URL;
const suite = PG ? describe : describe.skip;
if (PG) jest.setTimeout(120000);

jest.mock('jsonwebtoken');
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn(() => ({ getSigningKey: async () => ({ getPublicKey: () => 'k' }) })) }));
jest.mock('../../lib/auditLog', () => ({ append: jest.fn(async () => ({})) }));
jest.mock('../../lib/storage', () => ({
  upload: jest.fn(async () => {}), uploadStream: jest.fn(async () => {}), del: jest.fn(async () => {}), copy: jest.fn(async () => {}),
  download: jest.fn(async () => Buffer.alloc(0)), downloadStream: jest.fn(async () => ({ stream: require('stream').Readable.from([Buffer.from('bytes')]), length: 5 })),
  isLocalProvider: jest.fn(async () => false), getUrl: jest.fn(), localBase: jest.fn(), validateLocalToken: jest.fn(),
}));
jest.mock('../../lib/notifications', () => ({ create: jest.fn(async () => ({})) }));
jest.mock('../../lib/emailEvents', () => ({ send: jest.fn(async () => ({})) }));
jest.mock('../../lib/email', () => ({ sendMail: jest.fn(async () => ({ sent: false, reason: 'test' })), actingAs: (u) => ({ label: u.email, sendAs: u.email }) }));

suite('the read-only gate, the real file router, a real license and a real database', () => {
  let db, request, app, jwt, license, enforce, tmp;
  const U = (n) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
  const OWNER = { id: U(1), email: 'owner@corp.test' };
  const LIB = U(50);
  const DAY = 86_400_000;
  const dateIn = (days) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const reset = () => db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const sign = (payload) => ({ payload, alg: 'ed25519', signature: crypto.sign(null, Buffer.from(license.canonical(payload), 'utf8'), privateKey).toString('base64') });
  const install = (over) => {
    const p = { v: 2, id: `corp-${over.serial || '0001'}`, kid: license.keyId(publicKey), customer: 'Corp', slug: 'corp', domain: 'docs.corp.test', type: 'standard', plan: 'care', issued: '2026-01-01', updates_until: dateIn(300), grace_days: 30, seats: null, seat_policy: 'soft', storage_gb: null, features: ['updates', 'editor', 'api'], ...over };
    delete p.serial;
    fs.writeFileSync(path.join(tmp, 'license.json'), JSON.stringify(sign(p)));
    enforce.invalidate();
  };

  beforeAll(async () => {
    const dbName = decodeURIComponent(new URL(PG).pathname.slice(1));
    if (!/test/i.test(dbName)) throw new Error(`refusing to run: "${dbName}" does not look like a throwaway test database`);
    process.env.DATABASE_URL = PG;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'depot-license-gate-'));
    process.env.LICENSE_PUBLIC_KEY = publicKey.export({ type: 'spki', format: 'pem' });
    process.env.LICENSE_PUBLIC_KEY_PATH = '';
    process.env.LICENSE_PUBLIC_KEYS_DIR = '';
    process.env.LICENSE_FILE = path.join(tmp, 'license.json');
    process.env.APP_URL = 'https://docs.corp.test';
    delete process.env.LICENSE_ENFORCE;
    db = require('../../lib/db');
    license = require('../../lib/license');
    enforce = require('../../lib/licenseEnforce');
    await reset();
    await db.query(fs.readFileSync(path.join(__dirname, '../../../postgres/init/01_schema.sql'), 'utf8'));
    await require('../../lib/migrations').run();
    await db.query('INSERT INTO user_roles (user_id, email, role, verified_email) VALUES ($1, $2, $3, $2)', [OWNER.id, OWNER.email, 'contributor']);
    await db.query('INSERT INTO libraries (id, name, owner_id, owner_email) VALUES ($1, $2, $3, $4)', [LIB, 'Projects', OWNER.id, OWNER.email]);
    jwt = require('jsonwebtoken'); jwt.decode.mockReturnValue({ header: { kid: 'k' } });
    jwt.verify.mockReturnValue({ sub: OWNER.id, email: OWNER.email, email_verified: true });
    request = require('supertest');
    const express = require('express');
    app = express(); app.use(express.json());
    app.use(require('../../middleware/licenseGate'));             // as index.js mounts it: before every router
    app.use('/api/files', require('../../routes/files'));         // the WHOLE router
  });
  afterAll(async () => {
    try { await reset(); } catch { /* best effort */ }
    try { await db.end(); } catch { /* closed */ }
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const as = (r) => r.set('Authorization', 'Bearer t').set('x-library-id', LIB);

  test('a license in its term: a folder is made, and the server remembers the serial', async () => {
    install({ expires: dateIn(200) });
    const r = await as(request(app).post('/api/files/folder')).send({ path: 'Intake', library_id: LIB });
    expect(r.status).toBeLessThan(400);
    expect((await db.queryOne("SELECT value FROM system_settings WHERE key = 'license_serial_seen'")).value).toBe('corp-0001');
  });

  test('past the grace period the same change is refused, reads and the open mark go through', async () => {
    install({ serial: '0002', expires: dateIn(-45) });   // ended 45 days ago, 30 of grace: read-only
    expect(await enforce.readOnly()).toBe(true);
    const make = await as(request(app).post('/api/files/folder')).send({ path: 'Later', library_id: LIB });
    expect(make.status).toBe(403);
    expect(make.body).toEqual({ code: 'LICENSE_READONLY', error: expect.stringContaining('read-only') });
    expect((await as(request(app).get('/api/files'))).status).toBe(200);
    const open = await as(request(app).post(`/api/files/${U(99)}/open`)).send({});
    expect(open.body.code).not.toBe('LICENSE_READONLY');
  });

  test('a lower serial than the one remembered is not accepted, and does not make the server read-only on its own', async () => {
    install({ serial: '0001', expires: dateIn(200) });
    const st = await license.status();
    expect(st).toMatchObject({ accepted: false, stateReason: 'serial_regressed', readOnly: false });
    expect((await as(request(app).post('/api/files/folder')).send({ path: 'Again', library_id: LIB })).status).toBeLessThan(400);
  });

  test('a renewed license lifts read-only at once', async () => {
    install({ serial: '0003', expires: dateIn(-45) });
    expect(await enforce.readOnly()).toBe(true);
    install({ serial: '0004', expires: dateIn(365) });
    expect(await enforce.readOnly()).toBe(false);
    expect((await as(request(app).post('/api/files/folder')).send({ path: 'Renewed', library_id: LIB })).status).toBeLessThan(400);
  });
});

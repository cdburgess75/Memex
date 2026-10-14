'use strict';
process.env.LINK_UPLOAD_TMP = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'depot-fsearch-pg-'));
// Folders found by name across the libraries a person can read, and the upload type rule
// (nothing refused unless an administrator lists types; "none" means nothing too), through
// the real routers against a REAL, THROWAWAY Postgres. DROPS AND RECREATES the public schema;
// refuses to run unless the database name contains "test".
const fs = require('fs');
const path = require('path');

const PG = process.env.MEMEX_TEST_PG_URL;
const suite = PG ? describe : describe.skip;
if (PG) jest.setTimeout(120000);

jest.mock('jsonwebtoken');
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn(() => ({ getSigningKey: async () => ({ getPublicKey: () => 'k' }) })) }));
const mockBlobs = new Map();
jest.mock('../../lib/storage', () => ({
  upload: jest.fn(async (p, buf) => { mockBlobs.set(p, Buffer.from(buf)); }),
  uploadStream: jest.fn(async (p, readable) => { const b = []; for await (const c of readable) b.push(c); const buf = Buffer.concat(b); mockBlobs.set(p, buf); return { size: buf.length }; }),
  download: jest.fn(async (p) => mockBlobs.get(p) || Buffer.alloc(0)),
  downloadStream: jest.fn(async (p) => { const buf = mockBlobs.get(p) || Buffer.alloc(0); return { stream: require('stream').Readable.from([buf]), length: buf.length, totalSize: buf.length }; }),
  del: jest.fn(async (p) => { mockBlobs.delete(p); }), copy: jest.fn(async (a, b) => { mockBlobs.set(b, mockBlobs.get(a)); }),
  isLocalProvider: jest.fn(async () => true), getUrl: jest.fn(async () => 'http://x/url'), localBase: jest.fn(async () => require('os').tmpdir()), validateLocalToken: jest.fn(),
}));
jest.mock('../../lib/notifications', () => ({ create: jest.fn(async () => ({})) }));
jest.mock('../../lib/emailEvents', () => ({ send: jest.fn(async () => ({})) }));
jest.mock('../../lib/textExtraction', () => ({ extractText: jest.fn(async (buf) => buf.toString('utf8').replace(/[\0�]/g, '').slice(0, 1000)) }));

const U = (n) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
const DAVE = { id: U(1), email: 'dave@corp.test' }, OTHER = { id: U(4), email: 'other@corp.test' };
const LIB = U(50), LIB2 = U(51);

suite('folders by name, and the upload type rule', () => {
  let db, request, app, jwt, settings, readToken;
  const reset = () => db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const as = (a) => { jwt.verify.mockReturnValue({ sub: a.id, email: a.email, email_verified: true }); return 'Bearer session'; };
  const upload = (who, lib, name, body = 'x') => request(app).post('/api/files/upload-stream?displayName=' + encodeURIComponent(name)).set('Authorization', as(who)).set('x-library-id', lib).set('x-file-name', name).set('Content-Type', 'text/plain').send(body);
  const find = (who, q) => request(app).get('/api/files/search-folders?q=' + encodeURIComponent(q)).set('Authorization', as(who));

  beforeAll(async () => {
    const dbName = decodeURIComponent(new URL(PG).pathname.slice(1));
    if (!/test/i.test(dbName)) throw new Error(`refusing to run: "${dbName}" does not look like a throwaway test database`);
    process.env.DATABASE_URL = PG;
    db = require('../../lib/db');
    await reset();
    await db.query(fs.readFileSync(path.join(__dirname, '../../../postgres/init/01_schema.sql'), 'utf8'));
    await require('../../lib/migrations').run();
    for (const a of [DAVE, OTHER]) await db.query('INSERT INTO user_roles (user_id, email, role, verified_email) VALUES ($1, $2, $3, $2)', [a.id, a.email, 'contributor']);
    await db.query('INSERT INTO libraries (id, name, owner_id, owner_email) VALUES ($1, $2, $3, $4), ($5, $6, $7, $8)', [LIB, 'Projects', DAVE.id, DAVE.email, LIB2, 'Private', OTHER.id, OTHER.email]);
    jwt = require('jsonwebtoken'); jwt.decode.mockReturnValue({ header: { kid: 'k' } });
    settings = require('../../lib/settings');
    request = require('supertest');
    const express = require('express');
    app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use('/api/files', require('../../routes/files'));
    app.use('/api/tokens', require('../../routes/tokens'));
    app.use('/api/v1', require('../../routes/v1'));
    for (const name of ['Clients/Empire Roofing/Onboarding/plan.txt', 'Clients/Empire Roofing/Onboarding/plan2.txt', 'Clients/Empire Austin/notes.txt', 'Reports/q1.txt']) await upload(DAVE, LIB, name).expect(200);
    await upload(OTHER, LIB2, 'Clients/Secret Empire/x.txt').expect(200);
    readToken = (await request(app).post('/api/tokens').set('Authorization', as(DAVE)).send({ name: 'Reports', scope: 'read' })).body.token;
  });
  afterAll(async () => { try { await reset(); } catch { /* best effort */ } try { await db.end(); } catch { /* closed */ } });

  test('folders are found by their own name, across every library the caller can read, and nowhere else', async () => {
    const r = await find(DAVE, 'empire').expect(200);
    expect(r.body).toEqual([
      { library_id: LIB, library_name: 'Projects', path: 'Clients/Empire Austin', name: 'Empire Austin', folder: 'Clients', count: 1 },
      { library_id: LIB, library_name: 'Projects', path: 'Clients/Empire Roofing', name: 'Empire Roofing', folder: 'Clients', count: 2 },
    ]);
    // the folder itself, not its contents: "Clients" matches once, with everything under it counted
    expect((await find(DAVE, 'CLIENTS').expect(200)).body).toEqual([{ library_id: LIB, library_name: 'Projects', path: 'Clients', name: 'Clients', folder: '', count: 3 }]);
    expect((await find(DAVE, 'onboarding').expect(200)).body.map(f => f.path)).toEqual(['Clients/Empire Roofing/Onboarding']);
    // other people's private libraries stay invisible; a file name is not a folder
    expect((await find(DAVE, 'secret').expect(200)).body).toEqual([]);
    expect((await find(OTHER, 'secret').expect(200)).body.map(f => f.path)).toEqual(['Clients/Secret Empire']);
    expect((await find(DAVE, 'plan').expect(200)).body).toEqual([]);
    expect((await find(DAVE, '').expect(200)).body).toEqual([]);
    expect((await find(DAVE, '%').expect(200)).body).toEqual([]); // a wildcard is just a character
  });

  test('the public API\'s search lists the same folders beside the files', async () => {
    const r = await request(app).get('/api/v1/search?q=empire').set('Authorization', `Bearer ${readToken}`).expect(200);
    expect(r.body.folders.map(f => f.name)).toEqual(['Empire Austin', 'Empire Roofing']);
    expect(Array.isArray(r.body.files)).toBe(true);
  });

  test('nothing is refused unless an administrator lists types; "none" means nothing too; a refusal says the type and where to allow it', async () => {
    expect((await upload(DAVE, LIB, 'Tools/connect.exe', 'MZ')).status).toBe(200);
    await settings.set('blocked_file_exts', '.exe, msi', DAVE.id);
    const refused = await upload(DAVE, LIB, 'Tools/again.exe', 'MZ');
    expect(refused.status).toBe(415);
    expect(refused.body).toEqual({ code: 'FILE_TYPE_BLOCKED', error: 'Depot does not accept .exe files here. An administrator can allow it under Settings, Network, limits and calls (blocked upload types).' });
    const start = await request(app).post('/api/files/uploads').set('Authorization', as(DAVE)).set('x-library-id', LIB).send({ displayName: 'Tools/setup.msi', size: 10, mimeType: 'application/octet-stream', libraryId: LIB });
    expect(start.status).toBe(415); expect(start.body.code).toBe('FILE_TYPE_BLOCKED');
    expect((await upload(DAVE, LIB, 'Tools/readme.txt')).status).toBe(200);
    await settings.set('blocked_file_exts', 'none', DAVE.id);
    expect((await upload(DAVE, LIB, 'Tools/third.exe', 'MZ')).status).toBe(200);
    await settings.set('blocked_file_exts', '', DAVE.id);
    expect((await upload(DAVE, LIB, 'Tools/fourth.exe', 'MZ')).status).toBe(200);
  });
});

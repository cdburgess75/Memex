'use strict';
process.env.LINK_UPLOAD_TMP = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'depot-fresh-pg-'));
// A brand-new install, and an old one upgrading -- through the real sign-in middleware
// and the WHOLE file, library and admin routers, against a REAL, THROWAWAY Postgres.
//
// Depot used to seed a library on every install that had none: ownerless, named for the
// company it was first built for. A new customer's first screen carried another company's
// name, and anything uploaded without naming a library landed in that place nobody owned.
// Now nothing is seeded: the install has no library until its first admin signs in and
// gets their own, and a request that names no library goes to the person's own library or
// is refused -- never to "the oldest library", which no longer means anything.
//
// DROPS AND RECREATES the public schema; refuses to run unless the database name contains
// "test".
const fs = require('fs');
const path = require('path');

const PG = process.env.MEMEX_TEST_PG_URL;
const suite = PG ? describe : describe.skip;
if (PG) jest.setTimeout(120000);

jest.mock('jsonwebtoken');
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn(() => ({ getSigningKey: async () => ({ getPublicKey: () => 'k' }) })) }));
jest.mock('../../lib/auditLog', () => ({ append: jest.fn(async () => ({})) }));
const mockBlobs = new Map();
const mockLocalBase = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'depot-fresh-local-'));
jest.mock('../../lib/storage', () => ({
  upload: jest.fn(async (p, buf) => { mockBlobs.set(p, Buffer.from(buf)); }),
  uploadStream: jest.fn(async (p, readable) => { const b = []; for await (const c of readable) b.push(c); const buf = Buffer.concat(b); mockBlobs.set(p, buf); return { size: buf.length }; }),
  download: jest.fn(async (p) => { if (!mockBlobs.has(p)) throw new Error('no such blob ' + p); return mockBlobs.get(p); }),
  del: jest.fn(async (p) => { mockBlobs.delete(p); }), copy: jest.fn(async (from, to) => { mockBlobs.set(to, mockBlobs.get(from)); }),
  isLocalProvider: jest.fn(async () => true), getUrl: jest.fn(), localBase: jest.fn(async () => mockLocalBase), validateLocalToken: jest.fn(),
}));
jest.mock('../../lib/notifications', () => ({ create: jest.fn(async () => ({})) }));
jest.mock('../../lib/emailEvents', () => ({ send: jest.fn(async () => ({})) }));
jest.mock('../../lib/textExtraction', () => ({ extractText: jest.fn(async () => null) }));

const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ROBIN = { id: U(1), email: 'robin@newcustomer.test', name: 'Robin Owner' }; // the first admin
const PAT = { id: U(2), email: 'pat@newcustomer.test' };                         // a contributor
const VAL = { id: U(3), email: 'val@newcustomer.test' };                         // a viewer
const SEED = U(90);                                                               // an old install's seeded library

suite('a brand-new install: nothing is seeded, and nothing lands where nobody chose', () => {
  let db, libraries, request, app, jwt;
  const reset = () => db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const schema = () => db.query(fs.readFileSync(path.join(__dirname, '../../../postgres/init/01_schema.sql'), 'utf8'));
  const migrate = () => require('../../lib/migrations').run();
  const libraryCount = async () => (await db.queryOne('SELECT count(*)::int AS n FROM libraries')).n;
  const documentCount = async () => (await db.queryOne('SELECT count(*)::int AS n FROM documents')).n;
  const ownLibrary = async (p) => (await db.queryOne('SELECT id FROM libraries WHERE owner_id = $1 AND personal', [p.id]))?.id || null;

  beforeAll(async () => {
    const dbName = decodeURIComponent(new URL(PG).pathname.slice(1));
    if (!/test/i.test(dbName)) throw new Error(`refusing to run: "${dbName}" does not look like a throwaway test database`);
    process.env.DATABASE_URL = PG;
    process.env.ADMIN_EMAILS = ROBIN.email; // as install.sh writes it: the customer's admin, by address
    db = require('../../lib/db');
    libraries = require('../../lib/libraries');
    await reset();
    await schema();
    await migrate();
    jwt = require('jsonwebtoken'); jwt.decode.mockReturnValue({ header: { kid: 'k' } });
    request = require('supertest');
    const express = require('express');
    app = express(); app.use(express.json());
    app.use('/api/auth', require('../../routes/auth'));
    app.use('/api/admin', require('../../routes/admin'));
    app.use('/api/files', require('../../routes/files'));       // the WHOLE router, as the server mounts it
    app.use('/api/libraries', require('../../routes/libraries'));
  });
  afterAll(async () => {
    delete process.env.ADMIN_EMAILS;
    try { await reset(); } catch { /* best effort */ }
    try { await db.end(); } catch { /* closed */ }
  });

  // Signing in is real apart from the signature: the token says whatever the test says.
  const as = (p) => {
    jwt.verify.mockReturnValue({ sub: p.id, email: p.email, email_verified: true, ...(p.name ? { name: p.name } : {}) });
    return (r) => r.set('Authorization', 'Bearer t');
  };
  const upload = (p, name, headers = {}) => { let r = as(p)(request(app).post('/api/files/upload')); for (const [k, v] of Object.entries(headers)) r = r.set(k, v); return r.attach('file', Buffer.from('bytes of ' + name), name); };

  test('after the schema and every migration there is no library at all, and no trace of the old seed', async () => {
    expect(await libraryCount()).toBe(0);
    expect(await db.query('SELECT name FROM libraries')).toEqual([]);
    // the migrations are idempotent on this too: running them again makes nothing
    await migrate();
    expect(await libraryCount()).toBe(0);
    // and there is nothing to fall back to, for nobody
    expect(await libraries.defaultLibraryFor(null)).toBeNull();
    expect(await libraries.defaultLibraryFor({ id: U(77), role: 'admin', email: 'nobody@newcustomer.test' })).toBeNull();
  });

  test('the first admin signs in: made an admin, and given a library of their own, named after them -- the install\'s only one', async () => {
    const me = await as(ROBIN)(request(app).get('/api/auth/me'));
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ id: ROBIN.id, email: ROBIN.email, role: 'admin' });
    const listed = await as(ROBIN)(request(app).get('/api/libraries'));
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual([expect.objectContaining({ name: 'Robin Owner', personal: true, owner_id: ROBIN.id, owner_email: ROBIN.email, my_access: 'owner', add_right: 'admin', archived_at: null })]); // an admin adds anywhere, so their right is 'admin' even in their own
    expect(await libraryCount()).toBe(1);
    expect(await libraries.defaultLibraryFor({ id: ROBIN.id, role: 'admin', email: ROBIN.email })).toBe(await ownLibrary(ROBIN));
  });

  test('an upload, a new folder and a new document that name no library land in their own', async () => {
    const mine = await ownLibrary(ROBIN);
    const up = await upload(ROBIN, 'hello.txt');
    expect(up.status).toBe(200);
    expect(up.body.doc).toMatchObject({ name: 'hello.txt', library_id: mine, uploaded_by: ROBIN.id });
    const folder = await as(ROBIN)(request(app).post('/api/files/folder')).send({ path: 'Invoices' });
    expect(folder.status).toBe(200);
    const made = await as(ROBIN)(request(app).post('/api/files/create')).send({ name: 'Notes', type: 'txt', folder: 'Invoices' });
    expect(made.status).toBe(200);
    expect(made.body).toMatchObject({ name: 'Invoices/Notes.txt', library_id: mine });
    const streamed = await as(ROBIN)(request(app).post('/api/files/upload-stream').query({ displayName: 'Invoices/scan.bin' })).set('Content-Type', 'application/octet-stream').send(Buffer.from('scan'));
    expect(streamed.status).toBe(200);
    expect(streamed.body.doc).toMatchObject({ name: 'Invoices/scan.bin', library_id: mine });
    // every document in the install is in that one library; none is in no library
    expect(await db.query('SELECT DISTINCT library_id FROM documents')).toEqual([{ library_id: mine }]);
    // and the library lists them back
    const list = await as(ROBIN)(request(app).get('/api/files')).query({ library: mine, folder: 'Invoices' });
    expect(list.status).toBe(200);
    expect(list.body.map(d => d.name).sort()).toEqual(['Invoices/Notes.txt', 'Invoices/scan.bin']);
  });

  test('the next person gets a library of their own too; nothing of theirs touches the admin\'s', async () => {
    const listed = await as(PAT)(request(app).get('/api/libraries'));
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual([expect.objectContaining({ name: 'pat', personal: true, owner_id: PAT.id, my_access: 'owner' })]);
    const pats = await ownLibrary(PAT);
    const up = await upload(PAT, 'mine.txt');
    expect(up.status).toBe(200);
    expect(up.body.doc.library_id).toBe(pats);
    expect(await libraryCount()).toBe(2);
    expect((await db.query('SELECT library_id FROM documents WHERE uploaded_by = $1', [PAT.id])).every(d => d.library_id === pats)).toBe(true);
  });

  test('a viewer is given nothing, and cannot add files anywhere, so the question of where never comes up', async () => {
    await db.query('INSERT INTO user_roles (user_id, email, role, verified_email) VALUES ($1, $2, $3, $2)', [VAL.id, VAL.email, 'viewer']);
    expect((await as(VAL)(request(app).get('/api/libraries'))).body).toEqual([]);
    expect(await ownLibrary(VAL)).toBeNull();
    expect((await upload(VAL, 'no.txt')).status).toBe(403);
    expect(await libraryCount()).toBe(2);
  });

  test('with their own library put away, a request that names no library is refused in plain words -- it lands nowhere and makes nothing', async () => {
    const pats = await ownLibrary(PAT);
    expect((await as(ROBIN)(request(app).put(`/api/libraries/${pats}/archived`)).send({ archived: true })).status).toBe(200);
    const docsBefore = await documentCount();
    const refusals = [
      ['upload', () => upload(PAT, 'x.txt')],
      ['streamed upload', () => as(PAT)(request(app).post('/api/files/upload-stream').query({ displayName: 'y.txt' })).set('Content-Type', 'application/octet-stream').send(Buffer.from('y'))],
      ['resumable upload', () => as(PAT)(request(app).post('/api/files/uploads')).send({ displayName: 'z.bin', size: 10, mimeType: 'application/octet-stream', chunkSize: 10 })],
      ['new folder', () => as(PAT)(request(app).post('/api/files/folder')).send({ path: 'Nowhere' })],
      ['new document', () => as(PAT)(request(app).post('/api/files/create')).send({ name: 'Nowhere', type: 'txt' })],
      ['folder move', () => as(PAT)(request(app).post('/api/files/folder/move')).send({ path: 'Nowhere' })],
      ['folder copy', () => as(PAT)(request(app).post('/api/files/folder/copy')).send({ path: 'Nowhere' })],
    ];
    for (const [what, go] of refusals) {
      const res = await go();
      expect([what, res.status, res.body]).toEqual([what, 400, { error: libraries.NO_OWN_LIBRARY }]);
    }
    expect(libraries.NO_OWN_LIBRARY).toMatch(/Choose a library/);
    expect(await documentCount()).toBe(docsBefore);
    expect(await libraryCount()).toBe(2);
    expect((await db.queryOne('SELECT count(*)::int AS n FROM upload_sessions')).n).toBe(0);
    // naming the put-away library is refused as what it is
    const named = await upload(PAT, 'x.txt', { 'x-library-id': pats });
    expect(named.status).toBe(403);
    expect(named.body.error).toMatch(/archived/);
    // brought back, it is theirs again
    expect((await as(ROBIN)(request(app).put(`/api/libraries/${pats}/archived`)).send({ archived: false })).status).toBe(200);
    const again = await upload(PAT, 'x.txt');
    expect(again.status).toBe(200);
    expect(again.body.doc.library_id).toBe(pats);
  });

  test('a document placed with nobody\'s library to land in is refused as a placement failure (the caller drops the bytes)', async () => {
    const { createDocumentRecord } = require('../../lib/documents');
    const storage = require('../../lib/storage');
    mockBlobs.set('documents/orphan', Buffer.from('orphan'));
    const nobody = { id: U(78), email: 'nobody@newcustomer.test', role: 'contributor' }; // signed in nowhere: no library of their own
    await expect(createDocumentRecord({ displayName: 'orphan.txt', storagePath: 'documents/orphan', mimetype: 'text/plain', storedSize: 6, user: nobody, sourceDetail: 'test' })
      .catch(async (e) => { if (e.notPlaced) await storage.del('documents/orphan'); throw e; }))
      .rejects.toMatchObject({ status: 400, message: libraries.NO_OWN_LIBRARY, notPlaced: true });
    expect(mockBlobs.has('documents/orphan')).toBe(false);
    expect(await db.queryOne("SELECT 1 FROM documents WHERE name = 'orphan.txt'")).toBeNull();
  });

  describe('an older install upgrading', () => {
    // The shape of a box from before migrations existed: the per-boot helper had made the
    // install's one library (ownerless), and files from before libraries had no library.
    test('files from before libraries join the library the box already had; no second one appears', async () => {
      await reset();
      await schema();
      await db.query('INSERT INTO libraries (id, name) VALUES ($1, $2)', [SEED, 'Company Workspace']);
      await db.query('INSERT INTO user_roles (user_id, email, role) VALUES ($1, $2, $3), ($4, $5, $6)', [ROBIN.id, ROBIN.email, 'admin', PAT.id, PAT.email, 'contributor']);
      await db.query(
        `INSERT INTO documents (name, size, mime_type, storage_path, uploaded_by, uploaded_by_email, library_id)
         VALUES ('Old/a.pdf', 1, 'application/pdf', 'old/a', $1, $2, NULL), ('Old/b.pdf', 1, 'application/pdf', 'old/b', $1, $2, NULL), ('Kept/c.pdf', 1, 'application/pdf', 'old/c', $1, $2, $3)`,
        [ROBIN.id, ROBIN.email, SEED]);
      await migrate();
      expect(await db.query('SELECT name, library_id FROM documents ORDER BY name')).toEqual([
        { name: 'Kept/c.pdf', library_id: SEED }, { name: 'Old/a.pdf', library_id: SEED }, { name: 'Old/b.pdf', library_id: SEED },
      ]);
      // the box's own library is kept as it was (ownerless, its name untouched), the people
      // who had signed in get theirs (0011), and nothing else is made
      expect(await db.query('SELECT name, owner_id, personal FROM libraries ORDER BY personal, name')).toEqual([
        { name: 'Company Workspace', owner_id: null, personal: false },
        { name: 'pat', owner_id: PAT.id, personal: true }, { name: 'robin', owner_id: ROBIN.id, personal: true },
      ]);
    });

    test('run again, the migrations change nothing on that box', async () => {
      const before = [await db.query('SELECT id, name, owner_id, archived_at FROM libraries ORDER BY id'), await db.query('SELECT id, name, library_id FROM documents ORDER BY id')];
      await migrate();
      expect([await db.query('SELECT id, name, owner_id, archived_at FROM libraries ORDER BY id'), await db.query('SELECT id, name, library_id FROM documents ORDER BY id')]).toEqual(before);
    });

    test('a file from before libraries on a box that never had one stays where it is, and is not given a library nobody made', async () => {
      await reset();
      await schema();
      await db.query(
        `INSERT INTO documents (name, size, mime_type, storage_path, uploaded_by, uploaded_by_email, library_id)
         VALUES ('Old/alone.pdf', 1, 'application/pdf', 'old/alone', $1, $2, NULL)`, [ROBIN.id, ROBIN.email]);
      await migrate();
      expect(await db.query('SELECT name, library_id FROM documents')).toEqual([{ name: 'Old/alone.pdf', library_id: null }]);
      expect(await libraryCount()).toBe(0);
    });
  });
});

'use strict';
// The getting-started guide lands in each personal library exactly once -- against a
// REAL, THROWAWAY Postgres, and through the real sign-in middleware for the first-sign-in
// path.
//
//   MEMEX_TEST_PG_URL=postgres://user:pass@localhost:5432/memex_test \
//     npx jest --runInBand integration/gettingStarted.pg
const fs = require('fs');
const path = require('path');

const PG = process.env.MEMEX_TEST_PG_URL;
const suite = PG ? describe : describe.skip;
if (PG) jest.setTimeout(180000);

jest.mock('jsonwebtoken');
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn(() => ({ getSigningKey: async () => ({ getPublicKey: () => 'k' }) })) }));
jest.mock('../../lib/auditLog', () => ({ append: jest.fn(async () => ({})) }));
// Blobs live in memory, so the hashing and dedupe in createDocumentRecord see real bytes.
jest.mock('../../lib/storage', () => {
  const blobs = new Map();
  return {
    blobs,
    upload: jest.fn(async (p, buf) => { blobs.set(p, Buffer.from(buf)); }),
    download: jest.fn(async (p) => { if (!blobs.has(p)) throw new Error('no blob ' + p); return blobs.get(p); }),
    del: jest.fn(async (p) => { blobs.delete(p); }),
    copy: jest.fn(async () => {}),
  };
});
// Reading text out of a 4 MB PDF per test adds nothing here; what is stored is the point.
jest.mock('../../lib/textExtraction', () => ({ extractText: jest.fn(async () => 'getting started with depot') }));

const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ANA = { id: U(2), email: 'ana@acme.test', role: 'contributor' };
const BEN = { id: U(3), email: 'ben@acme.test', role: 'contributor' };
const CAL = { id: U(4), email: 'cal@acme.test', role: 'contributor' };   // switched off
const DEE = { id: U(5), email: 'dee@acme.test', role: 'admin' };         // library put away
const NEW = { id: U(6), email: 'new.person@acme.test', role: 'contributor' };
const PDF = 'Getting started with Depot.pdf';
const DOCX = 'Getting started with Depot.docx';

suite('the getting-started guide in every personal library', () => {
  let db, libraries, guide, settings, storage, auditLog, jwt, request, app;
  const reset = () => db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const migrate = async () => {
    await db.query(fs.readFileSync(path.join(__dirname, '../../../postgres/init/01_schema.sql'), 'utf8'));
    await require('../../lib/migrations').run();
  };
  const person = (p) => db.query('INSERT INTO user_roles (user_id, email, role) VALUES ($1, $2, $3)', [p.id, p.email, p.role]);
  const libraryOf = (p) => db.queryOne('SELECT id, getting_started_at, getting_started_claimed_at FROM libraries WHERE owner_id = $1 AND personal', [p.id]);
  const guideDocs = (libId) => db.query(
    `SELECT id, name, library_scoped, uploaded_by, deleted_at, storage_path, document_text FROM documents WHERE library_id = $1 AND name LIKE '%Getting started with Depot%' ORDER BY name`, [libId]);

  beforeAll(async () => {
    const dbName = decodeURIComponent(new URL(PG).pathname.slice(1));
    if (!/test/i.test(dbName)) throw new Error(`refusing to run: "${dbName}" does not look like a throwaway test database`);
    process.env.DATABASE_URL = PG;
    db = require('../../lib/db');
    libraries = require('../../lib/libraries');
    guide = require('../../lib/gettingStarted');
    settings = require('../../lib/settings');
    storage = require('../../lib/storage');
    auditLog = require('../../lib/auditLog');
    jwt = require('jsonwebtoken');
    jwt.decode.mockReturnValue({ header: { kid: 'k' } });
    request = require('supertest');
    const express = require('express');
    app = express();
    app.use(express.json());
    app.use('/api/files', require('../../routes/files'));
    app.use('/api/admin/settings', require('../../routes/settings'));
  });

  beforeEach(async () => {
    await reset();
    await migrate();
    settings._reset();
    guide._resetForTests();
    storage.blobs.clear();
    jest.clearAllMocks();
  });

  afterAll(async () => {
    try { await reset(); } catch { /* best effort */ }
    try { await db.end(); } catch { /* already closed */ }
  });

  test('the build carries both files', () => {
    for (const f of guide.FILES) expect(fs.existsSync(path.join(guide.ASSET_DIR, f.name))).toBe(true);
  });

  test('a new library gets both files at its root, owned by its person, as library content', async () => {
    await person(ANA);
    const lib = await libraries.ensurePersonalLibrary(ANA, 'Ana');
    expect(await guide.seedLibrary(lib.id, ANA)).toBe(true);

    const docs = await guideDocs(lib.id);
    expect(docs.map(d => d.name)).toEqual([DOCX, PDF]);
    for (const d of docs) {
      expect(d.name).not.toContain('/');               // the root, not a folder
      expect(d.library_scoped).toBe(true);
      expect(d.uploaded_by).toBe(ANA.id);
      const acl = await db.queryOne('SELECT 1 FROM document_acl WHERE document_id = $1', [d.id]);
      expect(acl).toBeTruthy();                        // the owner can manage it like any upload
    }
    expect(storage.blobs.size).toBe(2);
    const lib2 = await libraryOf(ANA);
    expect(lib2.getting_started_at).not.toBeNull();
    expect(lib2.getting_started_claimed_at).toBeNull();
    // not indexed, and nothing downloaded or parsed per copy
    for (const d of docs) expect(d.document_text).toBeNull();
    expect(require('../../lib/textExtraction').extractText).not.toHaveBeenCalled();
    expect(storage.download).not.toHaveBeenCalled();
  });

  test('it is not an upload: no "uploaded" event, nothing in the activity log', async () => {
    await person(ANA);
    const lib = await libraries.ensurePersonalLibrary(ANA, 'Ana');
    await guide.seedLibrary(lib.id, ANA);
    const kinds = auditLog.append.mock.calls.map(([e]) => e.eventType);
    expect(kinds.filter(k => k === 'guide_added')).toHaveLength(2);
    expect(kinds).not.toContain('uploaded');
    const activity = await db.query('SELECT event FROM activity_log');
    expect(activity).toHaveLength(0);
  });

  test('once only: a second call adds nothing, and a deleted copy never comes back', async () => {
    await person(ANA);
    const lib = await libraries.ensurePersonalLibrary(ANA, 'Ana');
    await guide.seedLibrary(lib.id, ANA);
    expect(await guide.seedLibrary(lib.id, ANA)).toBe(false);
    await db.query(`UPDATE documents SET deleted_at = NOW() WHERE library_id = $1 AND name = $2`, [lib.id, PDF]);
    const r = await guide.backfill();
    expect(r.added).toBe(0);
    const live = (await guideDocs(lib.id)).filter(d => !d.deleted_at).map(d => d.name);
    expect(live).toEqual([DOCX]);
  });

  test('the startup pass covers people who were here before, once, and leaves the switched-off and the put-away alone', async () => {
    for (const p of [ANA, BEN, CAL, DEE]) await person(p);
    for (const p of [ANA, BEN, CAL, DEE]) await libraries.ensurePersonalLibrary(p, null);
    await db.query('UPDATE user_roles SET disabled_at = NOW() WHERE user_id = $1', [CAL.id]);
    await db.query('UPDATE libraries SET archived_at = NOW() WHERE owner_id = $1', [DEE.id]);

    const first = await guide.backfill();
    expect(first.added).toBe(2);
    for (const p of [ANA, BEN]) expect((await guideDocs((await libraryOf(p)).id))).toHaveLength(2);
    for (const p of [CAL, DEE]) {
      const lib = await libraryOf(p);
      expect(await guideDocs(lib.id)).toHaveLength(0);
      expect(lib.getting_started_at).toBeNull();       // still owed, should they come back
    }
    const again = await guide.backfill();
    expect(again.added).toBe(0);
    expect((await db.queryOne(`SELECT count(*)::int n FROM documents WHERE name LIKE 'Getting started%'`)).n).toBe(4);    // each copy has its own blob, so deleting one can never take another library's copy
    const paths = (await db.query(`SELECT storage_path FROM documents WHERE name LIKE 'Getting started%'`)).map(r => r.storage_path);
    expect(new Set(paths).size).toBe(4);
    expect(storage.blobs.size).toBe(4);
  });

  test('only personal libraries: a library someone owns and shares is never given the guide', async () => {
    await person(ANA);
    const shared = await db.queryOne(
      `INSERT INTO libraries (name, created_by, created_by_email, owner_id, owner_email, personal)
       VALUES ('Projects', $1, $2, $1, $2, false) RETURNING id`, [ANA.id, ANA.email]);
    expect(await guide.seedLibrary(shared.id, ANA)).toBe(false);
    await guide.backfill();
    expect(await guideDocs(shared.id)).toHaveLength(0);
  });

  test('someone else cannot have the guide put into your library on their behalf', async () => {
    await person(ANA); await person(BEN);
    const lib = await libraries.ensurePersonalLibrary(ANA, 'Ana');
    expect(await guide.seedLibrary(lib.id, BEN)).toBe(false);
    expect(await guideDocs(lib.id)).toHaveLength(0);
  });

  test('a switched-off owner who is switched back on gets their copy at the next pass', async () => {
    await person(CAL);
    await libraries.ensurePersonalLibrary(CAL, null);
    await db.query('UPDATE user_roles SET disabled_at = NOW() WHERE user_id = $1', [CAL.id]);
    await guide.backfill();
    await db.query('UPDATE user_roles SET disabled_at = NULL WHERE user_id = $1', [CAL.id]);
    expect((await guide.backfill()).added).toBe(1);
    expect(await guideDocs((await libraryOf(CAL)).id)).toHaveLength(2);
  });

  test('switched off by an admin in Settings: nothing is added and nothing is marked', async () => {
    await person(ANA);
    await db.query('INSERT INTO user_roles (user_id, email, role, verified_email) VALUES ($1, $2, $3, $2)', [DEE.id, DEE.email, 'admin']);
    const lib = await libraries.ensurePersonalLibrary(ANA, 'Ana');
    jwt.verify.mockReturnValue({ sub: DEE.id, email: DEE.email, email_verified: true });
    await request(app).put('/api/admin/settings').set('Authorization', 'Bearer t').send({ getting_started_guide: 'false' }).expect(200);
    const got = await request(app).get('/api/admin/settings').set('Authorization', 'Bearer t').expect(200);
    expect(got.body.getting_started_guide).toBe('false');
    settings._reset();
    expect(await guide.seedLibrary(lib.id, ANA)).toBe(false);
    expect((await guide.backfill()).disabled).toBe(true);
    expect(await guideDocs(lib.id)).toHaveLength(0);
    expect((await libraryOf(ANA)).getting_started_at).toBeNull();
  });

  test('a failure gives the claim back, and the retry adds only what is missing', async () => {
    await person(ANA);
    const lib = await libraries.ensurePersonalLibrary(ANA, 'Ana');
    storage.upload.mockImplementationOnce(async (p, buf) => { storage.blobs.set(p, Buffer.from(buf)); })   // the PDF lands
      .mockImplementationOnce(async () => { throw new Error('disk full'); });                             // the Word file does not
    await expect(guide.seedLibrary(lib.id, ANA)).rejects.toThrow('disk full');
    const after = await libraryOf(ANA);
    expect(after.getting_started_at).toBeNull();
    expect(after.getting_started_claimed_at).toBeNull();
    expect((await guideDocs(lib.id)).map(d => d.name)).toEqual([PDF]);
    expect((await guide.backfill()).added).toBe(1);
    expect((await guideDocs(lib.id)).map(d => d.name)).toEqual([DOCX, PDF]);
  });

  test('a retry never brings back a copy the person deleted or moved in between', async () => {
    await person(ANA); await person(BEN);
    for (const p of [ANA, BEN]) await libraries.ensurePersonalLibrary(p, null);
    const a = (await libraryOf(ANA)).id, b = (await libraryOf(BEN)).id;
    for (let i = 0; i < 2; i++) {
      storage.upload.mockImplementationOnce(async (p, buf) => { storage.blobs.set(p, Buffer.from(buf)); })
        .mockImplementationOnce(async () => { throw new Error('disk full'); });
    }
    await expect(guide.seedLibrary(a, ANA)).rejects.toThrow();
    await expect(guide.seedLibrary(b, BEN)).rejects.toThrow();
    await db.query(`UPDATE documents SET deleted_at = NOW() WHERE library_id = $1 AND name = $2`, [a, PDF]);       // Ana bins it
    await db.query(`UPDATE documents SET name = 'Help/' || name WHERE library_id = $1 AND name = $2`, [b, PDF]);   // Ben files it away
    expect((await guide.backfill()).added).toBe(2);
    expect((await guideDocs(a)).filter(d => !d.deleted_at).map(d => d.name)).toEqual([DOCX]);
    expect((await guideDocs(b)).map(d => d.name).sort()).toEqual([DOCX, 'Help/' + PDF].sort());
  });

  test('a claim abandoned by a process that died is taken again later; a fresh one is left alone', async () => {
    await person(ANA); await person(BEN);
    for (const p of [ANA, BEN]) await libraries.ensurePersonalLibrary(p, null);
    await db.query(`UPDATE libraries SET getting_started_claimed_at = NOW() - interval '20 minutes' WHERE owner_id = $1`, [ANA.id]);
    await db.query(`UPDATE libraries SET getting_started_claimed_at = NOW() - interval '1 minute' WHERE owner_id = $1`, [BEN.id]);
    expect((await guide.backfill()).added).toBe(1);
    expect(await guideDocs((await libraryOf(ANA)).id)).toHaveLength(2);
    expect(await guideDocs((await libraryOf(BEN)).id)).toHaveLength(0);
  });

  test('a library put away while the guide was being added gets nothing, and its blob is not left behind', async () => {
    await person(ANA);
    const lib = await libraries.ensurePersonalLibrary(ANA, 'Ana');
    let stored = null;
    storage.upload.mockImplementationOnce(async (p, buf) => {
      stored = p; storage.blobs.set(p, Buffer.from(buf));
      await db.query('UPDATE libraries SET archived_at = NOW() WHERE id = $1', [lib.id]);  // an admin puts it away just now
    });
    await expect(guide.seedLibrary(lib.id, ANA)).rejects.toThrow(/no longer/);
    expect(await guideDocs(lib.id)).toHaveLength(0);
    expect(storage.del).toHaveBeenCalledWith(stored);
    expect(storage.blobs.has(stored)).toBe(false);
    expect((await libraryOf(ANA)).getting_started_claimed_at).toBeNull();
  });

  test('a contributor later made a viewer is skipped, and gets it if made a contributor again', async () => {
    await person(ANA);
    await libraries.ensurePersonalLibrary(ANA, null);
    await db.query(`UPDATE user_roles SET role = 'viewer' WHERE user_id = $1`, [ANA.id]);
    expect((await guide.backfill()).added).toBe(0);
    expect((await libraryOf(ANA)).getting_started_at).toBeNull();
    await db.query(`UPDATE user_roles SET role = 'contributor' WHERE user_id = $1`, [ANA.id]);
    expect((await guide.backfill()).added).toBe(1);
  });

  test('a server shutting down stops the pass between libraries', async () => {
    await person(ANA);
    await libraries.ensurePersonalLibrary(ANA, null);
    guide.stop();
    expect((await guide.backfill()).added).toBe(0);
  });

  test('a file already called that at the root is kept, not joined by a second one', async () => {
    await person(ANA);
    const lib = await libraries.ensurePersonalLibrary(ANA, 'Ana');
    await db.query(
      `INSERT INTO documents (name, size, mime_type, storage_path, uploaded_by, uploaded_by_email, library_id, library_scoped)
       VALUES ($1, 3, 'application/pdf', 'documents/mine.pdf', $2, $3, $4, true)`, [PDF, ANA.id, ANA.email, lib.id]);
    await guide.seedLibrary(lib.id, ANA);
    const docs = await guideDocs(lib.id);
    expect(docs.filter(d => d.name === PDF)).toHaveLength(1);
    expect(docs.filter(d => d.name === DOCX)).toHaveLength(1);
  });

  test('first sign-in, through the real middleware: a personal library with the guide already in it', async () => {
    jwt.verify.mockReturnValue({ sub: NEW.id, email: NEW.email, email_verified: true, name: 'New Person' });
    await request(app).get('/api/files').set('Authorization', 'Bearer t').expect(200);
    // the library and its guide are made alongside the request, not in front of it
    let docs = [];
    for (let i = 0; i < 100 && docs.length < 2; i++) {
      const lib = await libraryOf(NEW);
      docs = lib ? await guideDocs(lib.id) : [];
      if (docs.length < 2) await new Promise(r => setTimeout(r, 50));
    }
    expect(docs.map(d => d.name)).toEqual([DOCX, PDF]);
  });

});

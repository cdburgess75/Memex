'use strict';
// One accurate guide per account -- against a REAL, THROWAWAY Postgres, with the real
// audit chain (it is what says which copies the server itself made).
//
// Earlier releases put a Word copy beside the PDF, and an older edition of the PDF. At
// startup the copies nobody has changed are brought into line: the Word copy goes, the
// older PDF becomes the current one in place. Anything a person changed stays theirs.
//
//   MEMEX_TEST_PG_URL=postgres://user:pass@localhost:5432/memex_test \
//     npx jest --runInBand integration/gettingStartedTidy.pg
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PG = process.env.MEMEX_TEST_PG_URL;
const suite = PG ? describe : describe.skip;
if (PG) jest.setTimeout(180000);

jest.unmock('../../lib/gettingStarted');
jest.mock('jsonwebtoken');
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn(() => ({ getSigningKey: async () => ({ getPublicKey: () => 'k' }) })) }));
// Blobs live in memory, so "are these still the bytes that were shipped" is asked of real bytes.
jest.mock('../../lib/storage', () => {
  const blobs = new Map();
  return {
    blobs,
    upload: jest.fn(async (p, buf) => { blobs.set(p, Buffer.from(buf)); }),
    download: jest.fn(async (p) => { if (!blobs.has(p)) throw new Error('no blob ' + p); return blobs.get(p); }),
    del: jest.fn(async (p) => { blobs.delete(p); }),
    copy: jest.fn(async (from, to) => { blobs.set(to, Buffer.from(blobs.get(from))); }),
  };
});

const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ANA = { id: U(2), email: 'ana@acme.test', role: 'contributor' };
const BEN = { id: U(3), email: 'ben@acme.test', role: 'contributor' };
const PDF = 'Getting started with Depot.pdf';
const DOCX = 'Getting started with Depot.docx';
const PDF_MIME = 'application/pdf';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
// Stand-ins for the editions older releases shipped. Only their bytes matter.
const OLD_PDF = Buffer.from('%PDF the first edition of the guide');
const OLD_WORD = Buffer.from('PK the first edition of the guide, as a Word file');
const LAST_WORD = Buffer.from('PK the second edition of the guide, as a Word file');
const NOTHING = { wordRemoved: 0, pdfUpdated: 0, changedKept: 0, failed: 0 };

suite('one accurate getting-started guide per account', () => {
  let db, libraries, guide, storage, createDocumentRecord, CURRENT;
  const reset = () => db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const migrate = async () => {
    await db.query(fs.readFileSync(path.join(__dirname, '../../../postgres/init/01_schema.sql'), 'utf8'));
    await require('../../lib/migrations').run();
  };
  const person = (p) => db.query('INSERT INTO user_roles (user_id, email, role) VALUES ($1, $2, $3)', [p.id, p.email, p.role]);
  const docsIn = (libId) => db.query(
    'SELECT id, name, size, storage_path, content_hash, deleted_at FROM documents WHERE library_id = $1 ORDER BY name', [libId]);
  const row = (id) => db.queryOne('SELECT id, name, size, storage_path, content_hash, deleted_at FROM documents WHERE id = $1', [id]);
  const events = async (id) => (await db.query('SELECT event_type FROM document_events WHERE document_id = $1 ORDER BY chain_seq', [id])).map(e => e.event_type);

  // A file put into a library the way the guide is (or, with another eventType, the way a
  // person's own upload is recorded).
  async function place(libraryId, user, name, bytes, mime, eventType = 'guide_added') {
    const storagePath = `documents/${crypto.randomUUID()}-${name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    await storage.upload(storagePath, bytes, mime);
    const { doc } = await createDocumentRecord({
      displayName: name, storagePath, mimetype: mime, storedSize: bytes.length, user, libraryId, libraryScoped: true,
      notifyUpload: false, sourceDetail: 'getting-started guide', eventType, logActivity: false,
      precomputed: { contentHash: sha(bytes), documentText: null },
    });
    return row(doc.id);
  }
  // An account as the first release with the guide left it: the first PDF and its Word copy.
  async function olderAccount(p) {
    await person(p);
    const lib = await libraries.ensurePersonalLibrary(p, null);
    const pdf = await place(lib.id, p, PDF, OLD_PDF, PDF_MIME);
    const word = await place(lib.id, p, DOCX, OLD_WORD, DOCX_MIME);
    return { lib, pdf, word };
  }

  beforeAll(async () => {
    const dbName = decodeURIComponent(new URL(PG).pathname.slice(1));
    if (!/test/i.test(dbName)) throw new Error(`refusing to run: "${dbName}" does not look like a throwaway test database`);
    process.env.DATABASE_URL = PG;
    db = require('../../lib/db');
    libraries = require('../../lib/libraries');
    guide = require('../../lib/gettingStarted');
    storage = require('../../lib/storage');
    ({ createDocumentRecord } = require('../../lib/documents'));
    const bytes = fs.readFileSync(path.join(guide.ASSET_DIR, PDF));
    CURRENT = { bytes, hash: sha(bytes) };
    require('jsonwebtoken').decode.mockReturnValue({ header: { kid: 'k' } });
  });

  beforeEach(async () => {
    await guide.settled();
    await reset();
    await migrate();
    require('../../lib/settings')._reset();
    guide._resetForTests();
    guide._setPastForTests({ pdf: [sha(OLD_PDF)], word: [sha(OLD_WORD), sha(LAST_WORD)] });
    storage.blobs.clear();
    jest.clearAllMocks();
  });

  afterAll(async () => {
    try { await reset(); } catch { /* best effort */ }
    try { await db.end(); } catch { /* already closed */ }
  });

  test('the build lists the editions that went before, and never the current one as past', () => {
    guide._resetForTests();
    const past = guide.pastEditions();
    expect(past.word.length).toBeGreaterThanOrEqual(2);     // both releases that made a Word copy
    expect(past.pdf.length).toBeGreaterThanOrEqual(1);
    for (const h of [...past.pdf, ...past.word]) expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(past.pdf).not.toContain(CURRENT.hash);
  });

  test('an account from an older release ends up with one guide: the current PDF, in place', async () => {
    const { lib, pdf, word } = await olderAccount(ANA);
    expect(await guide.tidy()).toEqual({ ...NOTHING, wordRemoved: 1, pdfUpdated: 1 });

    const docs = await docsIn(lib.id);
    expect(docs.map(d => d.name)).toEqual([PDF]);
    const now = docs[0];
    expect(now.id).toBe(pdf.id);                                   // the same file, not a new one
    expect(now.content_hash).toBe(CURRENT.hash);
    expect(Number(now.size)).toBe(CURRENT.bytes.length);
    expect(storage.blobs.get(now.storage_path).equals(CURRENT.bytes)).toBe(true);
    // nothing is left behind in storage: not the Word copy, not the older PDF
    expect(storage.blobs.has(word.storage_path)).toBe(false);
    expect(storage.blobs.has(pdf.storage_path)).toBe(false);
    expect(storage.blobs.size).toBe(1);
    // and both are on the record as the server's doing
    expect(await events(pdf.id)).toEqual(['guide_added', 'guide_updated']);
    expect(await events(word.id)).toEqual(['guide_added', 'guide_removed']);
    const chain = await db.query('SELECT actor_email FROM document_events WHERE event_type IN ($1, $2)', ['guide_updated', 'guide_removed']);
    expect(chain.map(c => c.actor_email)).toEqual(['system@guide', 'system@guide']);
  });

  test('a second pass finds nothing to do', async () => {
    const { lib } = await olderAccount(ANA);
    await guide.tidy();
    const before = await docsIn(lib.id);
    jest.clearAllMocks();
    expect(await guide.tidy()).toEqual(NOTHING);
    expect(await docsIn(lib.id)).toEqual(before);
    expect(storage.upload).not.toHaveBeenCalled();
    expect(storage.del).not.toHaveBeenCalled();
  });

  test('an account from the last release keeps its PDF untouched and loses only the Word copy', async () => {
    await person(ANA);
    const lib = await libraries.ensurePersonalLibrary(ANA, null);
    const pdf = await place(lib.id, ANA, PDF, CURRENT.bytes, PDF_MIME);
    await place(lib.id, ANA, DOCX, LAST_WORD, DOCX_MIME);
    jest.clearAllMocks();
    expect(await guide.tidy()).toEqual({ ...NOTHING, wordRemoved: 1 });
    expect(await docsIn(lib.id)).toEqual([pdf]);
    expect(storage.upload).not.toHaveBeenCalled();
  });

  test('an account made by this release is left exactly as it is', async () => {
    await person(ANA);
    const lib = await libraries.ensurePersonalLibrary(ANA, null);
    expect(await guide.seedLibrary(lib.id, ANA)).toBe(true);
    const before = await docsIn(lib.id);
    expect(before.map(d => d.name)).toEqual([PDF]);
    expect(await guide.tidy()).toEqual(NOTHING);
    expect(await docsIn(lib.id)).toEqual(before);
  });

  test('every account is covered, each with its own files', async () => {
    const a = await olderAccount(ANA), b = await olderAccount(BEN);
    expect(await guide.tidy()).toEqual({ ...NOTHING, wordRemoved: 2, pdfUpdated: 2 });
    for (const acct of [a, b]) {
      const docs = await docsIn(acct.lib.id);
      expect(docs.map(d => d.name)).toEqual([PDF]);
      expect(docs[0].content_hash).toBe(CURRENT.hash);
    }
    const paths = (await db.query('SELECT storage_path FROM documents')).map(r => r.storage_path);
    expect(new Set(paths).size).toBe(2);            // a blob each, so one delete never takes another's copy
    expect(storage.blobs.size).toBe(2);
  });

  test('a copy that was renamed or filed away is still found, and keeps its name and place', async () => {
    const { lib, pdf, word } = await olderAccount(ANA);
    await db.query(`UPDATE documents SET name = 'Help/How to use Depot.pdf' WHERE id = $1`, [pdf.id]);
    await db.query(`UPDATE documents SET name = 'Help/' || name WHERE id = $1`, [word.id]);
    expect(await guide.tidy()).toEqual({ ...NOTHING, wordRemoved: 1, pdfUpdated: 1 });
    const docs = await docsIn(lib.id);
    expect(docs.map(d => d.name)).toEqual(['Help/How to use Depot.pdf']);
    expect(docs[0].content_hash).toBe(CURRENT.hash);
  });

  test('a Word copy somebody edited is their own work and stays, with its history', async () => {
    const { lib, word } = await olderAccount(ANA);
    // What saving from the editor does: keep the old bytes as a version, overwrite the blob
    // in place. documents.content_hash is not touched, so it still names the shipped file.
    await storage.copy(word.storage_path, `versions/${word.id}/0001-x.docx`);
    await db.query(
      `INSERT INTO document_versions (document_id, version_number, name, size, mime_type, storage_path, source)
       VALUES ($1, 1, $2, $3, $4, $5, 'wopi_save')`, [word.id, word.name, word.size, DOCX_MIME, `versions/${word.id}/0001-x.docx`]);
    const edited = Buffer.from('PK the guide with our own notes in it');
    await storage.upload(word.storage_path, edited, DOCX_MIME);
    await db.query('UPDATE documents SET size = $2 WHERE id = $1', [word.id, edited.length]);

    expect(await guide.tidy()).toEqual({ ...NOTHING, pdfUpdated: 1, changedKept: 1 });
    expect((await docsIn(lib.id)).map(d => d.name)).toEqual([DOCX, PDF]);
    expect(storage.blobs.get(word.storage_path).equals(edited)).toBe(true);
    expect(storage.blobs.has(`versions/${word.id}/0001-x.docx`)).toBe(true);
    expect(await events(word.id)).toEqual(['guide_added']);
  });

  test('changed bytes alone are enough to keep a copy, Word or PDF', async () => {
    const { lib, pdf, word } = await olderAccount(ANA);
    const mine = Buffer.from('not what was shipped');
    await storage.upload(word.storage_path, mine, DOCX_MIME);
    await storage.upload(pdf.storage_path, mine, PDF_MIME);
    expect(await guide.tidy()).toEqual({ ...NOTHING, changedKept: 2 });
    const docs = await docsIn(lib.id);
    expect(docs.map(d => d.name)).toEqual([DOCX, PDF]);
    for (const d of docs) expect(storage.blobs.get(d.storage_path).equals(mine)).toBe(true);
    expect(docs.find(d => d.name === PDF).content_hash).toBe(sha(OLD_PDF));   // not relabelled as current either
  });

  test('a restored older version does not make an edited copy look untouched', async () => {
    const { lib, word } = await olderAccount(ANA);
    // edited, then put back to the shipped bytes: the bytes match, the history says it was worked on
    await db.query(
      `INSERT INTO document_versions (document_id, version_number, name, size, mime_type, storage_path, source)
       VALUES ($1, 1, $2, 5, $3, 'versions/kept', 'replace')`, [word.id, word.name, DOCX_MIME]);
    expect((await guide.tidy()).changedKept).toBe(1);
    expect((await docsIn(lib.id)).map(d => d.name)).toContain(DOCX);
  });

  test('the same file put somewhere by a person is theirs: only the server\'s own copies are touched', async () => {
    const { lib } = await olderAccount(ANA);
    const team = await db.queryOne(
      `INSERT INTO libraries (name, created_by, created_by_email, owner_id, owner_email, personal)
       VALUES ('Onboarding', $1, $2, $1, $2, false) RETURNING id`, [ANA.id, ANA.email]);
    const word = await place(team.id, ANA, DOCX, OLD_WORD, DOCX_MIME, 'uploaded');
    const pdf = await place(team.id, ANA, PDF, OLD_PDF, PDF_MIME, 'uploaded');
    expect(await guide.tidy()).toEqual({ ...NOTHING, wordRemoved: 1, pdfUpdated: 1 });   // the personal library's two
    expect((await docsIn(lib.id)).map(d => d.name)).toEqual([PDF]);
    expect(await docsIn(team.id)).toEqual([word, pdf]);
    expect(storage.blobs.get(pdf.storage_path).equals(OLD_PDF)).toBe(true);
  });

  test('in the trash: the Word copy goes for good, the older PDF is left for the trash to deal with', async () => {
    const { lib, pdf, word } = await olderAccount(ANA);
    await db.query('UPDATE documents SET deleted_at = NOW() WHERE library_id = $1', [lib.id]);
    expect(await guide.tidy()).toEqual({ ...NOTHING, wordRemoved: 1 });
    const docs = await docsIn(lib.id);
    expect(docs.map(d => d.id)).toEqual([pdf.id]);
    expect(docs[0].deleted_at).not.toBeNull();                    // still deleted: it never comes back
    expect(docs[0].content_hash).toBe(sha(OLD_PDF));
    expect(storage.blobs.has(word.storage_path)).toBe(false);
  });

  test('what hung off the Word copy goes with it: its grants and its links', async () => {
    const { word } = await olderAccount(ANA);
    await db.query(
      `INSERT INTO document_share_links (document_id, token_hash, created_by, created_by_email) VALUES ($1, $2, $3, $4)`,
      [word.id, sha(Buffer.from('a link to the word copy')), ANA.id, ANA.email]);
    expect((await db.queryOne('SELECT count(*)::int n FROM document_acl WHERE document_id = $1', [word.id])).n).toBeGreaterThan(0);
    await guide.tidy();
    expect((await db.queryOne('SELECT count(*)::int n FROM document_acl WHERE document_id = $1', [word.id])).n).toBe(0);
    expect((await db.queryOne('SELECT count(*)::int n FROM document_share_links WHERE document_id = $1', [word.id])).n).toBe(0);
  });

  test('a link to the PDF, and a follow on it, survive the swap', async () => {
    const { pdf } = await olderAccount(ANA);
    await db.query(
      `INSERT INTO document_share_links (document_id, token_hash, created_by, created_by_email) VALUES ($1, $2, $3, $4)`,
      [pdf.id, sha(Buffer.from('a link to the pdf')), ANA.id, ANA.email]);
    await db.query('INSERT INTO document_follows (document_id, subscriber_email) VALUES ($1, $2)', [pdf.id, ANA.email]);
    await guide.tidy();
    expect((await db.queryOne('SELECT count(*)::int n FROM document_share_links WHERE document_id = $1', [pdf.id])).n).toBe(1);
    expect((await db.queryOne('SELECT count(*)::int n FROM document_follows WHERE document_id = $1', [pdf.id])).n).toBe(1);
    expect((await row(pdf.id)).content_hash).toBe(CURRENT.hash);
  });

  test('a PDF binned while it was being swapped keeps its old bytes, and the new blob is not left behind', async () => {
    const { lib, pdf } = await olderAccount(ANA);
    await db.query('DELETE FROM documents WHERE library_id = $1 AND name = $2', [lib.id, DOCX]);
    let stored = null;
    storage.upload.mockImplementationOnce(async (p, buf) => {
      stored = p; storage.blobs.set(p, Buffer.from(buf));
      await db.query('UPDATE documents SET deleted_at = NOW() WHERE id = $1', [pdf.id]);   // its owner bins it just now
    });
    expect(await guide.tidy()).toEqual(NOTHING);
    const now = await row(pdf.id);
    expect(now.storage_path).toBe(pdf.storage_path);
    expect(now.content_hash).toBe(sha(OLD_PDF));
    expect(storage.blobs.get(pdf.storage_path).equals(OLD_PDF)).toBe(true);
    expect(storage.blobs.has(stored)).toBe(false);
  });

  test('one copy that cannot be read does not stop the rest', async () => {
    const a = await olderAccount(ANA), b = await olderAccount(BEN);
    storage.blobs.delete(a.word.storage_path);                    // its blob is missing
    const said = [];
    const r = await guide.tidy({ log: (m) => said.push(m) });
    expect(r).toEqual({ ...NOTHING, wordRemoved: 1, pdfUpdated: 2, failed: 1 });
    expect(said).toHaveLength(1);
    expect(said[0]).toContain(a.word.id);
    expect((await docsIn(a.lib.id)).map(d => d.name)).toEqual([DOCX, PDF]);   // the unreadable one is left, not guessed at
    expect((await docsIn(b.lib.id)).map(d => d.name)).toEqual([PDF]);
  });

  test('a server shutting down stops between copies', async () => {
    const { lib } = await olderAccount(ANA);
    guide.stop();
    expect(await guide.tidy()).toEqual(NOTHING);
    expect((await docsIn(lib.id)).map(d => d.name)).toEqual([DOCX, PDF]);
  });

  test('with the guide switched off in Settings, nothing new is added but the tidying still runs', async () => {
    const { lib } = await olderAccount(ANA);
    await person(BEN);
    const bens = await libraries.ensurePersonalLibrary(BEN, null);
    await db.query(`INSERT INTO system_settings (key, value) VALUES ('getting_started_guide', 'false')
                    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
    require('../../lib/settings')._reset();
    expect((await guide.backfill()).disabled).toBe(true);
    expect(await docsIn(bens.id)).toHaveLength(0);
    expect(await guide.tidy()).toEqual({ ...NOTHING, wordRemoved: 1, pdfUpdated: 1 });
    expect((await docsIn(lib.id)).map(d => d.name)).toEqual([PDF]);
  });

  test('a copy whose "added" entry was never written is still found; a person\'s own upload of the same bytes is not', async () => {
    await person(ANA);
    const lib = await libraries.ensurePersonalLibrary(ANA, null);
    const lost = await place(lib.id, ANA, DOCX, OLD_WORD, DOCX_MIME);
    await db.query('DELETE FROM document_events WHERE document_id = $1', [lost.id]);   // the process stopped before the audit entry
    const mine = await place(lib.id, ANA, 'Copy of the guide.docx', OLD_WORD, DOCX_MIME, 'uploaded');
    expect(await guide.tidy()).toEqual({ ...NOTHING, wordRemoved: 1 });
    expect((await docsIn(lib.id)).map(d => d.id)).toEqual([mine.id]);
  });

  test('a Word copy that was the last file in a shared folder leaves the folder standing', async () => {
    const { lib, word } = await olderAccount(ANA);
    await db.query(`UPDATE documents SET name = 'Team notes/' || name WHERE id = $1`, [word.id]);
    await db.query(
      `INSERT INTO library_grants (library_id, folder_path, subject_type, subject_email, permission, granted_by)
       VALUES ($1, 'Team notes', 'user', $2, 'read', $3)`, [lib.id, BEN.email, ANA.id]);
    expect((await guide.tidy()).wordRemoved).toBe(1);
    const left = (await docsIn(lib.id)).map(d => d.name);
    expect(left).toContain('Team notes/.keep');                              // the folder stays, empty and still shared
    expect(left).not.toContain('Team notes/' + DOCX);
  });

  test('the Home activity card can ask for the feed without the guide housekeeping, before the limit', async () => {
    await olderAccount(ANA);
    await guide.tidy();
    const request = require('supertest');
    const express = require('express');
    const jwt = require('jsonwebtoken');
    await db.query('INSERT INTO user_roles (user_id, email, role, verified_email) VALUES ($1, $2, $3, $2)', [BEN.id, BEN.email, 'admin']);
    jwt.verify.mockReturnValue({ sub: BEN.id, email: BEN.email, email_verified: true });
    const app = express(); app.use(express.json()); app.use('/api/admin', require('../../routes/admin'));
    const all = await request(app).get('/api/admin/activity?limit=40').set('Authorization', 'Bearer t').expect(200);
    expect(all.body.events.map(e => e.event_type)).toEqual(expect.arrayContaining(['guide_added', 'guide_updated', 'guide_removed']));
    const home = await request(app).get('/api/admin/activity?limit=40&housekeeping=hide').set('Authorization', 'Bearer t').expect(200);
    expect(home.body.events.filter(e => e.event_type.startsWith('guide_'))).toHaveLength(0);
  });
});

'use strict';
// A file whose extracted text holds a NUL (U+0000) still uploads -- against a REAL,
// THROWAWAY Postgres, whose TEXT type refuses that character outright.
//
//   MEMEX_TEST_PG_URL=postgres://user:pass@localhost:5432/memex_test \
//     npx jest --runInBand integration/nulText.pg
const fs = require('fs');
const path = require('path');

const PG = process.env.MEMEX_TEST_PG_URL;
const suite = PG ? describe : describe.skip;
if (PG) jest.setTimeout(60000);

jest.mock('../../lib/auditLog', () => ({ append: jest.fn(async () => ({})) }));
// Blobs live in memory, so createDocumentRecord downloads, hashes and extracts real bytes.
jest.mock('../../lib/storage', () => {
  const blobs = new Map();
  return {
    blobs,
    upload: jest.fn(async (p, buf) => { blobs.set(p, Buffer.from(buf)); }),
    download: jest.fn(async (p) => { if (!blobs.has(p)) throw new Error('no blob ' + p); return blobs.get(p); }),
    del: jest.fn(async (p) => { blobs.delete(p); }),
  };
});
// What pdf-parse made of the PDF that was refused: text with NULs in it. The real
// extractText runs on top of it.
jest.mock('pdf-parse', () => jest.fn(async () => ({ text: 'Cyber Security\u0000 Checklist\u0000\n1. Patch\u0000 firmware' })));

const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ANA = { id: U(2), email: 'ana@acme.test', role: 'contributor' };

suite('extracted text with a NUL in it, against real Postgres', () => {
  let db, libraries, settings, storage, createDocumentRecord, lib;
  const reset = () => db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const migrate = async () => {
    await db.query(fs.readFileSync(path.join(__dirname, '../../../postgres/init/01_schema.sql'), 'utf8'));
    await require('../../lib/migrations').run();
  };
  const put = async (name, bytes) => {
    const storagePath = `uploads/${name}`;
    await storage.upload(storagePath, bytes);
    return createDocumentRecord({
      displayName: name, storagePath, mimetype: 'application/octet-stream', storedSize: bytes.length,
      user: ANA, sourceDetail: 'test', libraryId: lib.id,
    });
  };
  const textOf = (id) => db.queryOne('SELECT name, document_text FROM documents WHERE id = $1', [id]);

  beforeAll(async () => {
    const dbName = decodeURIComponent(new URL(PG).pathname.slice(1));
    if (!/test/i.test(dbName)) throw new Error(`refusing to run: "${dbName}" does not look like a throwaway test database`);
    process.env.DATABASE_URL = PG;
    db = require('../../lib/db');
    libraries = require('../../lib/libraries');
    settings = require('../../lib/settings');
    storage = require('../../lib/storage');
    ({ createDocumentRecord } = require('../../lib/documents'));
  });
  beforeEach(async () => {
    await reset();
    await migrate();
    settings._reset();
    storage.blobs.clear();
    await db.query('INSERT INTO user_roles (user_id, email, role) VALUES ($1, $2, $3)', [ANA.id, ANA.email, ANA.role]);
    lib = await libraries.ensurePersonalLibrary(ANA, 'Ana');
  });
  afterAll(async () => {
    try { await reset(); } catch { /* best effort */ }
    try { await db.end(); } catch { /* already closed */ }
  });

  test('Postgres itself refuses a NUL in TEXT (why the extractor strips it)', async () => {
    await expect(db.query('SELECT $1::text AS t', ['a\u0000b'])).rejects.toThrow(/0x00/);
  });

  test('a PDF whose text holds NULs is accepted and indexed without them', async () => {
    const r = await put('Cyber Security Checklist.pdf', Buffer.from('%PDF-1.4 stand-in'));
    expect(r.deduped).toBeFalsy();
    expect(r.canIngest).toBe(true);
    const row = await textOf(r.doc.id);
    expect(row.name).toBe('Cyber Security Checklist.pdf');
    expect(row.document_text).toBe('Cyber Security Checklist\n1. Patch firmware');
  });

  test('a plain-text file with NUL bytes in it is accepted too', async () => {
    const r = await put('notes.txt', Buffer.from('before\u0000after', 'utf8'));
    expect((await textOf(r.doc.id)).document_text).toBe('beforeafter');
  });
});

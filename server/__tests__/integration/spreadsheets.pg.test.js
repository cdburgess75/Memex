'use strict';
// Spreadsheets through the real file router, against a REAL, THROWAWAY Postgres, with the
// real SheetJS doing the parsing: an upload is indexed for search, a broken or hostile one
// still lands (just without text), and "New Excel spreadsheet" stores a workbook that opens.
// DROPS AND RECREATES the public schema.
//
//   MEMEX_TEST_PG_URL=postgres://user@localhost:5432/memex_test \
//     npx jest --runInBand integration/spreadsheets.pg
const fs = require('fs');
const path = require('path');
const PG = process.env.MEMEX_TEST_PG_URL;
const suite = PG ? describe : describe.skip;
if (PG) jest.setTimeout(120000);

jest.mock('jsonwebtoken');
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn(() => ({ getSigningKey: async () => ({ getPublicKey: () => 'k' }) })) }));
jest.mock('../../lib/auditLog', () => ({ append: jest.fn(async () => ({})) }));
jest.mock('../../lib/notifications', () => ({ create: jest.fn(async () => ({})) }));
jest.mock('../../lib/emailEvents', () => ({ send: jest.fn(async () => ({})) }));
const mockBlobs = new Map();
jest.mock('../../lib/storage', () => ({
  upload: jest.fn(async (p, buf) => { mockBlobs.set(p, Buffer.from(buf)); }),
  download: jest.fn(async (p) => { if (!mockBlobs.has(p)) throw new Error('no such blob ' + p); return mockBlobs.get(p); }),
  del: jest.fn(async (p) => { mockBlobs.delete(p); }), copy: jest.fn(async (from, to) => { mockBlobs.set(to, mockBlobs.get(from)); }),
  isLocalProvider: jest.fn(async () => false),
}));

const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const OWNER = { id: U(1), email: 'owner@corp.test' };
const LIB = U(50);

suite('spreadsheets through the file router', () => {
  let db, request, app, jwt, XLSX, sheets;
  const reset = () => db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const as = (r) => r.set('Authorization', 'Bearer t');
  const upload = (name, bytes) => as(request(app).post('/api/files/upload')).field('library_id', LIB).attach('file', bytes, name);
  const row = (id) => db.queryOne('SELECT name, document_text, storage_path FROM documents WHERE id = $1', [id]);
  const uploaded = async (res) => { expect(res.status).toBe(200); return row(res.body.id || res.body.document?.id || res.body.doc?.id); };

  beforeAll(async () => {
    const dbName = decodeURIComponent(new URL(PG).pathname.slice(1));
    if (!/test/i.test(dbName)) throw new Error(`refusing to run: "${dbName}" does not look like a throwaway test database`);
    process.env.DATABASE_URL = PG;
    db = require('../../lib/db');
    await reset();
    await db.query(fs.readFileSync(path.join(__dirname, '../../../postgres/init/01_schema.sql'), 'utf8'));
    await require('../../lib/migrations').run();
    await db.query('INSERT INTO user_roles (user_id, email, role, verified_email) VALUES ($1, $2, $3, $2)', [OWNER.id, OWNER.email, 'contributor']);
    await db.query('INSERT INTO libraries (id, name, owner_id, owner_email) VALUES ($1, $2, $3, $4)', [LIB, 'Finance', OWNER.id, OWNER.email]);
    jwt = require('jsonwebtoken'); jwt.decode.mockReturnValue({ header: { kid: 'k' } });
    jwt.verify.mockReturnValue({ sub: OWNER.id, email: OWNER.email, email_verified: true });
    XLSX = require('xlsx');
    sheets = require('../helpers/sheetFiles');
    request = require('supertest');
    const express = require('express');
    app = express(); app.use(express.json());
    app.use('/api/files', require('../../routes/files'));
  });
  afterAll(async () => { try { await reset(); } catch { /* best effort */ } try { await db.end(); } catch { /* closed */ } });

  test.each([['Stock.xlsx', 'xlsx'], ['Stock.xls', 'biff8']])('an uploaded %s is indexed, sheet by sheet', async (name, bookType) => {
    const doc = await uploaded(await upload(name, sheets.workbook(bookType)));
    expect(doc.name).toBe(name);
    expect(doc.document_text).toBe(sheets.STOCK_TEXT);
    const res = await as(request(app).get('/api/files/search')).query({ q: 'Widget' }).expect(200);
    expect(res.body.map((d) => d.name)).toContain(name);
  });

  test('a truncated .xlsx still uploads, kept as sent, with no text', async () => {
    const whole = sheets.workbook('xlsx');
    const doc = await uploaded(await upload('Cut.xlsx', whole.subarray(0, whole.length >> 1)));
    expect(doc.name).toBe('Cut.xlsx');
    expect(doc.document_text).toBeNull();
    expect(mockBlobs.get(doc.storage_path).length).toBe(whole.length >> 1); // the bytes are kept as sent
  });

  test('a workbook named after Object.prototype keys uploads without polluting the server', async () => {
    const before = Object.getOwnPropertyNames(Object.prototype).sort();
    const doc = await uploaded(await upload('Proto.xlsx', sheets.prototypeNamedXlsx()));
    expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(before);
    expect({}.polluted).toBeUndefined();
    expect(doc.document_text).toContain('polluted,<script>x</script>');
    // And the server still answers normally afterwards.
    await as(request(app).get('/api/files/search')).query({ q: 'polluted' }).expect(200);
  });

  test('an HTML page posing as .xls is indexed as its cell text, not its markup', async () => {
    const doc = await uploaded(await upload('Page.xls', sheets.HTML_AS_XLS));
    expect(doc.document_text).toContain('hi');
    expect(doc.document_text).not.toMatch(/<img|onerror|<script/i);
  });

  test('"New Excel spreadsheet" stores a workbook that opens', async () => {
    const res = await as(request(app).post('/api/files/create')).send({ type: 'xlsx', name: 'Budget', library_id: LIB });
    expect(res.status).toBe(200);
    const doc = await db.queryOne(`SELECT name, mime_type, storage_path FROM documents WHERE name = 'Budget.xlsx'`);
    expect(doc.mime_type).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const wb = XLSX.read(mockBlobs.get(doc.storage_path), { type: 'buffer' });
    expect(wb.SheetNames).toEqual(['Sheet1']);
  });
});

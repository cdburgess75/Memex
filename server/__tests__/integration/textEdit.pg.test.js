'use strict';
// The built-in text editor's save, through the real file router, against a REAL,
// THROWAWAY Postgres: which types it saves, and that search results carry what the page
// needs to offer editing. DROPS AND RECREATES the public schema.
const fs = require('fs');
const path = require('path');
const PG = process.env.MEMEX_TEST_PG_URL;
const suite = PG ? describe : describe.skip;
if (PG) jest.setTimeout(120000);

jest.mock('jsonwebtoken');
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn(() => ({ getSigningKey: async () => ({ getPublicKey: () => 'k' }) })) }));
jest.mock('../../lib/auditLog', () => ({ append: jest.fn(async () => ({})) }));
jest.mock('../../lib/storage', () => {
  const blobs = new Map();
  return { blobs, upload: jest.fn(async (p, b) => { blobs.set(p, Buffer.from(b)); }), download: jest.fn(async (p) => blobs.get(p) || Buffer.alloc(0)),
    del: jest.fn(async () => {}), copy: jest.fn(async () => {}) };
});

const U = (n) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
const OWNER = { id: U(1), email: 'owner@corp.test' };
const LIB = U(50);

suite('the text editor saves', () => {
  let db, request, app, jwt, storage;
  const reset = () => db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const doc = (name) => db.queryOne(
    `INSERT INTO documents (name, size, mime_type, storage_path, uploaded_by, uploaded_by_email, library_id, library_scoped, document_text)
     VALUES ($1, 3, 'text/plain', 'seed/' || md5($1), $2, $3, $4, true, 'searchable words') RETURNING id`, [name, OWNER.id, OWNER.email, LIB]);
  beforeAll(async () => {
    const dbName = decodeURIComponent(new URL(PG).pathname.slice(1));
    if (!/test/i.test(dbName)) throw new Error(`refusing to run: "${dbName}" does not look like a throwaway test database`);
    process.env.DATABASE_URL = PG;
    db = require('../../lib/db');
    await reset();
    await db.query(fs.readFileSync(path.join(__dirname, '../../../postgres/init/01_schema.sql'), 'utf8'));
    await require('../../lib/migrations').run();
    await db.query('INSERT INTO user_roles (user_id, email, role, verified_email) VALUES ($1, $2, $3, $2)', [OWNER.id, OWNER.email, 'contributor']);
    await db.query('INSERT INTO libraries (id, name, owner_id, owner_email) VALUES ($1, $2, $3, $4)', [LIB, 'IT', OWNER.id, OWNER.email]);
    jwt = require('jsonwebtoken'); jwt.decode.mockReturnValue({ header: { kid: 'k' } });
    jwt.verify.mockReturnValue({ sub: OWNER.id, email: OWNER.email, email_verified: true });
    storage = require('../../lib/storage');
    request = require('supertest');
    const express = require('express');
    app = express(); app.use(express.json());
    app.use('/api/files', require('../../routes/files'));
  });
  afterAll(async () => { try { await reset(); } catch { /* best effort */ } try { await db.end(); } catch { /* closed */ } });
  const put = (id, content) => request(app).put(`/api/files/${id}/content`).set('Authorization', 'Bearer t').send({ content });

  test.each(['web.config', 'nginx.conf', 'index.html', 'index.php', 'setup.ps1', 'notes.txt', 'app.yaml'])('%s saves, and is indexed again', async (name) => {
    const { id } = await doc(`Configs/${name}`);
    await put(id, 'new text here').expect(200);
    const row = await db.queryOne('SELECT size, document_text, storage_path FROM documents WHERE id = $1', [id]);
    expect(Number(row.size)).toBe(13);
    expect(row.document_text).toBe('new text here');
    expect(storage.blobs.get(row.storage_path).toString()).toBe('new text here');
  });

  test.each(['photo.jpg', 'report.docx', 'settings.reg', 'server.rdp', 'program.exe'])('%s is refused', async (name) => {
    const { id } = await doc(name);
    const res = await put(id, 'x');
    expect(res.status).toBe(400);
  });

  test('search results say which library a file is in, so the page can offer editing', async () => {
    await doc('Configs/findme.conf');
    const res = await request(app).get('/api/files/search').query({ q: 'findme' }).set('Authorization', 'Bearer t').expect(200);
    expect(res.body[0]).toMatchObject({ name: 'Configs/findme.conf', library_id: LIB, library_scoped: true });
  });
});

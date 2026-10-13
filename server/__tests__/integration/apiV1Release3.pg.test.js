'use strict';
process.env.LINK_UPLOAD_TMP = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'depot-api3-pg-'));
// The public API, release 3 -- replacing a file in place, content hashes and modified times,
// moving and copying across libraries, folder copies and ZIPs -- through the real routers
// against a REAL, THROWAWAY Postgres. DROPS AND RECREATES the public schema; refuses to run
// unless the database name contains "test".
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PG = process.env.MEMEX_TEST_PG_URL;
const suite = PG ? describe : describe.skip;
if (PG) jest.setTimeout(180000);

jest.mock('jsonwebtoken');
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn(() => ({ getSigningKey: async () => ({ getPublicKey: () => 'k' }) })) }));
const mockBlobs = new Map();
const mockLocalBase = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'depot-api3-local-'));
jest.mock('../../lib/storage', () => ({
  upload: jest.fn(async (p, buf) => { mockBlobs.set(p, Buffer.from(buf)); }),
  uploadStream: jest.fn(async (p, readable) => { const b = []; for await (const c of readable) b.push(c); const buf = Buffer.concat(b); mockBlobs.set(p, buf); return { size: buf.length }; }),
  download: jest.fn(async (p) => { if (!mockBlobs.has(p)) throw new Error('no such blob ' + p); return mockBlobs.get(p); }),
  downloadStream: jest.fn(async (p, { rangeHeader } = {}) => { const buf = mockBlobs.get(p) || Buffer.alloc(0); const m = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader || ''); if (m) { const s = +m[1], e = m[2] ? +m[2] : buf.length - 1; return { stream: require('stream').Readable.from([buf.subarray(s, e + 1)]), length: e - s + 1, totalSize: buf.length, range: { start: s, end: e } }; } return { stream: require('stream').Readable.from([buf]), length: buf.length, totalSize: buf.length }; }),
  del: jest.fn(async (p) => { mockBlobs.delete(p); }), copy: jest.fn(async (from, to) => { if (!mockBlobs.has(from)) throw new Error('no such blob ' + from); mockBlobs.set(to, mockBlobs.get(from)); }),
  isLocalProvider: jest.fn(async () => true), getUrl: jest.fn(async () => 'http://x/url'), localBase: jest.fn(async () => mockLocalBase), validateLocalToken: jest.fn(),
}));
jest.mock('../../lib/notifications', () => ({ create: jest.fn(async () => ({})) }));
jest.mock('../../lib/emailEvents', () => ({ send: jest.fn(async () => ({})) }));
jest.mock('../../lib/textExtraction', () => ({ extractText: jest.fn(async (buf) => buf.toString('utf8').replace(/[\0�]/g, '').slice(0, 1000)) }));

const U = (n) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
const DAVE = { id: U(1), email: 'dave@corp.test' };
const LIB = U(50), LIB2 = U(51);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

suite('the public API, release 3', () => {
  let db, request, app, jwt, tokens = {};
  const reset = () => db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const asSession = (a) => { jwt.verify.mockReturnValue({ sub: a.id, email: a.email, email_verified: true }); return 'Bearer session'; };
  const api = (tok) => ({
    get: (p) => request(app).get('/api/v1' + p).set('Authorization', `Bearer ${tok}`),
    post: (p, body) => request(app).post('/api/v1' + p).set('Authorization', `Bearer ${tok}`).send(body),
    put: (p, bytes, type = 'application/octet-stream') => request(app).put('/api/v1' + p).set('Authorization', `Bearer ${tok}`).set('Content-Type', type).send(bytes),
  });
  const binary = (req) => req.buffer(true).parse((res, cb) => { const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); });
  const versions = (id) => db.query('SELECT source, storage_path FROM document_versions WHERE document_id = $1 ORDER BY version_number', [id]);
  const events = (id, type) => db.queryOne('SELECT count(*)::int AS n FROM document_events WHERE document_id = $1 AND event_type = $2', [id, type]).then(r => r.n);

  beforeAll(async () => {
    const dbName = decodeURIComponent(new URL(PG).pathname.slice(1));
    if (!/test/i.test(dbName)) throw new Error(`refusing to run: "${dbName}" does not look like a throwaway test database`);
    process.env.DATABASE_URL = PG;
    db = require('../../lib/db');
    await reset();
    await db.query(fs.readFileSync(path.join(__dirname, '../../../postgres/init/01_schema.sql'), 'utf8'));
    await require('../../lib/migrations').run();
    await db.query('INSERT INTO user_roles (user_id, email, role, verified_email) VALUES ($1, $2, $3, $2)', [DAVE.id, DAVE.email, 'contributor']);
    await db.query('INSERT INTO libraries (id, name, owner_id, owner_email) VALUES ($1, $2, $3, $4), ($5, $6, $3, $4)', [LIB, 'Projects', DAVE.id, DAVE.email, LIB2, 'Archive']);
    jwt = require('jsonwebtoken'); jwt.decode.mockReturnValue({ header: { kid: 'k' } });
    request = require('supertest');
    const express = require('express');
    app = express();
    const API_FILE_BODY = /^\/api\/v1\/(libraries\/[^/]+\/files\/|uploads\/[^/]+\/chunks\/|files\/[^/]+\/content$)/;
    app.use(express.json({ limit: '1mb', type: (req) => !(req.method === 'PUT' && API_FILE_BODY.test(req.path)) && /^application\/(.+\+)?json/i.test(String(req.headers['content-type'] || '')) }));
    app.use('/api/files', require('../../routes/files'));
    app.use('/api/tokens', require('../../routes/tokens'));
    app.use('/api/v1', require('../../routes/v1'));
    const mk = async (name, scope) => (await request(app).post('/api/tokens').set('Authorization', asSession(DAVE)).send({ name, scope })).body.token;
    tokens.write = await mk('Sync', 'write'); tokens.read = await mk('Reports', 'read');
  });
  afterAll(async () => { try { await reset(); } catch { /* best effort */ } try { await db.end(); } catch { /* closed */ } });

  const A = Buffer.from('first edition\n'), B = Buffer.from('second edition, longer\n');
  let fileId, created;
  test('a fresh upload carries its content hash and a modified time equal to its creation; listings show both', async () => {
    const up = await api(tokens.write).put(`/libraries/${LIB}/files/Reports/q1.txt`, A).expect(200);
    expect(up.body.doc).toMatchObject({ name: 'q1.txt', path: 'Reports/q1.txt', size: A.length, content_hash: sha(A) });
    expect(up.body.doc.modified_at).toBe(up.body.doc.created_at);
    expect(up.body.replaced).toBeUndefined();
    fileId = up.body.doc.id; created = up.body.doc.created_at;
    const list = await api(tokens.read).get(`/libraries/${LIB}/files?folder=Reports`).expect(200);
    expect(list.body.files[0]).toMatchObject({ id: fileId, content_hash: sha(A), modified_at: created });
    expect((await api(tokens.read).get(`/files/${fileId}`).expect(200)).body).toMatchObject({ content_hash: sha(A), modified_at: created });
  });

  test('replace in place: refused without the flag, done with it; what was there becomes a version; identical bytes change nothing', async () => {
    const clash = await api(tokens.write).put(`/libraries/${LIB}/files/Reports/q1.txt`, B);
    expect(clash.status).toBe(409); expect(clash.body.existing_id).toBe(fileId);
    const rep = await api(tokens.write).put(`/libraries/${LIB}/files/Reports/q1.txt?replace=true`, B).expect(200);
    expect(rep.body).toMatchObject({ replaced: true, doc: { id: fileId, path: 'Reports/q1.txt', size: B.length, content_hash: sha(B) } });
    expect(new Date(rep.body.doc.modified_at) > new Date(created)).toBe(true);
    expect(rep.body.doc.created_at).toBe(created);
    expect(Buffer.from((await api(tokens.read).get(`/files/${fileId}/content`).expect(200)).body).toString()).toBe(B.toString());
    const kept = await versions(fileId);
    expect(kept.map(v => v.source)).toEqual(['replace']);
    expect(mockBlobs.get(kept[0].storage_path).toString()).toBe(A.toString());
    expect(await events(fileId, 'replaced')).toBe(1);
    // the same bytes again: nothing happens
    const same = await api(tokens.write).put(`/libraries/${LIB}/files/Reports/q1.txt?replace=1`, B).expect(200);
    expect(same.body).toMatchObject({ unchanged: true, doc: { id: fileId, content_hash: sha(B) } });
    expect(same.body.replaced).toBeUndefined();
    expect((await versions(fileId)).length).toBe(1);
    expect(await events(fileId, 'replaced')).toBe(1);
    // a read token may not
    expect((await api(tokens.read).put(`/libraries/${LIB}/files/Reports/q1.txt?replace=true`, A)).status).toBe(403);
  });

  test('PUT /files/{id}/content replaces by id, keeping the type unless a real one is sent', async () => {
    const C = Buffer.from('third edition\n');
    const r = await api(tokens.write).put(`/files/${fileId}/content`, C, 'text/plain').expect(200);
    expect(r.body).toMatchObject({ replaced: true, doc: { id: fileId, size: C.length, mime_type: 'text/plain', content_hash: sha(C) } });
    const D = Buffer.from('fourth edition\n');
    const r2 = await api(tokens.write).put(`/files/${fileId}/content`, D).expect(200); // octet-stream: the type stays
    expect(r2.body.doc.mime_type).toBe('text/plain');
    expect((await binary(api(tokens.read).get(`/files/${fileId}/content`)).expect(200)).body.toString()).toBe(D.toString()); // text/plain now, so read the bytes explicitly
    expect((await versions(fileId)).map(v => v.source)).toEqual(['replace', 'replace', 'replace']);
    expect((await api(tokens.write).put('/files/not-an-id/content', C)).status).toBe(404);
    expect((await api(tokens.write).put(`/files/${U(77)}/content`, C)).status).toBe(404);
    expect((await api(tokens.read).put(`/files/${fileId}/content`, C)).status).toBe(403);
  });

  test('a save from the editor keeps the hash and the modified time current too', async () => {
    const text = '# notes\n\nsaved in the app\n';
    await request(app).put(`/api/files/${fileId}/content`).set('Authorization', asSession(DAVE)).send({ content: text }).expect(200);
    const f = (await api(tokens.read).get(`/files/${fileId}`).expect(200)).body;
    expect(f.content_hash).toBe(sha(Buffer.from(text)));
    expect(new Date(f.modified_at) > new Date(created)).toBe(true);
  });

  test('move a file to another library, then copy it back', async () => {
    const up = await api(tokens.write).put(`/libraries/${LIB}/files/Docs/plan.txt`, Buffer.from('the plan')).expect(200);
    const id = up.body.doc.id;
    expect((await api(tokens.write).post(`/files/${id}/move`, {})).status).toBe(400);
    const moved = await api(tokens.write).post(`/files/${id}/move`, { library_id: LIB2 }).expect(200);
    expect(moved.body).toEqual({ ok: true, moved: true, kept: false, skipped: false });
    expect((await api(tokens.read).get(`/files/${id}`).expect(200)).body).toMatchObject({ library_id: LIB2, path: 'Docs/plan.txt' });
    expect((await api(tokens.read).get(`/libraries/${LIB2}/files?recursive=true`).expect(200)).body.files.map(f => f.path)).toEqual(['Docs/plan.txt']);
    const copied = await api(tokens.write).post(`/files/${id}/copy`, { library_id: LIB }).expect(200);
    expect(copied.body).toMatchObject({ ok: true, copied: true, copy: { path: 'Docs/plan.txt', library_id: LIB, content_hash: sha(Buffer.from('the plan')) } });
    expect(copied.body.copy.id).not.toBe(id);
    expect(Buffer.from((await api(tokens.read).get(`/files/${copied.body.copy.id}/content`).expect(200)).body).toString()).toBe('the plan');
    expect((await api(tokens.read).post(`/files/${id}/move`, { library_id: LIB })).status).toBe(403);
  });

  test('copy a folder to another library; move a folder within its library; both at once is refused', async () => {
    await api(tokens.write).put(`/libraries/${LIB}/files/Site/a.txt`, Buffer.from('a')).expect(200);
    const b = await api(tokens.write).put(`/libraries/${LIB}/files/Site/sub/b.txt`, Buffer.from('b')).expect(200);
    expect((await api(tokens.write).post(`/libraries/${LIB}/folders/copy`, { path: 'Site' })).status).toBe(400);
    const copied = await api(tokens.write).post(`/libraries/${LIB}/folders/copy`, { path: 'Site', to_library_id: LIB2 }).expect(200);
    expect(copied.body).toMatchObject({ ok: true, count: 2 });
    const there = (await api(tokens.read).get(`/libraries/${LIB2}/files?recursive=true`).expect(200)).body.files.map(f => f.path).sort();
    expect(there).toEqual(['Docs/plan.txt', 'Site/a.txt', 'Site/sub/b.txt']);
    expect((await api(tokens.write).post(`/libraries/${LIB}/folders/move`, { path: 'Site', to_folder: 'Old', to_library_id: LIB2 })).status).toBe(400);
    await api(tokens.write).post(`/libraries/${LIB}/folders/move`, { path: 'Site', to_folder: 'Old' }).expect(200);
    expect((await api(tokens.read).get(`/files/${b.body.doc.id}`).expect(200)).body.path).toBe('Old/Site/sub/b.txt');
    expect((await api(tokens.read).get(`/libraries/${LIB}/files?recursive=true`).expect(200)).body.folders.map(f => f.path)).toEqual(expect.arrayContaining(['Old', 'Old/Site', 'Old/Site/sub']));
  });

  test('a folder as a ZIP', async () => {
    const zip = await binary(api(tokens.read).get(`/libraries/${LIB}/folders/zip?path=Old/Site`)).expect(200);
    expect(zip.headers['content-type']).toMatch(/application\/zip/);
    expect(zip.headers['content-disposition']).toContain('Site.zip');
    expect(zip.body.subarray(0, 2).toString()).toBe('PK');
    expect(zip.body.length).toBeGreaterThan(100);
    expect((await api(tokens.read).get(`/libraries/${LIB}/folders/zip`)).status).toBe(400);
    expect((await api(tokens.read).get(`/libraries/${LIB}/folders/zip?path=Nowhere`)).status).toBe(404);
  });

  test('the reference says so', async () => {
    const { spec } = require('../../lib/openapi');
    const sp = spec();
    expect(sp.info.description).toContain('Release 3');
    expect(sp.paths['/libraries/{id}/files/{path}'].put.parameters.map(p => p.name)).toContain('replace');
    expect(sp.components.schemas.File.properties).toHaveProperty('content_hash');
    expect(sp.components.schemas.File.properties).toHaveProperty('modified_at');
    for (const p of ['/files/{id}/move', '/files/{id}/copy', '/libraries/{id}/folders/copy', '/libraries/{id}/folders/zip']) expect(sp.paths[p]).toBeTruthy();
    expect(sp.paths['/files/{id}/content'].put).toBeTruthy();
  });
});

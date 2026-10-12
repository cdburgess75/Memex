'use strict';
process.env.LINK_UPLOAD_TMP = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'depot-api-pg-'));
// The public API, release 1, through the real routers against a REAL, THROWAWAY Postgres:
// a token is made from the app, then used for everything a script would do. DROPS AND
// RECREATES the public schema; refuses to run unless the database name contains "test".
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PG = process.env.MEMEX_TEST_PG_URL;
const suite = PG ? describe : describe.skip;
if (PG) jest.setTimeout(180000);

jest.mock('jsonwebtoken');
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn(() => ({ getSigningKey: async () => ({ getPublicKey: () => 'k' }) })) }));
const mockBlobs = new Map();
const mockLocalBase = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'depot-api-local-'));
jest.mock('../../lib/storage', () => ({
  upload: jest.fn(async (p, buf) => { mockBlobs.set(p, Buffer.from(buf)); }),
  uploadStream: jest.fn(async (p, readable) => { const b = []; for await (const c of readable) b.push(c); const buf = Buffer.concat(b); mockBlobs.set(p, buf); return { size: buf.length }; }),
  download: jest.fn(async (p) => mockBlobs.get(p) || Buffer.alloc(0)),
  downloadStream: jest.fn(async (p, { rangeHeader } = {}) => { const buf = mockBlobs.get(p) || Buffer.alloc(0); const m = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader || ''); if (m) { const s = +m[1], e = m[2] ? +m[2] : buf.length - 1; return { stream: require('stream').Readable.from([buf.subarray(s, e + 1)]), length: e - s + 1, totalSize: buf.length, range: { start: s, end: e } }; } return { stream: require('stream').Readable.from([buf]), length: buf.length, totalSize: buf.length }; }),
  del: jest.fn(async (p) => { mockBlobs.delete(p); }), copy: jest.fn(async () => {}),
  // local storage, so staged chunks have somewhere to go (<localBase>/.uploads)
  isLocalProvider: jest.fn(async () => true), getUrl: jest.fn(async () => 'http://x/url'), localBase: jest.fn(async () => mockLocalBase), validateLocalToken: jest.fn(),
}));
jest.mock('../../lib/notifications', () => ({ create: jest.fn(async () => ({})) }));
jest.mock('../../lib/emailEvents', () => ({ send: jest.fn(async () => ({})) }));
jest.mock('../../lib/textExtraction', () => ({ extractText: jest.fn(async (buf) => buf.toString('utf8').replace(/[\0\uFFFD]/g, '').slice(0, 1000)) })); // random bytes carry NULs, which a text column refuses

const U = (n) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
const DAVE = { id: U(1), email: 'dave@corp.test' }, VIEW = { id: U(2), email: 'viewer@corp.test' }, ADMIN = { id: U(3), email: 'admin@corp.test' }, OTHER = { id: U(4), email: 'other@corp.test' };
const LIB = U(50);

suite('the public API, release 1', () => {
  let db, request, app, jwt, tokens = {};
  const reset = () => db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const asSession = (a) => { jwt.verify.mockReturnValue({ sub: a.id, email: a.email, email_verified: true }); return 'Bearer session'; };
  const api = (tok) => ({
    get: (p) => request(app).get('/api/v1' + p).set('Authorization', `Bearer ${tok}`),
    post: (p, body) => request(app).post('/api/v1' + p).set('Authorization', `Bearer ${tok}`).send(body),
    patch: (p, body) => request(app).patch('/api/v1' + p).set('Authorization', `Bearer ${tok}`).send(body),
    del: (p, body) => request(app).delete('/api/v1' + p).set('Authorization', `Bearer ${tok}`).send(body),
    put: (p, bytes, type = 'application/octet-stream') => request(app).put('/api/v1' + p).set('Authorization', `Bearer ${tok}`).set('Content-Type', type).send(bytes),
  });

  beforeAll(async () => {
    const dbName = decodeURIComponent(new URL(PG).pathname.slice(1));
    if (!/test/i.test(dbName)) throw new Error(`refusing to run: "${dbName}" does not look like a throwaway test database`);
    process.env.DATABASE_URL = PG;
    db = require('../../lib/db');
    await reset();
    await db.query(fs.readFileSync(path.join(__dirname, '../../../postgres/init/01_schema.sql'), 'utf8'));
    await require('../../lib/migrations').run();
    for (const [a, role] of [[DAVE, 'contributor'], [VIEW, 'viewer'], [ADMIN, 'admin'], [OTHER, 'contributor']]) {
      await db.query('INSERT INTO user_roles (user_id, email, role, verified_email) VALUES ($1, $2, $3, $2)', [a.id, a.email, role]);
    }
    await db.query('INSERT INTO libraries (id, name, owner_id, owner_email) VALUES ($1, $2, $3, $4)', [LIB, 'Projects', DAVE.id, DAVE.email]);
    jwt = require('jsonwebtoken'); jwt.decode.mockReturnValue({ header: { kid: 'k' } });
    request = require('supertest');
    const express = require('express');
    app = express();
    // the same body rule the server uses: a PUT of a file body is never parsed as JSON
    const API_FILE_BODY = /^\/api\/v1\/(libraries\/[^/]+\/files\/|uploads\/[^/]+\/chunks\/)/;
    app.use(express.json({ limit: '1mb', type: (req) => !(req.method === 'PUT' && API_FILE_BODY.test(req.path)) && /^application\/(.+\+)?json/i.test(String(req.headers['content-type'] || '')) }));
    app.use('/api/files', require('../../routes/files'));
    app.use('/api/libraries', require('../../routes/libraries'));
    app.use('/api/tokens', require('../../routes/tokens'));
    app.get('/api/v1/openapi.json', (_req, res) => res.json(require('../../lib/openapi').spec()));
    app.use('/api/docs', require('../../routes/docs'));
    app.use('/api/v1', require('../../routes/v1'));
  });
  afterAll(async () => { try { await reset(); } catch { /* best effort */ } try { await db.end(); } catch { /* closed */ } });

  // ---- tokens are made from the app, with a sign-in ----
  test('a contributor makes write and read tokens; the token is shown once and stored hashed', async () => {
    const res = await request(app).post('/api/tokens').set('Authorization', asSession(DAVE)).send({ name: 'Importer', scope: 'write' });
    expect(res.status).toBe(201);
    expect(res.body.token).toMatch(/^depot_/);
    expect(res.body).toMatchObject({ name: 'Importer', scope: 'write', prefix: res.body.token.slice(0, 12), expires_at: null });
    tokens.write = res.body.token; tokens.writeId = res.body.id;
    const ro = await request(app).post('/api/tokens').set('Authorization', asSession(DAVE)).send({ name: 'Reports', scope: 'read', expires_in_days: 30 });
    expect(ro.status).toBe(201); expect(ro.body.expires_at).not.toBeNull();
    tokens.read = ro.body.token;
    const row = await db.queryOne('SELECT token_hash FROM api_tokens WHERE id = $1', [tokens.writeId]);
    expect(row.token_hash).toBe(require('../../lib/apiTokens').hash(tokens.write));
    const list = await request(app).get('/api/tokens').set('Authorization', asSession(DAVE));
    expect(list.body.tokens.map(t => t.name).sort()).toEqual(['Importer', 'Reports']);
    expect(JSON.stringify(list.body)).not.toContain(tokens.write.slice(12));
  });
  test('a viewer cannot make one; a contributor cannot make an admin one; an admin can', async () => {
    expect((await request(app).post('/api/tokens').set('Authorization', asSession(VIEW)).send({ name: 'x', scope: 'read' })).status).toBe(403);
    expect((await request(app).post('/api/tokens').set('Authorization', asSession(DAVE)).send({ name: 'x', scope: 'admin' })).status).toBe(403);
    const a = await request(app).post('/api/tokens').set('Authorization', asSession(ADMIN)).send({ name: 'Ops', scope: 'admin' });
    expect(a.status).toBe(201); tokens.admin = a.body.token;
  });

  // ---- using them ----
  test('/me says who the token acts as and what it may do', async () => {
    const me = await api(tokens.write).get('/me').expect(200);
    expect(me.body).toMatchObject({ user: { id: DAVE.id, email: DAVE.email, role: 'contributor' }, scope: 'write', token: { name: 'Importer', scope: 'write' } });
  });
  test('a token is for /api/v1 only; the app\'s own routes refuse it', async () => {
    const res = await request(app).get('/api/files').set('Authorization', `Bearer ${tokens.write}`);
    expect(res.status).toBe(403);
    expect((await request(app).post('/api/tokens').set('Authorization', `Bearer ${tokens.write}`).send({ name: 'x', scope: 'read' })).status).toBe(403);
  });
  test('a made-up token and a revoked one are 401', async () => {
    expect((await api('depot_' + 'a'.repeat(43)).get('/me')).status).toBe(401);
    const gone = await request(app).post('/api/tokens').set('Authorization', asSession(OTHER)).send({ name: 'temp', scope: 'read' });
    await request(app).delete('/api/tokens/' + gone.body.id).set('Authorization', asSession(OTHER)).expect(200);
    expect((await api(gone.body.token).get('/me')).status).toBe(401);
  });

  let fileId, folderFileId;
  test('upload in one request, then list, read back, download, and download a range', async () => {
    const body = Buffer.from('hello from the api, line one\nline two\n');
    const up = await api(tokens.write).put(`/libraries/${LIB}/files/Reports/2026/q1.txt`, body);
    expect(up.status).toBe(200);
    expect(up.body.doc).toMatchObject({ name: 'Reports/2026/q1.txt', library_id: LIB });
    fileId = up.body.doc.id;
    const again = await api(tokens.write).put(`/libraries/${LIB}/files/Reports/2026/q1.txt`, body);
    expect(again.status).toBe(409); expect(again.body.existing_id).toBe(fileId);
    const root = await api(tokens.read).get(`/libraries/${LIB}/files`).expect(200);
    expect(root.body.files).toEqual([]);
    expect(root.body.folders).toEqual([{ path: 'Reports', name: 'Reports', count: 1 }]);
    const deep = await api(tokens.read).get(`/libraries/${LIB}/files?folder=Reports/2026`).expect(200);
    expect(deep.body.files).toHaveLength(1);
    expect(deep.body.files[0]).toMatchObject({ id: fileId, name: 'q1.txt', path: 'Reports/2026/q1.txt', folder: 'Reports/2026', size: body.length, library_content: true });
    const all = await api(tokens.read).get(`/libraries/${LIB}/files?recursive=true`).expect(200);
    expect(all.body.files.map(f => f.id)).toEqual([fileId]);
    expect(all.body.folders.map(f => f.path)).toEqual(['Reports', 'Reports/2026']);
    const one = await api(tokens.read).get(`/files/${fileId}`).expect(200);
    expect(one.body.path).toBe('Reports/2026/q1.txt');
    const dl = await api(tokens.read).get(`/files/${fileId}/content`).expect(200);
    expect(Buffer.from(dl.body).toString()).toBe(body.toString());
    expect(dl.headers['content-disposition']).toContain('q1.txt');
    const part = await api(tokens.read).get(`/files/${fileId}/content`).set('Range', 'bytes=0-4').expect(206);
    expect(Buffer.from(part.body).toString()).toBe('hello');
  });
  test('a .json file sent as application/json arrives as bytes, not as a parsed object', async () => {
    const body = Buffer.from('{"a": 1, "b": [1, 2, 3]}');
    const up = await api(tokens.write).put(`/libraries/${LIB}/files/config.json`, body, 'application/json').expect(200);
    const dl = await api(tokens.read).get(`/files/${up.body.doc.id}/content`).expect(200);
    expect(Buffer.from(dl.body).toString()).toBe(body.toString());
  });
  test('a read-only token cannot write', async () => {
    const res = await api(tokens.read).put(`/libraries/${LIB}/files/nope.txt`, Buffer.from('x'));
    expect(res.status).toBe(403); expect(res.body.error).toMatch(/read scope/);
    expect((await api(tokens.read).del(`/files/${fileId}`)).status).toBe(403);
    expect((await api(tokens.read).post(`/libraries/${LIB}/folders`, { path: 'X' })).status).toBe(403);
  });
  test('folders: create, rename, delete through the app\'s own folder routes', async () => {
    const made = await api(tokens.write).post(`/libraries/${LIB}/folders`, { path: 'Clients/Acme' }).expect(200);
    expect(made.body.path).toBe('Clients/Acme');
    const up = await api(tokens.write).put(`/libraries/${LIB}/files/Clients/Acme/contract.txt`, Buffer.from('c')).expect(200);
    folderFileId = up.body.doc.id;
    await api(tokens.write).post(`/libraries/${LIB}/folders/rename`, { path: 'Clients/Acme', name: 'Acme Ltd' }).expect(200);
    const moved = await api(tokens.read).get(`/files/${folderFileId}`).expect(200);
    expect(moved.body.path).toBe('Clients/Acme Ltd/contract.txt');
    await api(tokens.write).del(`/libraries/${LIB}/folders`, { path: 'Clients/Acme Ltd' }).expect(200);
    expect((await api(tokens.read).get(`/files/${folderFileId}`)).status).toBe(404);
  });
  test('rename and move a file, search, trash and restore', async () => {
    const r = await api(tokens.write).patch(`/files/${fileId}`, { name: 'q1-final.txt' }).expect(200);
    expect(r.body.name).toBe('Reports/2026/q1-final.txt');
    const m = await api(tokens.write).patch(`/files/${fileId}`, { folder: 'Reports' }).expect(200);
    expect(m.body.name).toBe('Reports/q1-final.txt');
    const s = await api(tokens.read).get('/search?q=q1-final').expect(200);
    expect(s.body.files.map(f => f.id)).toEqual([fileId]);
    await api(tokens.write).del(`/files/${fileId}`).expect(200);
    const trash = await api(tokens.write).get('/trash').expect(200);
    expect(trash.body.files.map(f => f.id)).toContain(fileId);
    await api(tokens.write).post(`/files/${fileId}/restore`).expect(200);
    expect((await api(tokens.read).get(`/files/${fileId}`)).status).toBe(200);
  });
  test('share links: make, list, revoke', async () => {
    const made = await api(tokens.write).post(`/files/${fileId}/links`, { expires_in_days: 3 }).expect(200);
    expect(made.body.share.url).toContain('/s/');
    const list = await api(tokens.write).get(`/files/${fileId}/links`).expect(200);
    expect(list.body.shares.map(x => x.id)).toContain(made.body.share.id);
    await api(tokens.write).del(`/files/${fileId}/links/${made.body.share.id}`).expect(200);
  });
  test('resumable upload: start, send two chunks, complete', async () => {
    const data = crypto.randomBytes(20000);
    const start = await api(tokens.write).post('/uploads', { path: 'Big/video.bin', library_id: LIB, size: data.length, mime_type: 'application/octet-stream', chunk_size: 16384 }).expect(200);
    const sess = start.body.session; expect(sess.id).toBeTruthy();
    const size = Number(sess.chunk_size || sess.chunkSize);
    for (let i = 0; i * size < data.length; i++) {
      await api(tokens.write).put(`/uploads/${sess.id}/chunks/${i}`, data.subarray(i * size, (i + 1) * size)).expect(200);
    }
    const done = await api(tokens.write).post(`/uploads/${sess.id}/complete`, {}).expect(200);
    expect(done.body.doc).toMatchObject({ name: 'Big/video.bin', size: String(data.length) });
  });
  test('libraries: list, one, create, rename', async () => {
    const list = await api(tokens.read).get('/libraries').expect(200);
    expect(list.body.libraries.map(l => l.id)).toContain(LIB);
    const one = await api(tokens.read).get(`/libraries/${LIB}`).expect(200);
    expect(one.body.name).toBe('Projects');
    const made = await api(tokens.write).post('/libraries', { name: 'From a script' }).expect(200);
    await api(tokens.write).patch(`/libraries/${made.body.id}`, { name: 'Renamed by a script' }).expect(200);
    expect((await api(tokens.read).get(`/libraries/${made.body.id}`)).body.name).toBe('Renamed by a script');
    expect((await api(tokens.read).get(`/libraries/${U(99)}`)).status).toBe(404);
  });
  test('every write a token made is on the record as the person, marked with the token', async () => {
    const rows = await db.query(`SELECT event_type, actor_email, detail FROM document_events WHERE detail LIKE '%via token "Importer"%' ORDER BY chain_seq`);
    const kinds = new Set(rows.map(r => r.event_type));
    for (const k of ['uploaded', 'renamed', 'trashed', 'restored', 'share_created', 'share_revoked']) expect(kinds).toContain(k);
    expect(rows.every(r => r.actor_email === DAVE.email)).toBe(true);
    const act = await db.query(`SELECT event FROM activity_log WHERE event LIKE '%via token "Importer"%'`);
    expect(act.length).toBeGreaterThan(0);
    const mine = await db.query(`SELECT event_type FROM document_events WHERE event_type IN ('api_token_created', 'api_token_revoked')`);
    expect(mine.length).toBeGreaterThanOrEqual(5);
  });
  test('activity: the caller\'s files; since narrows it; an admin sees everything', async () => {
    const all = await api(tokens.read).get('/activity?limit=500').expect(200);
    expect(all.body.events.length).toBeGreaterThan(5);
    expect(all.body.events.every(e => e.file_id)).toBe(true);
    const newest = all.body.events[0].at;
    const later = await api(tokens.read).get('/activity?since=' + encodeURIComponent(newest)).expect(200);
    expect(later.body.events).toEqual([]);
    const theirs = await api(tokens.admin).get('/activity?limit=500').expect(200);
    expect(theirs.body.events.length).toBeGreaterThanOrEqual(all.body.events.length);
    expect((await api(tokens.read).get('/activity?since=nope')).status).toBe(400);
  });
  test('an administrator sees every token and can revoke one; a contributor cannot', async () => {
    const all = await request(app).get('/api/tokens/all').set('Authorization', asSession(ADMIN)).expect(200);
    expect(all.body.tokens.find(t => t.name === 'Importer')).toMatchObject({ user_email: DAVE.email });
    expect((await request(app).get('/api/tokens/all').set('Authorization', asSession(DAVE))).status).toBe(403);
    await request(app).delete('/api/tokens/all/' + tokens.writeId).set('Authorization', asSession(ADMIN)).expect(200);
    expect((await api(tokens.write).get('/me')).status).toBe(401);
  });
  test('an unknown endpoint points at the docs; the docs page and the spec are served', async () => {
    const nf = await api(tokens.read).get('/nothing');
    expect(nf.status).toBe(404); expect(nf.body.error).toContain('/api/docs');
    const docs = await request(app).get('/api/docs').expect(200);
    expect(docs.text).toContain('Depot API'); expect(docs.text).toContain('/api/v1/files/{id}/content');
    const spec = await request(app).get('/api/v1/openapi.json').expect(200);
    expect(spec.body.openapi).toBe('3.1.0');
  });
  test('the description covers every route the router registers, and nothing else', () => {
    const router = require('../../routes/v1');
    const registered = new Set();
    for (const layer of router.stack) {
      if (!layer.route) continue;
      const p = layer.route.path.replace(/:(\w+)/g, '{$1}').replace(/\/\*$/, '/{path}');
      for (const m of Object.keys(layer.route.methods)) registered.add(`${m} ${p}`);
    }
    const described = new Set();
    for (const [p, ops] of Object.entries(require('../../lib/openapi').paths)) for (const m of Object.keys(ops)) described.add(`${m} ${p}`);
    expect([...registered].sort()).toEqual([...described].sort());
  });
});

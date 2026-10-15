'use strict';
process.env.LINK_UPLOAD_TMP = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'depot-dav-pg-'));
// Depot as a drive (routes/dav.js): WebDAV through the real routers against a REAL,
// THROWAWAY Postgres. DROPS AND RECREATES the public schema; refuses to run unless the
// database name contains "test".
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PG = process.env.MEMEX_TEST_PG_URL;
const suite = PG ? describe : describe.skip;
if (PG) jest.setTimeout(180000);

jest.mock('jsonwebtoken');
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn(() => ({ getSigningKey: async () => ({ getPublicKey: () => 'k' }) })) }));
const mockBlobs = new Map();
const mockLocalBase = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'depot-dav-local-'));
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
const PAT = { id: U(2), email: 'pat@corp.test' };
const LIB = U(50), LIB2 = U(51), LIB3 = U(52);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const basic = (tok) => 'Basic ' + Buffer.from(`anyone:${tok}`).toString('base64');

suite('Depot as a drive (WebDAV at /dav)', () => {
  let db, request, app, jwt, tokens = {};
  const reset = () => db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const asSession = (a) => { jwt.verify.mockReturnValue({ sub: a.id, email: a.email, email_verified: true }); return 'Bearer session'; };
  // A drive client: every WebDAV method, signed in with a token as the Basic password.
  const dav = (tok) => {
    const req = (method, p, headers = {}) => { let r = request(app)[method]('/dav' + p).set('Authorization', basic(tok)); for (const [k, v] of Object.entries(headers)) r = r.set(k, v); return r; };
    return {
      propfind: (p, depth = '1') => req('propfind', p, { Depth: depth }),
      get: (p, headers) => req('get', p, headers), head: (p) => req('head', p),
      put: (p, bytes, type = 'application/octet-stream') => req('put', p, { 'Content-Type': type }).send(bytes),
      mkcol: (p) => req('mkcol', p), delete: (p) => req('delete', p),
      move: (p, to, headers) => req('move', p, { Destination: '/dav' + to, ...headers }),
      copy: (p, to, headers) => req('copy', p, { Destination: '/dav' + to, ...headers }),
      lock: (p, headers) => req('lock', p, headers), unlock: (p, headers) => req('unlock', p, headers),
      proppatch: (p) => req('proppatch', p), options: (p) => request(app).options('/dav' + p),
    };
  };
  const binary = (r) => r.buffer(true).parse((res, cb) => { const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); });
  // The hrefs a multistatus answer lists, decoded.
  const hrefs = (res) => [...String(res.text).matchAll(/<D:href>([^<]*)<\/D:href>/g)].map(m => decodeURIComponent(m[1]));
  const doc = (libraryId, name) => db.queryOne('SELECT id, name, size, content_hash, deleted_at, library_id FROM documents WHERE library_id = $1 AND name = $2 AND deleted_at IS NULL', [libraryId, name]);
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
    await db.query('INSERT INTO user_roles (user_id, email, role, verified_email) VALUES ($1, $2, $3, $2), ($4, $5, $3, $5)', [DAVE.id, DAVE.email, 'contributor', PAT.id, PAT.email]);
    await db.query('INSERT INTO libraries (id, name, owner_id, owner_email) VALUES ($1, $2, $3, $4), ($5, $6, $3, $4), ($7, $8, $9, $10)',
      [LIB, 'Projects', DAVE.id, DAVE.email, LIB2, 'Archive', LIB3, 'Pat only', PAT.id, PAT.email]);
    jwt = require('jsonwebtoken'); jwt.decode.mockReturnValue({ header: { kid: 'k' } });
    request = require('supertest');
    const express = require('express');
    app = express();
    const DRIVE_PATH = /^\/dav(\/|$)/;
    app.use(express.json({ limit: '1mb', type: (req) => !DRIVE_PATH.test(req.path) && /^application\/(.+\+)?json/i.test(String(req.headers['content-type'] || '')) }));
    app.use('/api/files', require('../../routes/files'));
    app.use('/api/tokens', require('../../routes/tokens'));
    app.use('/dav', require('../../routes/dav'));
    const mk = async (who, name, scope) => (await request(app).post('/api/tokens').set('Authorization', asSession(who)).send({ name, scope })).body.token;
    tokens.write = await mk(DAVE, 'Laptop', 'write'); tokens.read = await mk(DAVE, 'Reports', 'read'); tokens.pat = await mk(PAT, 'Pat laptop', 'write');
  });
  afterAll(async () => { try { await reset(); } catch { /* best effort */ } try { await db.end(); } catch { /* closed */ } });

  test('asks for a password when none is given, and answers OPTIONS before signing in', async () => {
    const r = await request(app).propfind('/dav/').set('Depth', '0');
    expect(r.status).toBe(401);
    expect(r.headers['www-authenticate']).toMatch(/^Basic realm="Depot"/);
    const o = await request(app).options('/dav/');
    expect(o.status).toBe(200);
    expect(o.headers.dav).toBe('1, 2');
    expect(o.headers.allow).toMatch(/PROPFIND/);
    expect((await request(app).propfind('/dav/').set('Authorization', basic('depot_' + 'x'.repeat(43)))).status).toBe(401);
    jwt.verify.mockImplementationOnce(() => { throw new Error('not a token'); }); // what Keycloak's keys say of a made-up password
    expect((await request(app).propfind('/dav/').set('Authorization', basic('not-a-token'))).status).toBe(401);
  });

  test('the root lists the libraries the person can open; a Bearer token works too', async () => {
    const r = await dav(tokens.write).propfind('/');
    expect(r.status).toBe(207);
    expect(r.headers['content-type']).toMatch(/application\/xml/);
    // ("dave" and "pat" are the personal libraries made when each signed in to make a token)
    expect(hrefs(r).sort()).toEqual(['/dav/', '/dav/Archive/', '/dav/Projects/', '/dav/dave/']);
    expect(r.text).toContain('<D:collection/>');
    const bearer = await request(app).propfind('/dav/').set('Authorization', `Bearer ${tokens.write}`).set('Depth', '1');
    expect(hrefs(bearer)).toContain('/dav/Projects/');
    // Pat sees Pat's own libraries and nothing of Dave's
    expect(hrefs(await dav(tokens.pat).propfind('/')).sort()).toEqual(['/dav/', '/dav/Pat only/', '/dav/pat/']);
    expect((await dav(tokens.pat).propfind('/Projects/')).status).toBe(404);
  });

  const A = Buffer.from('first edition\n'), B = Buffer.from('second edition, longer\n');
  let q1;
  test('PUT makes a file (folders along the way included); PROPFIND, GET, HEAD and ranges read it back', async () => {
    const r = await dav(tokens.write).put('/Projects/Reports/q1.txt', A, 'text/plain');
    expect(r.status).toBe(201);
    q1 = await doc(LIB, 'Reports/q1.txt');
    expect(q1).toMatchObject({ size: String(A.length), content_hash: sha(A) });
    expect(r.headers.etag).toBe(`"${sha(A)}"`);
    const lib = await dav(tokens.write).propfind('/Projects/');
    expect(hrefs(lib)).toEqual(['/dav/Projects/', '/dav/Projects/Reports/']);
    const folder = await dav(tokens.write).propfind('/Projects/Reports/');
    expect(hrefs(folder)).toEqual(['/dav/Projects/Reports/', '/dav/Projects/Reports/q1.txt']);
    expect(folder.text).toContain(`<D:getcontentlength>${A.length}</D:getcontentlength>`);
    expect(folder.text).toContain(`<D:getetag>"${sha(A)}"</D:getetag>`);
    expect(folder.text).toContain('<D:getcontenttype>text/plain</D:getcontenttype>');
    expect(folder.text).toMatch(/<D:getlastmodified>[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} [\d:]+ GMT<\/D:getlastmodified>/);
    const one = await dav(tokens.write).propfind('/Projects/Reports/q1.txt', '0');
    expect(hrefs(one)).toEqual(['/dav/Projects/Reports/q1.txt']);
    const got = await binary(dav(tokens.write).get('/Projects/Reports/q1.txt'));
    expect(got.status).toBe(200);
    expect(got.body.toString()).toBe(A.toString());
    expect(got.headers.etag).toBe(`"${sha(A)}"`);
    const head = await dav(tokens.write).head('/Projects/Reports/q1.txt');
    expect(head.status).toBe(200);
    expect(head.headers['content-length']).toBe(String(A.length));
    const part = await binary(dav(tokens.write).get('/Projects/Reports/q1.txt', { Range: 'bytes=6-12' }));
    expect(part.status).toBe(206);
    expect(part.body.toString()).toBe('edition');
    expect(part.headers['content-range']).toBe(`bytes 6-12/${A.length}`);
    expect(await events(q1.id, 'downloaded')).toBe(1); // the whole-file read, not the piece from the middle
    expect((await dav(tokens.write).get('/Projects/Reports/nothing.txt')).status).toBe(404);
  });

  test('PUT over a file keeps its id and what it held as a version', async () => {
    const r = await dav(tokens.write).put('/Projects/Reports/q1.txt', B, 'text/plain');
    expect(r.status).toBe(204);
    const now = await doc(LIB, 'Reports/q1.txt');
    expect(now.id).toBe(q1.id);
    expect(now.content_hash).toBe(sha(B));
    const kept = await versions(q1.id);
    expect(kept.map(v => v.source)).toEqual(['replace']);
    expect(mockBlobs.get(kept[0].storage_path).toString()).toBe(A.toString());
    expect(await events(q1.id, 'replaced')).toBe(1);
  });

  test('MKCOL makes a folder; again is 405; housekeeping files are accepted and discarded', async () => {
    expect((await dav(tokens.write).mkcol('/Projects/Reports/Drafts')).status).toBe(201);
    expect(hrefs(await dav(tokens.write).propfind('/Projects/Reports/'))).toEqual(['/dav/Projects/Reports/', '/dav/Projects/Reports/Drafts/', '/dav/Projects/Reports/q1.txt']);
    expect(hrefs(await dav(tokens.write).propfind('/Projects/Reports/Drafts/'))).toEqual(['/dav/Projects/Reports/Drafts/']);
    expect((await dav(tokens.write).mkcol('/Projects/Reports/Drafts')).status).toBe(405);
    expect((await dav(tokens.write).mkcol('/Projects')).status).toBe(405);
    expect((await dav(tokens.write).mkcol('/Elsewhere/x')).status).toBe(404);
    expect((await dav(tokens.write).put('/Projects/Reports/.DS_Store', Buffer.from('junk'))).status).toBe(201);
    expect((await dav(tokens.write).put('/Projects/Reports/._q1.txt', Buffer.from('junk'))).status).toBe(201);
    expect((await dav(tokens.write).put('/Projects/Reports/~$q1.docx', Buffer.from('junk'))).status).toBe(201);
    expect((await dav(tokens.write).mkcol('/Projects/.Trashes')).status).toBe(201);
    expect(await doc(LIB, 'Reports/.DS_Store')).toBeNull();
    expect((await dav(tokens.write).propfind('/Projects/Reports/.DS_Store', '0')).status).toBe(404);
    expect((await dav(tokens.write).delete('/Projects/Reports/.DS_Store')).status).toBe(204);
    expect((await dav(tokens.write).put('/Projects/Reports/.keep', Buffer.from(''))).status).toBe(403);
  });

  test('a name Depot would change is refused, not stored under another name', async () => {
    const r = await dav(tokens.write).put('/Projects/Reports/Smith & Co (2026).txt', A);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/would change that file name/);
    expect((await dav(tokens.write).mkcol('/Projects/R&D')).status).toBe(409);
    expect((await dav(tokens.write).put('/Projects/R&D/plan.txt', A)).status).toBe(409);
    expect(await db.queryOne(`SELECT count(*)::int AS n FROM documents WHERE library_id = $1 AND name LIKE '%Smith%' OR name LIKE 'R_D%'`, [LIB])).toEqual({ n: 0 });
  });

  test('MOVE renames a file, moves it into another folder, and onto an existing file keeps that file', async () => {
    expect((await dav(tokens.write).move('/Projects/Reports/q1.txt', '/Projects/Reports/q1-final.txt')).status).toBe(201);
    expect((await doc(LIB, 'Reports/q1-final.txt')).id).toBe(q1.id);
    expect(await doc(LIB, 'Reports/q1.txt')).toBeNull();
    expect((await dav(tokens.write).move('/Projects/Reports/q1-final.txt', '/Projects/Reports/Drafts/q1.txt')).status).toBe(201);
    expect((await doc(LIB, 'Reports/Drafts/q1.txt')).id).toBe(q1.id);
    // the save dance: a temporary file written, then moved over the original
    const C = Buffer.from('third edition, from Word\n');
    expect((await dav(tokens.write).put('/Projects/Reports/memo.txt', A)).status).toBe(201);
    const memo = await doc(LIB, 'Reports/memo.txt');
    expect((await dav(tokens.write).put('/Projects/Reports/memo.tmp', C)).status).toBe(201);
    const tmp = await doc(LIB, 'Reports/memo.tmp');
    expect((await dav(tokens.write).move('/Projects/Reports/memo.tmp', '/Projects/Reports/memo.txt', { Overwrite: 'F' })).status).toBe(412);
    expect((await dav(tokens.write).move('/Projects/Reports/memo.tmp', '/Projects/Reports/memo.txt', { Overwrite: 'T' })).status).toBe(204);
    const after = await doc(LIB, 'Reports/memo.txt');
    expect(after.id).toBe(memo.id); // the same file: its shares, links and history stay
    expect(after.content_hash).toBe(sha(C));
    expect((await versions(memo.id)).map(v => v.source)).toEqual(['replace']);
    expect(await events(memo.id, 'replaced')).toBe(1);
    expect(await doc(LIB, 'Reports/memo.tmp')).toBeNull();
    expect((await db.queryOne('SELECT deleted_at FROM documents WHERE id = $1', [tmp.id])).deleted_at).not.toBeNull(); // the temporary file went to the Trash
    expect(Buffer.from((await binary(dav(tokens.write).get('/Projects/Reports/memo.txt'))).body).toString()).toBe(C.toString());
    expect((await dav(tokens.write).move('/Projects/Reports/Drafts/q1.txt', '/Projects/Reports/Drafts')).status).toBe(409); // a folder is there
    expect((await dav(tokens.write).move('/Projects/Reports/Drafts/q1.txt', '/Pat only/q1.txt')).status).toBe(403); // not on Dave's drive
    expect((await dav(tokens.write).move('/Projects/Reports/Drafts/q1.txt', '/Projects')).status).toBe(403);
    expect((await dav(tokens.write).move('/Projects/Reports/Drafts/q1.txt', '/Projects/Reports/Drafts/~$q1.txt')).status).toBe(403);
  });

  test('MOVE takes a file, and a folder, to another library; folders rename and move as on the website', async () => {
    expect((await dav(tokens.write).put('/Projects/Reports/Drafts/notes.txt', A)).status).toBe(201);
    const notes = await doc(LIB, 'Reports/Drafts/notes.txt');
    expect((await dav(tokens.write).move('/Projects/Reports/Drafts/notes.txt', '/Archive/Old/notes.txt')).status).toBe(201);
    expect(await doc(LIB, 'Reports/Drafts/notes.txt')).toBeNull();
    expect((await doc(LIB2, 'Old/notes.txt')).id).toBe(notes.id);
    // a folder, renamed in place
    expect((await dav(tokens.write).move('/Projects/Reports/Drafts', '/Projects/Reports/Final')).status).toBe(201);
    expect((await doc(LIB, 'Reports/Final/q1.txt')).id).toBe(q1.id);
    // moved under another folder and renamed at once
    expect((await dav(tokens.write).mkcol('/Projects/Done')).status).toBe(201);
    expect((await dav(tokens.write).move('/Projects/Reports/Final', '/Projects/Done/2026')).status).toBe(201);
    expect((await doc(LIB, 'Done/2026/q1.txt')).id).toBe(q1.id);
    expect(hrefs(await dav(tokens.write).propfind('/Projects/Done/'))).toEqual(['/dav/Projects/Done/', '/dav/Projects/Done/2026/']);
    // to another library, same path
    expect((await dav(tokens.write).move('/Projects/Done/2026', '/Archive/Done/2026')).status).toBe(201);
    expect((await doc(LIB2, 'Done/2026/q1.txt')).id).toBe(q1.id);
    expect((await dav(tokens.write).propfind('/Projects/Done/2026/')).status).toBe(404);
    // and back, renamed on the way
    expect((await dav(tokens.write).move('/Archive/Done/2026', '/Projects/Reports/2026')).status).toBe(201);
    expect((await doc(LIB, 'Reports/2026/q1.txt')).id).toBe(q1.id);
  });

  test('COPY makes a new file from the stored bytes; a folder copies to another library at the same path', async () => {
    expect((await dav(tokens.write).copy('/Projects/Reports/2026/q1.txt', '/Projects/Reports/2026/q1 copy.txt')).status).toBe(201);
    const c = await doc(LIB, 'Reports/2026/q1 copy.txt');
    expect(c.id).not.toBe(q1.id);
    expect(c.content_hash).toBe((await doc(LIB, 'Reports/2026/q1.txt')).content_hash);
    expect((await dav(tokens.write).copy('/Projects/Reports/2026/q1.txt', '/Projects/Reports/2026/q1 copy.txt', { Overwrite: 'F' })).status).toBe(412);
    expect((await dav(tokens.write).copy('/Projects/Reports/2026/q1.txt', '/Projects/Reports/2026/q1 copy.txt')).status).toBe(204); // the same bytes: nothing to do
    expect((await dav(tokens.write).copy('/Projects/Reports/2026', '/Projects/Reports/2027')).status).toBe(403);
    expect((await dav(tokens.write).copy('/Projects/Reports/2026', '/Archive/Reports/2026')).status).toBe(201);
    expect(await doc(LIB2, 'Reports/2026/q1.txt')).not.toBeNull();
    expect((await doc(LIB2, 'Reports/2026/q1.txt')).id).not.toBe(q1.id);
  });

  test('DELETE sends a file, or a folder, to the Trash', async () => {
    expect((await dav(tokens.write).delete('/Projects/Reports/2026/q1 copy.txt')).status).toBe(204);
    expect(await doc(LIB, 'Reports/2026/q1 copy.txt')).toBeNull();
    expect((await dav(tokens.write).delete('/Projects/Reports/2026/q1 copy.txt')).status).toBe(404);
    expect((await dav(tokens.write).delete('/Archive/Reports')).status).toBe(204);
    expect(await doc(LIB2, 'Reports/2026/q1.txt')).toBeNull();
    expect((await dav(tokens.write).propfind('/Archive/Reports/')).status).toBe(404);
    expect((await dav(tokens.write).delete('/Archive')).status).toBe(403);
    expect((await doc(LIB, 'Reports/2026/q1.txt')).id).toBe(q1.id); // untouched
  });

  test('a read-only token reads everything and changes nothing', async () => {
    const ro = dav(tokens.read);
    expect((await ro.propfind('/Projects/Reports/2026/')).status).toBe(207);
    expect((await binary(ro.get('/Projects/Reports/2026/q1.txt'))).status).toBe(200);
    expect((await ro.put('/Projects/Reports/2026/new.txt', A)).status).toBe(403);
    expect((await ro.mkcol('/Projects/New')).status).toBe(403);
    expect((await ro.delete('/Projects/Reports/2026/q1.txt')).status).toBe(403);
    expect((await ro.move('/Projects/Reports/2026/q1.txt', '/Projects/x.txt')).status).toBe(403);
    expect((await ro.lock('/Projects/Reports/2026/q1.txt')).status).toBe(403);
    expect((await doc(LIB, 'Reports/2026/q1.txt')).id).toBe(q1.id);
  });

  test('a library shared read-only lists on the drive and refuses saves; one shared read-write takes them', async () => {
    await db.query(`INSERT INTO library_grants (library_id, folder_path, subject_type, subject_email, permission) VALUES ($1, '', 'user', $2, 'read')`, [LIB, PAT.email]);
    const pat = dav(tokens.pat);
    expect(hrefs(await pat.propfind('/')).sort()).toEqual(['/dav/', '/dav/Pat only/', '/dav/Projects/', '/dav/pat/']);
    expect(hrefs(await pat.propfind('/Projects/Reports/2026/'))).toContain('/dav/Projects/Reports/2026/q1.txt');
    expect((await pat.put('/Projects/Reports/2026/q1.txt', B)).status).toBe(403);
    expect((await pat.put('/Projects/Reports/2026/pat.txt', B)).status).toBe(403);
    expect((await pat.delete('/Projects/Reports/2026/q1.txt')).status).toBe(403);
    expect((await pat.move('/Projects/Reports/2026/q1.txt', '/Projects/Reports/2026/q2.txt')).status).toBe(404); // the app's answer: not theirs to change
    await db.query(`UPDATE library_grants SET permission = 'write' WHERE library_id = $1 AND subject_email = $2`, [LIB, PAT.email]);
    expect((await pat.put('/Projects/Reports/2026/pat.txt', B)).status).toBe(201);
    expect(await doc(LIB, 'Reports/2026/pat.txt')).not.toBeNull();
  });

  test('LOCK gives Office its "file in use": a second person is refused until the lock is given up or runs out', async () => {
    const p = '/Projects/Reports/2026/q1.txt';
    const l = await dav(tokens.write).lock(p, { Timeout: 'Second-600' });
    expect(l.status).toBe(200);
    expect(l.headers['lock-token']).toMatch(/^<opaquelocktoken:/);
    expect(l.text).toContain('<D:timeout>Second-600</D:timeout>');
    expect(l.text).toContain('<D:lockroot><D:href>/dav/Projects/Reports/2026/q1.txt</D:href></D:lockroot>');
    const token = l.headers['lock-token'].slice(1, -1);
    expect((await dav(tokens.pat).lock(p)).status).toBe(423);
    expect((await dav(tokens.write).lock(p, { If: `(<${token}>)` })).status).toBe(200); // refreshed
    expect((await dav(tokens.pat).unlock(p, { 'Lock-Token': '<opaquelocktoken:not-it>' })).status).toBe(204); // not theirs: nothing happens
    expect((await dav(tokens.pat).lock(p)).status).toBe(423);
    expect((await dav(tokens.write).unlock(p, { 'Lock-Token': `<${token}>` })).status).toBe(204);
    expect((await dav(tokens.pat).lock(p)).status).toBe(200);
    // a lock that has run out no longer holds
    const { locks } = require('../../routes/dav')._forTests;
    for (const l of locks.values()) l.expires = Date.now() - 1;
    expect((await dav(tokens.write).lock(p)).status).toBe(200);
    expect((await dav(tokens.write).proppatch(p)).status).toBe(207);
    expect((await dav(tokens.write).lock('/Projects')).status).toBe(403);
  });

  test('a disabled account, and a revoked token, are refused at once', async () => {
    const r = await request(app).post('/api/tokens').set('Authorization', asSession(PAT)).send({ name: 'Old', scope: 'write' });
    expect((await dav(r.body.token).propfind('/')).status).toBe(207);
    await request(app).delete(`/api/tokens/${r.body.id}`).set('Authorization', asSession(PAT)).expect(200);
    expect((await dav(r.body.token).propfind('/')).status).toBe(401);
    await db.query('UPDATE user_roles SET disabled_at = NOW() WHERE user_id = $1', [PAT.id]);
    expect((await dav(tokens.pat).propfind('/')).status).toBe(403);
  });

  test('the pieces: paths, drive names, housekeeping names', () => {
    const { splitPath, isJunk, keepsName } = require('../../routes/dav')._forTests;
    expect(splitPath('/')).toEqual({ libraryName: null, path: '' });
    expect(splitPath('/Projects')).toEqual({ libraryName: 'Projects', path: '' });
    expect(splitPath('/Projects/Reports/q1%20final.txt/')).toEqual({ libraryName: 'Projects', path: 'Reports/q1 final.txt' });
    expect(splitPath('/Projects/../Other')).toBeNull();
    expect(splitPath('/Projects/%zz')).toBeNull();
    for (const n of ['.DS_Store', 'a/.DS_Store', 'a/._b.txt', 'Thumbs.db', 'x/desktop.ini', '~$doc.docx', '.~lock.doc.odt#', '.Trashes']) expect(isJunk(n)).toBe(true);
    for (const n of ['notes.txt', 'a/DS_Store', 'Thumbs.db.txt', '_b.txt']) expect(isJunk(n)).toBe(false);
    expect(keepsName('q1 final-v2_a.txt')).toBe(true);
    expect(keepsName('Smith & Co.txt')).toBe(false);
    expect(keepsName('café.txt')).toBe(false);
  });
});

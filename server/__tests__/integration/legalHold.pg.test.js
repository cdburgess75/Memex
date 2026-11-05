'use strict';
// Legal holds and retention against a REAL, THROWAWAY Postgres, through the real routers:
// a held document survives every way of deleting, purging, replacing or moving it (the
// app's routes, the public API, the drive at /dav, the trash sweeper, the disposal job),
// the answer is 423 LEGAL_HOLD every time, a library's minimum keeps its files out of the
// purge, and the disposal job notices, waits, and respects both.
//
// It DROPS AND RECREATES THE WHOLE public SCHEMA, so it refuses to run unless the
// database name contains "test":
//
//   MEMEX_TEST_PG_URL=postgres://user:pass@localhost:5432/memex_hold_test \
//     npx jest --runInBand integration/legalHold.pg
process.env.LINK_UPLOAD_TMP = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'depot-hold-pg-'));
const fs = require('fs');
const path = require('path');

const PG = process.env.MEMEX_TEST_PG_URL;
const suite = PG ? describe : describe.skip;
if (PG) jest.setTimeout(180000);

jest.mock('jsonwebtoken');
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn(() => ({ getSigningKey: async () => ({ getPublicKey: () => 'k' }) })) }));
const mockBlobs = new Map();
jest.mock('../../lib/storage', () => ({
  upload: jest.fn(async (p, buf) => { mockBlobs.set(p, Buffer.from(buf)); }),
  uploadStream: jest.fn(async (p, readable) => { const b = []; for await (const c of readable) b.push(c); const buf = Buffer.concat(b); mockBlobs.set(p, buf); return { size: buf.length }; }),
  download: jest.fn(async (p) => { if (!mockBlobs.has(p)) throw new Error('no such blob ' + p); return mockBlobs.get(p); }),
  downloadStream: jest.fn(async (p) => { const buf = mockBlobs.get(p) || Buffer.alloc(0); return { stream: require('stream').Readable.from([buf]), length: buf.length, totalSize: buf.length }; }),
  del: jest.fn(async (p) => { mockBlobs.delete(p); }),
  copy: jest.fn(async (from, to) => { if (!mockBlobs.has(from)) throw new Error('no such blob ' + from); mockBlobs.set(to, mockBlobs.get(from)); }),
  isLocalProvider: jest.fn(async () => true), getUrl: jest.fn(async () => 'http://x/url'), localBase: jest.fn(async () => require('os').tmpdir()), validateLocalToken: jest.fn(),
}));
const mockNotices = [];
jest.mock('../../lib/notifications', () => ({ create: jest.fn(async (n) => { mockNotices.push(n); return { id: 1 }; }) }));
jest.mock('../../lib/emailEvents', () => ({ send: jest.fn(async () => ({})) }));
jest.mock('../../lib/textExtraction', () => ({ extractText: jest.fn(async (buf) => buf.toString('utf8').slice(0, 1000)) }));

const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ADMIN = { id: U(1), email: 'admin@firm.test', role: 'admin' };
const DAVE = { id: U(2), email: 'dave@firm.test', role: 'contributor' };
const LIB = U(50), LIB2 = U(51);
const D = { held: U(20), sibling: U(21), elsewhere: U(22), trashedHeld: U(23), trashedYoung: U(24), trashedOld: U(25), stale: U(26), staleHeld: U(27), fresh: U(28), notes: U(29) };
const basic = (tok) => 'Basic ' + Buffer.from(`anyone:${tok}`).toString('base64');

suite('a legal hold keeps a file, whatever tries to remove it', () => {
  let db, request, app, jwt, retention, token;
  const reset = () => db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const as = (p) => { jwt.verify.mockReturnValue({ sub: p.id, email: p.email, email_verified: true }); return request(app); };
  const authed = (r) => r.set('Authorization', 'Bearer t');
  const row = (id) => db.queryOne('SELECT id, name, library_id, deleted_at, deleted_by_email, storage_path, content_hash, disposal_notice_at FROM documents WHERE id = $1', [id]);
  const events = (type, id = null) => db.query('SELECT detail, actor_email FROM document_events WHERE event_type = $1 AND document_id IS NOT DISTINCT FROM $2 ORDER BY chain_seq', [type, id]);
  const insert = (id, name, { lib = LIB, deletedDaysAgo = null, ageDays = 10, modifiedDaysAgo = null, text = false } = {}) => db.query(
    `INSERT INTO documents (id, name, size, mime_type, storage_path, uploaded_by, uploaded_by_email, library_id, library_scoped, created_at, modified_at, deleted_at, content_hash)
     VALUES ($1::uuid, $2, 5, $8, $3, $4, $5, $6, true, NOW() - make_interval(days => $7::int),
             CASE WHEN $9::int IS NULL THEN NULL ELSE NOW() - make_interval(days => $9::int) END,
             CASE WHEN $10::int IS NULL THEN NULL ELSE NOW() - make_interval(days => $10::int) END, 'h-' || $1::text)`,
    [id, name, `store/${id}`, DAVE.id, DAVE.email, lib, ageDays, text ? 'text/plain' : 'application/pdf', modifiedDaysAgo, deletedDaysAgo]
  ).then(() => mockBlobs.set(`store/${id}`, Buffer.from('bytes')));
  const expectHeld = (r) => { expect(r.status).toBe(423); expect(r.body.code).toBe('LEGAL_HOLD'); expect(r.body.error).toMatch(/legal hold/); };

  beforeAll(async () => {
    const dbName = decodeURIComponent(new URL(PG).pathname.slice(1));
    if (!/test/i.test(dbName)) throw new Error(`refusing to run: "${dbName}" does not look like a throwaway test database`);
    process.env.DATABASE_URL = PG;
    db = require('../../lib/db');
    await reset();
    await db.query(fs.readFileSync(path.join(__dirname, '../../../postgres/init/01_schema.sql'), 'utf8'));
    await require('../../lib/migrations').run();
    for (const p of [ADMIN, DAVE]) await db.query('INSERT INTO user_roles (user_id, email, role, verified_email) VALUES ($1, $2, $3, $2)', [p.id, p.email, p.role]);
    await db.query('INSERT INTO libraries (id, name, owner_id, owner_email) VALUES ($1, $2, $3, $4), ($5, $6, $3, $4)', [LIB, 'Clients', DAVE.id, DAVE.email, LIB2, 'Archive']);
    await insert(D.held, 'Clients/Smith/2017 return.pdf');
    await insert(D.sibling, 'Clients/Smith/notes.txt', { text: true });
    await insert(D.elsewhere, 'Clients/Jones/2017 return.pdf');
    await insert(D.trashedHeld, 'Clients/Smith/old draft.pdf', { deletedDaysAgo: 400, ageDays: 500 });
    await insert(D.trashedYoung, 'Clients/Jones/young.pdf', { deletedDaysAgo: 400, ageDays: 500 });
    await insert(D.trashedOld, 'Clients/Jones/ancient.pdf', { deletedDaysAgo: 400, ageDays: 2000 });
    await insert(D.notes, 'Clients/Smith/memo.txt', { text: true });
    jwt = require('jsonwebtoken'); jwt.decode.mockReturnValue({ header: { kid: 'k' } });
    request = require('supertest');
    retention = require('../../lib/retention');
    const express = require('express');
    app = express();
    const RAW = /^\/dav(\/|$)|^\/api\/v1\/files\/[^/]+\/content$|^\/api\/files\/upload-stream/;
    app.use(express.json({ limit: '1mb', type: (req) => !RAW.test(req.path) && /^application\/(.+\+)?json/i.test(String(req.headers['content-type'] || '')) }));
    app.use('/api/files', require('../../routes/files'));
    app.use('/api/libraries', require('../../routes/libraries'));
    app.use('/api/admin', require('../../routes/admin'));
    app.use('/api/tokens', require('../../routes/tokens'));
    app.use('/api/v1', require('../../routes/v1'));
    app.use('/dav', require('../../routes/dav'));
    token = (await authed(as(DAVE).post('/api/tokens')).send({ name: 'Laptop', scope: 'write' })).body.token;
  });
  afterAll(async () => { try { await reset(); } catch { /* best effort */ } try { await db.end(); } catch { /* closed */ } });

  let holdId;
  test('an administrator places a hold on a folder, with a reason, and it is in the record', async () => {
    expect((await authed(as(DAVE).post('/api/admin/legal-holds')).send({ scope: 'folder', library_id: LIB, folder_path: 'Clients/Smith', reason: 'Smith v. Jones' })).status).toBe(403);
    const r = await authed(as(ADMIN).post('/api/admin/legal-holds')).send({ scope: 'folder', library_id: LIB, folder_path: 'Clients/Smith', reason: 'Smith v. Jones' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ scope: 'folder', folder_path: 'Clients/Smith', library_name: 'Clients', where: 'folder “Clients/Smith” in “Clients”', placed_by: ADMIN.email, active: true });
    holdId = r.body.id;
    expect((await events('hold_placed'))[0]).toMatchObject({ actor_email: ADMIN.email, detail: expect.stringMatching(/Smith v\. Jones/) });
    expect((await authed(as(ADMIN).post('/api/admin/legal-holds')).send({ scope: 'folder', library_id: LIB, folder_path: 'Clients/Smith', reason: 'again' })).status).toBe(409);
  });

  test('the lists say what is held: each file, the folder\'s holds, and the library', async () => {
    const files = (await authed(as(DAVE).get(`/api/files?library=${LIB}`))).body;
    const held = Object.fromEntries(files.map(f => [f.id, f.held]));
    expect(held[D.held]).toBe(true); expect(held[D.sibling]).toBe(true); expect(held[D.elsewhere]).toBe(false);
    const holds = (await authed(as(DAVE).get(`/api/libraries/${LIB}/holds`))).body;
    expect(holds.map(h => h.folder_path)).toEqual(['Clients/Smith']);
    const lib = (await authed(as(DAVE).get('/api/libraries'))).body.find(l => l.id === LIB);
    expect(lib).toMatchObject({ held: false, has_holds: true, retention: { min_years: null, dispose_years: null } });
    const trash = (await authed(as(DAVE).get('/api/files/trash'))).body;
    expect(trash.find(f => f.id === D.trashedHeld).held).toBe(true);
    expect(trash.find(f => f.id === D.trashedYoung).held).toBe(false);
  });

  test('deleting: the app, the public API and the drive all answer 423 LEGAL_HOLD, and the file stays', async () => {
    expectHeld(await authed(as(ADMIN).delete(`/api/files/${D.held}`)));
    expectHeld(await request(app).delete(`/api/v1/files/${D.held}`).set('Authorization', `Bearer ${token}`));
    expectHeld(await request(app).delete('/dav/Clients/Clients/Smith/2017 return.pdf').set('Authorization', basic(token)));
    expect((await row(D.held)).deleted_at).toBeNull();
    // a file outside the held folder deletes as before
    expect((await authed(as(DAVE).delete(`/api/files/${D.elsewhere}`))).status).toBe(200);
    expect((await authed(as(DAVE).post(`/api/files/${D.elsewhere}/restore`))).status).toBe(200);
  });

  test('replacing the bytes: refused from every path, and the bytes are untouched', async () => {
    const before = await row(D.held);
    expectHeld(await authed(as(DAVE).post('/api/files/upload-stream')).set('x-replace-id', D.held).set('Content-Type', 'application/pdf').send(Buffer.from('new bytes')));
    expectHeld(await request(app).put(`/api/v1/files/${D.held}/content`).set('Authorization', `Bearer ${token}`).set('Content-Type', 'application/pdf').send(Buffer.from('new bytes')));
    // the drive saves over a file by moving a temporary one onto it
    expect((await request(app).put('/dav/Clients/Clients/Smith/draft-temp.pdf').set('Authorization', basic(token)).set('Content-Type', 'application/pdf').send(Buffer.from('temp'))).status).toBe(201);
    expectHeld(await request(app).move('/dav/Clients/Clients/Smith/draft-temp.pdf').set('Authorization', basic(token)).set('Destination', '/dav/Clients/Clients/Smith/2017 return.pdf'));
    const after = await row(D.held);
    expect(after.storage_path).toBe(before.storage_path);
    expect(mockBlobs.get(after.storage_path).toString()).toBe('bytes');
    // an edit in the app keeps working: what it replaces is kept as a version, never pruned
    const e = await authed(as(DAVE).put(`/api/files/${D.notes}/content`)).send({ content: 'a new line' });
    expect(e.status).toBe(200);
  });

  test('moving out: a rename into another folder, a move to another library, and the folder itself', async () => {
    expectHeld(await authed(as(DAVE).put(`/api/files/${D.held}/rename`)).send({ name: 'Clients/Jones/2017 return.pdf' }));
    expectHeld(await authed(as(DAVE).post('/api/files/library-transfer')).send({ ids: [D.held], libraryId: LIB2, mode: 'move' }));
    expectHeld(await request(app).post(`/api/v1/files/${D.held}/move`).set('Authorization', `Bearer ${token}`).send({ library_id: LIB2 }));
    expectHeld(await request(app).move('/dav/Clients/Clients/Smith/2017 return.pdf').set('Authorization', basic(token)).set('Destination', '/dav/Clients/Clients/Jones/2017 return.pdf'));
    // a rename in place keeps the file where it is, and is allowed
    expect((await authed(as(DAVE).put(`/api/files/${D.held}/rename`)).send({ name: 'Clients/Smith/2017 return final.pdf' })).status).toBe(200);
    expect((await row(D.held)).name).toBe('Clients/Smith/2017 return final.pdf');
    // the folder: its hold is keyed by its name, so it may not be renamed, moved or deleted
    expectHeld(await authed(as(DAVE).post('/api/files/folder/rename')).send({ path: 'Clients/Smith', name: 'Smyth', source_library_id: LIB }));
    expectHeld(await authed(as(DAVE).post('/api/files/folder/reparent')).send({ path: 'Clients/Smith', target: 'Clients/Jones', source_library_id: LIB }));
    expectHeld(await authed(as(DAVE).post('/api/files/folder/move')).send({ path: 'Clients/Smith', library_id: LIB2, source_library_id: LIB }));
    expectHeld(await authed(as(DAVE).post('/api/files/folder/delete')).send({ path: 'Clients/Smith', source_library_id: LIB }));
    expectHeld(await request(app).move('/dav/Clients/Clients/Smith').set('Authorization', basic(token)).set('Destination', '/dav/Clients/Clients/Smyth'));
    expectHeld(await request(app).delete('/dav/Clients/Clients/Smith').set('Authorization', basic(token)));
    expect((await db.queryOne('SELECT count(*)::int AS n FROM documents WHERE library_id = $1 AND starts_with(name, $2) AND deleted_at IS NULL', [LIB, 'Clients/Smith/'])).n).toBe(4);   // the three seeded files and the drive's temp file from the replace test
    // a folder with nothing held under it still moves
    expect((await authed(as(DAVE).post('/api/files/folder/rename')).send({ path: 'Clients/Jones', name: 'Jones and Co', source_library_id: LIB })).status).toBe(200);
    expect((await authed(as(DAVE).post('/api/files/folder/rename')).send({ path: 'Clients/Jones and Co', name: 'Jones', source_library_id: LIB })).status).toBe(200);
  });

  test('purging: an administrator, a folder\'s "delete for good", and the sweeper all leave a held file in the Trash', async () => {
    expectHeld(await authed(as(ADMIN).delete(`/api/files/${D.trashedHeld}/purge`)));
    expectHeld(await authed(as(DAVE).post('/api/files/folder/purge-trashed')).send({ path: 'Clients/Smith', library_id: LIB }));
    const swept = await require('../../lib/trashSweeper').sweepOnce({ days: 30 });
    expect(swept.documentsPurged).toBe(2);   // the two unheld old files in Clients/Jones go; the held one stays
    expect(await row(D.trashedHeld)).not.toBeNull();
    expect(await row(D.trashedOld)).toBeNull();
    expect(await row(D.trashedYoung)).toBeNull();
  });

  test('a library\'s minimum keeps young files out of the purge, by hand or by the sweeper', async () => {
    await insert(D.trashedYoung, 'Clients/Jones/young again.pdf', { deletedDaysAgo: 400, ageDays: 500 });
    await insert(D.trashedOld, 'Clients/Jones/ancient again.pdf', { deletedDaysAgo: 400, ageDays: 2000 });
    expect((await authed(as(DAVE).put(`/api/libraries/${LIB}/retention`)).send({ min_years: 3 })).body).toMatchObject({ min_years: 3, dispose_years: null, set_by: DAVE.email });
    expect((await events('retention_policy_set'))[0].detail).toMatch(/"Clients" · keep at least 3 years/);
    const r = await authed(as(ADMIN).delete(`/api/files/${D.trashedYoung}/purge`));
    expect(r.status).toBe(423); expect(r.body.code).toBe('RETENTION_MINIMUM'); expect(r.body.error).toMatch(/at least 3 years/);
    expect((await authed(as(DAVE).post('/api/files/folder/purge-trashed')).send({ path: 'Clients/Jones', library_id: LIB })).body).toEqual({ ok: true, count: 1, kept: 1 });   // the ancient one went, the young one is kept
    expect(await row(D.trashedYoung)).not.toBeNull();
    expect(await row(D.trashedOld)).toBeNull();
    expect((await require('../../lib/trashSweeper').sweepOnce({ days: 30 })).documentsPurged).toBe(0);
    expect(await row(D.trashedYoung)).not.toBeNull();
    expect((await authed(as(ADMIN).delete(`/api/files/${D.trashedYoung}/purge`).set('x-note', 'still young'))).status).toBe(423);
  });

  test('the disposal job: a notice first, then the Trash, never for what is held or under the minimum', async () => {
    await insert(D.stale, 'Clients/Jones/2015 workpapers.pdf', { ageDays: 1500, modifiedDaysAgo: 1100 });     // untouched 3 years, 4 years old
    await insert(D.staleHeld, 'Clients/Smith/2015 workpapers.pdf', { ageDays: 1500, modifiedDaysAgo: 1100 }); // the same, under the folder hold
    await insert(D.fresh, 'Clients/Jones/2026 workpapers.pdf', { ageDays: 60, modifiedDaysAgo: 30 });
    expect((await authed(as(DAVE).put(`/api/libraries/${LIB}/retention`)).send({ min_years: 6, dispose_years: 2 })).status).toBe(400);   // cannot dispose before the minimum
    expect((await authed(as(DAVE).put(`/api/libraries/${LIB}/retention`)).send({ min_years: 2, dispose_years: 2 })).status).toBe(200);
    mockNotices.length = 0;
    expect(await retention.noticeOnce()).toEqual({ noticed: 1 });
    expect(mockNotices.map(n => [n.type, n.userEmail, n.refId])).toEqual([['retention_notice', DAVE.email, D.stale]]);
    expect(mockNotices[0].title).toMatch(/“2015 workpapers.pdf” will move to the Trash on/);
    expect((await row(D.stale)).disposal_notice_at).not.toBeNull();
    expect((await row(D.staleHeld)).disposal_notice_at).toBeNull();   // nothing is said about a held file: it is going nowhere
    expect(await retention.noticeOnce()).toEqual({ noticed: 0 });      // once
    // disposal waits 30 days after the notice
    expect(await retention.disposeOnce()).toEqual({ disposed: 0 });
    await db.query('UPDATE documents SET disposal_notice_at = NOW() - make_interval(days => 40) WHERE id = ANY($1::uuid[])', [[D.stale, D.staleHeld]]);
    // ...and is refused by the library's minimum while the file is younger than it
    await db.query('UPDATE libraries SET retention_min_years = 10 WHERE id = $1', [LIB]);
    expect(await retention.disposeOnce()).toEqual({ disposed: 0 });
    await db.query('UPDATE libraries SET retention_min_years = 2 WHERE id = $1', [LIB]);
    mockNotices.length = 0;
    expect(await retention.disposeOnce()).toEqual({ disposed: 1 });
    const gone = await row(D.stale);
    expect(gone.deleted_at).not.toBeNull();
    expect(gone.deleted_by_email).toBe('system@retention');
    expect((await row(D.staleHeld)).deleted_at).toBeNull();
    expect((await row(D.fresh)).deleted_at).toBeNull();
    expect((await events('disposed', D.stale))[0]).toMatchObject({ actor_email: 'system@retention', detail: expect.stringMatching(/retention policy of "Clients": no changes for 2 years/) });
    expect(mockNotices.map(n => n.type)).toEqual(['retention_disposed']);
    // restored, it is an ordinary file again
    expect((await authed(as(DAVE).post(`/api/files/${D.stale}/restore`))).status).toBe(200);
  });

  test('a hold on one file, on a whole library, and what the Compliance section says', async () => {
    const one = await authed(as(ADMIN).post('/api/admin/legal-holds')).send({ scope: 'document', document_id: D.elsewhere, reason: 'subpoena' });
    expect(one.status).toBe(200);
    expect(one.body.where).toBe('file “Clients/Jones/2017 return.pdf” in “Clients”');
    expect((await events('hold_placed', D.elsewhere)).length).toBe(1);
    expectHeld(await authed(as(DAVE).delete(`/api/files/${D.elsewhere}`)));
    const whole = await authed(as(ADMIN).post('/api/admin/legal-holds')).send({ scope: 'library', library_id: LIB2, reason: 'audit' });
    expect(whole.status).toBe(200);
    expect((await authed(as(DAVE).get('/api/libraries'))).body.find(l => l.id === LIB2).held).toBe(true);
    const list = (await authed(as(ADMIN).get('/api/admin/legal-holds'))).body;
    expect(list.active.map(h => h.scope).sort()).toEqual(['document', 'folder', 'library']);
    const cmp = (await authed(as(ADMIN).get('/api/admin/compliance'))).body;
    const sg = cmp.frameworks.find(f => f.id === 'safeguards');
    const lh = sg.controls.find(c => c.id === 'legal_hold');
    expect(lh.ready).toBe(true);
    expect(lh.evidence).toMatch(/3 placed so far, 3 open/);
    expect(lh.cite).toBe('314.4(c)(6)');
    const rp = sg.controls.find(c => c.id === 'retention_policy');
    expect(rp.ready).toBe(false);   // Archive has no minimum
    expect(rp.evidence).toMatch(/“Archive”/);
    expect((await authed(as(DAVE).put(`/api/libraries/${LIB2}/retention`)).send({ min_years: 6 })).status).toBe(200);
    const again = (await authed(as(ADMIN).get('/api/admin/compliance'))).body.frameworks.find(f => f.id === 'safeguards').controls.find(c => c.id === 'retention_policy');
    expect(again.ready).toBe(true);
    expect(again.evidence).toMatch(/“Archive” keep at least 6 years; “Clients” keep at least 2 years; move to the trash after 2 years without changes/);
    const report = await authed(as(ADMIN).get('/api/admin/compliance/packet.html'));
    expect(report.status).toBe(200);
    expect(report.text).toMatch(/Section 7<\/small>Retention and legal holds/);
    expect(report.text).toMatch(/Smith v\. Jones/);
  });

  test('releasing a hold needs a note, is in the record, and the file can then go', async () => {
    expect((await authed(as(DAVE).delete(`/api/admin/legal-holds/${holdId}`)).send({ note: 'x' })).status).toBe(403);
    expect((await authed(as(ADMIN).delete(`/api/admin/legal-holds/${holdId}`)).send({})).status).toBe(400);
    const r = await authed(as(ADMIN).delete(`/api/admin/legal-holds/${holdId}`)).send({ note: 'Matter settled 1 Dec' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ active: false, released_by: ADMIN.email, release_note: 'Matter settled 1 Dec' });
    expect((await events('hold_released'))[0].detail).toMatch(/Matter settled 1 Dec/);
    expect((await authed(as(ADMIN).delete(`/api/admin/legal-holds/${holdId}`)).send({ note: 'again' })).status).toBe(404);
    expect((await authed(as(DAVE).delete(`/api/files/${D.held}`))).status).toBe(200);
    expect((await authed(as(ADMIN).delete(`/api/files/${D.trashedHeld}/purge`))).status).toBe(423);   // the minimum still applies: 500 days old, kept 2 years
    expect((await authed(as(DAVE).get(`/api/libraries/${LIB}/holds`))).body.map(h => h.scope)).toEqual(['document']);   // the one on a single file stays
    expect((await require('../../lib/auditLog').verify()).ok).toBe(true);   // every hold, release, disposal and policy is in one intact chain
  });
});

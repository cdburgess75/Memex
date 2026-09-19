'use strict';
process.env.LINK_UPLOAD_TMP = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'depot-ext-pg-'));
// Sending a folder to a person, and that person adding files to it -- through the WHOLE file
// router, against a REAL, THROWAWAY Postgres. Every earlier test of this mounted the folder
// router on its own over a mocked database, and so missed two things that only exist when
// the real pieces meet: a route in the parent router that swallowed /folder/send, and a
// query Postgres refused to plan for an admin. DROPS AND RECREATES the public schema; refuses
// to run unless the database name contains "test".
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PG = process.env.MEMEX_TEST_PG_URL;
const suite = PG ? describe : describe.skip;
if (PG) jest.setTimeout(120000);

jest.mock('jsonwebtoken');
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn(() => ({ getSigningKey: async () => ({ getPublicKey: () => 'k' }) })) }));
jest.mock('../../lib/auditLog', () => ({ append: jest.fn(async () => ({})) }));
const mockBlobs = new Map();
jest.mock('../../lib/storage', () => ({
  upload: jest.fn(async (p, buf) => { mockBlobs.set(p, Buffer.from(buf)); }),
  uploadStream: jest.fn(async (p, readable) => { const b = []; for await (const c of readable) b.push(c); mockBlobs.set(p, Buffer.concat(b)); }),
  del: jest.fn(async (p) => { mockBlobs.delete(p); }), copy: jest.fn(async () => {}), download: jest.fn(async () => Buffer.alloc(0)),
  downloadStream: jest.fn(async () => ({ stream: require('stream').Readable.from([Buffer.from('bytes')]), length: 5 })),
  isLocalProvider: jest.fn(async () => false), getUrl: jest.fn(), localBase: jest.fn(), validateLocalToken: jest.fn(),
}));
jest.mock('../../lib/notifications', () => ({ create: jest.fn(async () => ({})) }));
jest.mock('../../lib/emailEvents', () => ({ send: jest.fn(async () => ({})) }));
// The email "fails", so the response hands back the link -- the only place its token exists.
jest.mock('../../lib/email', () => ({ sendMail: jest.fn(async () => ({ sent: false, reason: 'test' })), actingAs: (u) => ({ label: u.email, sendAs: u.email }) }));

suite('sending a folder, and files coming back, through the real router and a real database', () => {
  let db, request, app, jwt;
  const U = (n) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
  const OWNER = { id: U(1), email: 'owner@corp.test' }, MEMBER = { id: U(2), email: 'member@corp.test' }, ADMIN = { id: U(3), email: 'admin@corp.test' }, OTHER = { id: U(4), email: 'other@corp.test' };
  const LIB = U(50);
  const reset = () => db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');

  beforeAll(async () => {
    const dbName = decodeURIComponent(new URL(PG).pathname.slice(1));
    if (!/test/i.test(dbName)) throw new Error(`refusing to run: "${dbName}" does not look like a throwaway test database`);
    process.env.DATABASE_URL = PG;
    db = require('../../lib/db');
    await reset();
    await db.query(fs.readFileSync(path.join(__dirname, '../../../postgres/init/01_schema.sql'), 'utf8'));
    await require('../../lib/migrations').run();
    for (const [a, role] of [[OWNER, 'contributor'], [MEMBER, 'contributor'], [ADMIN, 'admin'], [OTHER, 'contributor']]) {
      await db.query('INSERT INTO user_roles (user_id, email, role, verified_email) VALUES ($1, $2, $3, $2)', [a.id, a.email, role]);
    }
    await db.query('INSERT INTO libraries (id, name, owner_id, owner_email) VALUES ($1, $2, $3, $4)', [LIB, 'Projects', OWNER.id, OWNER.email]);
    await db.query(`INSERT INTO library_grants (library_id, folder_path, subject_type, subject_email, permission, granted_by, granted_by_email) VALUES ($1, '', 'user', $2, 'write', $3, $4)`, [LIB, MEMBER.email, OWNER.id, OWNER.email]);
    await db.query(`INSERT INTO documents (name, size, mime_type, storage_path, uploaded_by, uploaded_by_email, library_id, library_scoped)
                    VALUES ('Intake/brief.pdf', 10, 'application/pdf', 'seed/brief', $1, $2, $3, true)`, [OWNER.id, OWNER.email, LIB]);
    jwt = require('jsonwebtoken'); jwt.decode.mockReturnValue({ header: { kid: 'k' } });
    request = require('supertest');
    const express = require('express');
    app = express(); app.use(express.json());
    app.use('/api/files', require('../../routes/files'));   // the WHOLE router, as the server mounts it
  });
  afterAll(async () => { try { await reset(); } catch { /* best effort */ } try { await db.end(); } catch { /* closed */ } });

  const as = (a) => { jwt.verify.mockReturnValue({ sub: a.id, email: a.email, email_verified: true }); return (r) => r.set('Authorization', 'Bearer t').set('x-library-id', LIB); };
  const tokenOf = (res) => res.body.results[0].url.split('/f/')[1];
  let token;

  test('a Read-Write member sends the folder: 200, one live link that may receive', async () => {
    const res = await as(MEMBER)(request(app).post('/api/files/folder/send')).send({ path: 'Intake', recipients: ['client@outside.test'], allowUpload: true });
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([expect.objectContaining({ to: 'client@outside.test', kind: 'link', sent: false, url: expect.stringContaining('/f/') })]);
    token = tokenOf(res);
    const row = await db.queryOne('SELECT live, allow_upload, library_id, folder_path, recipient_email FROM folder_share_links');
    expect(row).toMatchObject({ live: true, allow_upload: true, library_id: LIB, folder_path: 'Intake', recipient_email: 'client@outside.test' });
  });
  test('sending to a colleague makes a sign-in link, not an open one', async () => {
    const res = await as(MEMBER)(request(app).post('/api/files/folder/send')).send({ path: 'Intake', recipients: [OTHER.email] });
    expect(res.status).toBe(200); expect(res.body.results[0].kind).toBe('signin_link');
  });
  test.each([['the member who sent them', () => MEMBER, 2], ["the library's owner", () => OWNER, 2], ['an admin', () => ADMIN, 2], ['somebody else', () => OTHER, null]])('the link list answers for %s', async (_n, who, count) => {
    const res = await as(who())(request(app).get('/api/files/folder/links')).query({ path: 'Intake' });
    if (count === null) { expect([200, 403, 404]).toContain(res.status); if (res.status === 200) expect(res.body.shares).toEqual([]); return; }
    expect(res.status).toBe(200);
    expect(res.body.shares).toHaveLength(count);
    expect(res.body.shares.find(s => s.recipient_email === 'client@outside.test')).toMatchObject({ live: true, allow_upload: true, created_by_email: MEMBER.email });
  });
  test('the recipient opens the page data, and adds a file in pieces: it lands in the folder, owned by the sender', async () => {
    const info = await request(app).get(`/api/files/folder/share/${token}/info`);
    expect(info.status).toBe(200); expect(info.body).toMatchObject({ name: 'Intake', allowUpload: true, live: true }); expect(info.body.files.map(f => f.name)).toEqual(['brief.pdf']);
    const data = crypto.randomBytes(70000), id = crypto.randomBytes(12).toString('hex');
    const piece = (offset, body) => request(app).post(`/api/files/folder/share/${token}/upload`).set('Content-Type', 'application/octet-stream')
      .set('X-Upload-Id', id).set('X-Upload-Offset', String(offset)).set('X-Upload-Total', String(data.length)).set('X-Upload-Name', encodeURIComponent('signed contract.pdf')).send(body);
    expect((await piece(0, data.subarray(0, 30000))).body).toEqual({ ok: true, received: 30000 });
    const last = await piece(30000, data.subarray(30000));
    expect(last.status).toBe(200); expect(last.body).toMatchObject({ done: true, name: 'signed contract.pdf' });
    const doc = await db.queryOne(`SELECT name, size, library_id, uploaded_by, storage_path FROM documents WHERE name = 'Intake/signed contract.pdf'`);
    expect(doc).toMatchObject({ library_id: LIB, uploaded_by: MEMBER.id }); expect(Number(doc.size)).toBe(70000);
    expect(mockBlobs.get(doc.storage_path).equals(data)).toBe(true);
    expect(await db.queryOne('SELECT upload_count, upload_bytes::int AS b FROM folder_share_links WHERE allow_upload')).toEqual({ upload_count: 1, b: 70000 });
    // and the recipient sees it, because the link is live
    expect((await request(app).get(`/api/files/folder/share/${token}/info`)).body.files.map(f => f.name).sort()).toEqual(['brief.pdf', 'signed contract.pdf']);
  });
  test('the old single-request upload still lands too', async () => {
    const res = await request(app).post(`/api/files/folder/share/${token}/upload`).attach('file', Buffer.from('hello'), 'note.txt');
    expect(res.status).toBe(200);
    expect(await db.queryOne(`SELECT 1 AS ok FROM documents WHERE name = 'Intake/note.txt' AND deleted_at IS NULL`)).toEqual({ ok: 1 });
  });
  test("the library's owner ends the member's link; the recipient is then shut out, uploads included", async () => {
    const list = await as(OWNER)(request(app).get('/api/files/folder/links')).query({ path: 'Intake' });
    const id = list.body.shares.find(s => s.recipient_email === 'client@outside.test').id;
    expect((await as(OTHER)(request(app).delete(`/api/files/folder/links/${id}`))).status).toBe(404); // not somebody else
    expect((await as(OWNER)(request(app).delete(`/api/files/folder/links/${id}`))).status).toBe(200);
    expect((await request(app).get(`/api/files/folder/share/${token}/info`)).status).toBe(404);
    expect((await request(app).post(`/api/files/folder/share/${token}/upload`).attach('file', Buffer.from('x'), 'late.txt')).status).toBe(404);
  });
  test('an ordinary file is still sent through its own route (the two "send"s do not cross)', async () => {
    const f = await db.queryOne(`SELECT id FROM documents WHERE name = 'Intake/brief.pdf'`);
    const res = await as(OWNER)(request(app).post(`/api/files/${f.id}/send`)).send({ recipients: ['client@outside.test'], permission: 'read' });
    expect(res.status).toBe(200);
  });
});

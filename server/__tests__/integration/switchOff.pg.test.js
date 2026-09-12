'use strict';
// Switching somebody off, against a REAL, THROWAWAY Postgres.
//
// Depot had no "off". Demoting to viewer still let somebody read everything they had ever
// been given; deleting their row was worse, because the next valid token put it straight
// back as a contributor with their libraries intact. Now an account can be switched off
// and back on, and while it is off it is NOBODY: sign-in is refused, and resolveActor --
// the one place the rest of the system asks who an account really is -- answers with
// nothing, which is what stops their links and anything else acting on their behalf.
//
// What it deliberately does NOT do is take anything away from them. What they own, what
// they were shared and what they uploaded are somebody's decisions, not a side effect.
//
//   MEMEX_TEST_PG_URL=postgres://user:pass@localhost:5432/memex_piece5_test \
//     npx jest --runInBand integration/switchOff.pg
const fs = require('fs');
const path = require('path');

const PG = process.env.MEMEX_TEST_PG_URL;
const suite = PG ? describe : describe.skip;
if (PG) jest.setTimeout(180000);

jest.mock('jsonwebtoken');
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn(() => ({ getSigningKey: async () => ({ getPublicKey: () => 'k' }) })) }));
jest.mock('../../lib/auditLog', () => ({ append: jest.fn(async () => ({})) }));
jest.mock('../../lib/storage', () => ({ upload: jest.fn(async () => {}), del: jest.fn(async () => {}), download: jest.fn(async () => Buffer.alloc(0)) }));

const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const LIB = U(90);
const ADMIN = { id: U(1), email: 'admin@acme.test', role: 'admin' };
const ADMIN2 = { id: U(2), email: 'admin2@acme.test', role: 'admin' };
const LEAVER = { id: U(3), email: 'leaver@acme.test', role: 'contributor' };

suite('switching somebody off', () => {
  let db, request, app, jwt, documentAccess;
  const reset = () => db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');

  beforeAll(async () => {
    const dbName = decodeURIComponent(new URL(PG).pathname.slice(1));
    if (!/test/i.test(dbName)) throw new Error(`refusing to run: "${dbName}" does not look like a throwaway test database`);
    process.env.DATABASE_URL = PG;
    db = require('../../lib/db');
    await reset();
    await db.query(fs.readFileSync(path.join(__dirname, '../../../postgres/init/01_schema.sql'), 'utf8'));
    await require('../../lib/migrations').run();
    documentAccess = require('../../lib/documentAccess');
    jwt = require('jsonwebtoken');
    jwt.decode.mockReturnValue({ header: { kid: 'k' } });
    request = require('supertest');
    const express = require('express');
    app = express();
    app.use(express.json());
    app.use('/api/admin', require('../../routes/admin'));
    app.use('/api/libraries', require('../../routes/libraries'));
  });

  afterAll(async () => {
    try { await reset(); } catch { /* best effort */ }
    try { await db.end(); } catch { /* already closed */ }
  });

  const as = (p) => { jwt.verify.mockReturnValue({ sub: p.id, email: p.email, email_verified: true }); return request(app); };
  const authed = (r) => r.set('Authorization', 'Bearer t');
  const setOff = (who, target, body) => authed(as(who).put(`/api/admin/users/${target.id}/disabled`)).send(body);
  const departure = (who, target) => authed(as(who).get(`/api/admin/users/${target.id}/departure`));
  const one = async (sql, params) => (await db.query(sql, params))[0];
  const libraries2 = () => require('../../lib/libraries');

  async function fixture() {
    await db.query('TRUNCATE library_grants, document_share_links, folder_share_links, groups, group_members, documents, libraries, user_roles CASCADE');
    for (const p of [ADMIN, ADMIN2, LEAVER]) {
      await db.query('INSERT INTO user_roles (user_id, email, role, verified_email) VALUES ($1, $2, $3, $2)', [p.id, p.email, p.role]);
    }
    await db.query('INSERT INTO libraries (id, name, owner_id, owner_email) VALUES ($1, $2, $3, $4)', [LIB, 'Clients', LEAVER.id, LEAVER.email]);
  }

  test('an account can be switched off and back on, and the row remembers when and why', async () => {
    await fixture();
    const off = await setOff(ADMIN, LEAVER, { disabled: true, reason: 'left the company' });
    expect(off.status).toBe(200);
    expect(off.body.disabled_at).toEqual(expect.any(String));
    expect(off.body.disabled_reason).toBe('left the company');

    const on = await setOff(ADMIN, LEAVER, { disabled: false });
    expect(on.status).toBe(200);
    // switching back on clears all three: the row carries no stale reason
    expect([on.body.disabled_at, on.body.disabled_reason]).toEqual([null, null]);
  });

  test('while they are off, the account is nobody -- so is everything acting on their behalf', async () => {
    await fixture();
    expect(await documentAccess.resolveActor(LEAVER.id)).toMatchObject({ email: LEAVER.email });
    await setOff(ADMIN, LEAVER, { disabled: true });
    // resolveActor is the one place the rest of the system asks who an account is: their
    // public links, editing sessions and upload notices all die from this single answer
    expect(await documentAccess.resolveActor(LEAVER.id)).toBeNull();
    // ...and a token issued before they left is refused at the door
    const me = await authed(as(LEAVER).get('/api/admin/users'));
    expect([me.status, me.body.code]).toEqual([403, 'ACCOUNT_DISABLED']);
    await setOff(ADMIN, LEAVER, { disabled: false });
    expect(await documentAccess.resolveActor(LEAVER.id)).toMatchObject({ email: LEAVER.email });
  });

  test('a refused sign-in does not quietly undo the switch', async () => {
    await fixture();
    await setOff(ADMIN, LEAVER, { disabled: true });
    const before = await one('SELECT role, disabled_at, verified_email FROM user_roles WHERE user_id = $1', [LEAVER.id]);
    const libsBefore = (await one('SELECT count(*)::int AS n FROM libraries', [])).n;
    await authed(as(LEAVER).get('/api/admin/users'));            // refused
    const after = await one('SELECT role, disabled_at, verified_email FROM user_roles WHERE user_id = $1', [LEAVER.id]);
    expect(after).toEqual(before);                                // no role rewritten, no address recorded
    expect((await one('SELECT count(*)::int AS n FROM libraries', [])).n).toBe(libsBefore); // no personal library made
  });

  test('nobody can switch themselves off, or take the last administrator away', async () => {
    await fixture();
    const self = await setOff(ADMIN, ADMIN, { disabled: true });
    expect(self.status).toBe(400);
    expect(self.body.error).toMatch(/your own account/);
    // ADMIN2 is the only other administrator: switch them off, and ADMIN is the last one
    expect((await setOff(ADMIN, ADMIN2, { disabled: true })).status).toBe(200);
    const last = await setOff(ADMIN2, ADMIN, { disabled: true });
    expect([last.status, last.body.code]).toEqual([403, 'ACCOUNT_DISABLED']); // ADMIN2 is off, so cannot ask
    // and with ADMIN2 back, the last-administrator rule still holds for the other one
    await db.query('UPDATE user_roles SET disabled_at = NULL WHERE user_id = $1', [ADMIN2.id]);
    await db.query("UPDATE user_roles SET role = 'contributor' WHERE user_id = $1", [ADMIN2.id]);
    const alone = await setOff(ADMIN2, ADMIN, { disabled: true });
    expect(alone.status).toBe(403); // a contributor cannot reach the route at all
  });

  test('switching off takes nothing away from them: it is a switch, not a clear-out', async () => {
    await fixture();
    await db.query(
      `INSERT INTO documents (name, size, mime_type, storage_path, uploaded_by, uploaded_by_email, library_id, library_scoped)
       VALUES ('mine.txt', 5, 'text/plain', 's/1', $1, $2, $3, false)`, [LEAVER.id, LEAVER.email, LIB]);
    await db.query(
      `INSERT INTO library_grants (library_id, folder_path, subject_type, subject_email, permission)
       VALUES ($1, '', 'user', $2, 'read')`, [LIB, LEAVER.email]);
    await setOff(ADMIN, LEAVER, { disabled: true });
    // still theirs on paper, and it all comes back if they do
    expect((await one('SELECT owner_id FROM libraries WHERE id = $1', [LIB])).owner_id).toBe(LEAVER.id);
    expect((await one('SELECT count(*)::int AS n FROM library_grants WHERE subject_email = $1', [LEAVER.email])).n).toBe(1);
    expect((await one('SELECT count(*)::int AS n FROM documents WHERE uploaded_by = $1', [LEAVER.id])).n).toBe(1);
  });

  test('the departure report says what only they can do, before anybody decides anything', async () => {
    await fixture();
    await db.query('INSERT INTO groups (name, owner_id, owner_email) VALUES ($1, $2, $3)', ['VNA', LEAVER.id, LEAVER.email]);
    await db.query(
      `INSERT INTO documents (name, size, mime_type, storage_path, uploaded_by, uploaded_by_email, library_id, library_scoped)
       VALUES ('mine.txt', 5, 'text/plain', 's/1', $1, $2, $3, false)`, [LEAVER.id, LEAVER.email, LIB]);
    const doc = await one("SELECT id FROM documents WHERE name = 'mine.txt'", []);
    await db.query(
      `INSERT INTO document_share_links (document_id, token_hash, created_by, created_by_email)
       VALUES ($1, 'h', $2, $3)`, [doc.id, LEAVER.id, LEAVER.email]);

    const res = await departure(ADMIN, LEAVER);
    expect(res.status).toBe(200);
    expect(res.body.owns_libraries).toEqual([{ id: LIB, name: 'Clients', personal: false, files: 1 }]);
    expect(res.body.owns_groups).toEqual([expect.objectContaining({ name: 'VNA', members: 0 })]);
    expect(res.body.live_file_links).toBe(1);
    expect(res.body.personal_files).toBe(1);
    // it decides nothing: asking does not switch anybody off
    expect((await one('SELECT disabled_at FROM user_roles WHERE user_id = $1', [LEAVER.id])).disabled_at).toBeNull();
  });

  test('their own library goes away with them, and comes back if they do', async () => {
    await fixture();
    const own = (await db.query(
      `INSERT INTO libraries (name, owner_id, owner_email, personal) VALUES ('leaver', $1, $2, true) RETURNING id`,
      [LEAVER.id, LEAVER.email]))[0].id;
    const off = await setOff(ADMIN, LEAVER, { disabled: true });
    expect(off.body.own_library_archived).toBe(true);
    expect((await one('SELECT archived_at FROM libraries WHERE id = $1', [own])).archived_at).toEqual(expect.any(Date));
    // the library they SHARED is deliberately left alone: handing that over moves other
    // people's access, which is a decision somebody makes, not a side effect
    expect((await one('SELECT archived_at FROM libraries WHERE id = $1', [LIB])).archived_at).toBeNull();
    // an archived library takes nothing, from anybody
    const libraries = require('../../lib/libraries');
    expect((await libraries.writeRight({ ...ADMIN, emailVerified: true }, own, '')).status).toBe(403);
    await setOff(ADMIN, LEAVER, { disabled: false });
    expect((await one('SELECT archived_at FROM libraries WHERE id = $1', [own])).archived_at).toBeNull();
  });

  test('a switched-off person\'s shared library can be handed to somebody still here', async () => {
    await fixture();
    // not while they are still here
    const early = await authed(as(ADMIN).post(`/api/libraries/${LIB}/reassign`)).send({ owner_email: ADMIN2.email });
    expect([early.status, early.body.code]).toEqual([409, 'OWNER_STILL_HERE']);

    await setOff(ADMIN, LEAVER, { disabled: true });
    const res = await authed(as(ADMIN).post(`/api/libraries/${LIB}/reassign`)).send({ owner_email: ADMIN2.email });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ owner_id: ADMIN2.id, owner_email: ADMIN2.email, personal: false });
    // ...and it can be managed again: an unmanageable library cannot be shared at all.
    // (An admin's write right reads 'admin' whoever owns it, so ownership is what is
    // measured here, not that.)
    expect(await libraries2().managesLibrary({ ...ADMIN2, role: 'contributor' }, LIB)).toBe(true);
    expect(await libraries2().managesLibrary({ ...LEAVER, role: 'contributor' }, LIB)).toBe(false);
  });

  test('a library cannot be handed to somebody who is switched off, or who only looks', async () => {
    await fixture();
    await setOff(ADMIN, LEAVER, { disabled: true });
    await db.query("UPDATE user_roles SET role = 'viewer' WHERE user_id = $1", [ADMIN2.id]);
    const viewer = await authed(as(ADMIN).post(`/api/libraries/${LIB}/reassign`)).send({ owner_email: ADMIN2.email });
    expect(viewer.status).toBe(400);
    await db.query("UPDATE user_roles SET role = 'admin' WHERE user_id = $1", [ADMIN2.id]);
    await setOff(ADMIN, ADMIN2, { disabled: true });
    const off = await authed(as(ADMIN).post(`/api/libraries/${LIB}/reassign`)).send({ owner_email: ADMIN2.email });
    expect(off.status).toBe(400);
    expect(off.body.error).toMatch(/switched off/);
  });

  test('only an administrator may ask, or switch', async () => {
    await fixture();
    expect((await setOff(LEAVER, ADMIN2, { disabled: true })).status).toBe(403);
    expect((await departure(LEAVER, ADMIN2)).status).toBe(403);
    expect((await setOff(ADMIN, { id: U(77) }, { disabled: true })).status).toBe(404);
  });
});

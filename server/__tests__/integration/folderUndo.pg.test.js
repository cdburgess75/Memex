'use strict';
// Deleting a folder ends its sharing -- and undoing that puts both back, against a REAL,
// THROWAWAY Postgres.
//
//   F5  delete then undo is the identity: the same people, at the same levels, on the
//       same files, trashed ones included -- and while it is deleted, nobody has it
//   F7  every refusal is a total no-op
//   F10 who may do it: deleting ends somebody's access, so it is the library owner's
//
// It DROPS AND RECREATES THE WHOLE public SCHEMA, so it refuses to run unless the
// database name contains "test":
//
//   MEMEX_TEST_PG_URL=postgres://user:pass@localhost:5432/memex_folder_test \
//     npx jest --runInBand integration/folderUndo.pg
const fs = require('fs');
const path = require('path');

const PG = process.env.MEMEX_TEST_PG_URL;
const suite = PG ? describe : describe.skip;
if (PG) jest.setTimeout(300000);

jest.mock('jsonwebtoken');
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn(() => ({ getSigningKey: async () => ({ getPublicKey: () => 'k' }) })) }));
jest.mock('../../lib/auditLog', () => ({ append: jest.fn(async () => ({})) }));
jest.mock('../../lib/storage', () => ({
  upload: jest.fn(async () => {}), download: jest.fn(async () => Buffer.alloc(0)), copy: jest.fn(async () => {}),
  del: jest.fn(async () => {}), isLocalProvider: jest.fn(async () => true), getUrl: jest.fn(), localBase: jest.fn(), validateLocalToken: jest.fn(),
}));
jest.mock('../../lib/notifications', () => ({ create: jest.fn(async () => ({})) }));
jest.mock('../../lib/emailEvents', () => ({ send: jest.fn(async () => ({})) }));

const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const LIB = U(90);
const LIB2 = U(91);
const GROUP = U(70);
const ADMIN = { id: U(1), email: 'admin@acme.test', role: 'admin' };
const OWNER = { id: U(2), email: 'owner@acme.test', role: 'contributor' };
const ANA = { id: U(3), email: 'ana@acme.test', role: 'contributor' };   // Read-Write above
const BEN = { id: U(4), email: 'ben@acme.test', role: 'contributor' };   // shared the folder
const CAT = { id: U(5), email: 'cat@acme.test', role: 'contributor' };   // in the group
const PEOPLE = [ADMIN, OWNER, ANA, BEN, CAT];

suite('deleting a folder, and changing your mind', () => {
  let db, request, app, jwt, documentAccess, helpers, storage;
  const reset = () => db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');

  beforeAll(async () => {
    const dbName = decodeURIComponent(new URL(PG).pathname.slice(1));
    if (!/test/i.test(dbName)) throw new Error(`refusing to run: "${dbName}" does not look like a throwaway test database`);
    process.env.DATABASE_URL = PG;
    db = require('../../lib/db');
    await reset();
    await db.query(fs.readFileSync(path.join(__dirname, '../../../postgres/init/01_schema.sql'), 'utf8'));
    await require('../../lib/migrations').run();
    jwt = require('jsonwebtoken');
    jwt.decode.mockReturnValue({ header: { kid: 'k' } });
    documentAccess = require('../../lib/documentAccess');
    helpers = require('./helpers/accessScenario');
    storage = require('../../lib/storage');
    request = require('supertest');
    const express = require('express');
    app = express();
    app.use(express.json());
    app.use('/api/files', require('../../routes/files'));
    app.use('/api/libraries', require('../../routes/libraries'));
  });

  afterAll(async () => {
    try { await reset(); } catch { /* best effort */ }
    try { await db.end(); } catch { /* already closed */ }
  });

  const as = (p) => { jwt.verify.mockReturnValue({ sub: p.id, email: p.email, email_verified: true }); return request(app); };
  const authed = (r) => r.set('Authorization', 'Bearer t').set('x-library-id', LIB);
  const del = (who, body) => authed(as(who).post('/api/files/folder/delete')).send({ source_library_id: LIB, ...body });
  const undo = (who, opId) => authed(as(who).post('/api/files/folder/restore')).send({ op_id: opId });
  const purge = (who, body) => authed(as(who).post('/api/files/folder/purge-trashed')).send({ library_id: LIB, ...body });
  const one = async (sql, params) => (await db.query(sql, params))[0];

  const add = (name, { by = OWNER, scoped = true, deleted = false, lib = LIB } = {}) => db.query(
    `INSERT INTO documents (name, size, mime_type, storage_path, uploaded_by, uploaded_by_email, library_id, library_scoped, deleted_at)
     VALUES ($1, 10, 'text/plain', $6, $2, $3, $4, $5, CASE WHEN $7 THEN NOW() - interval '2 days' END) RETURNING id`,
    [name, by.id, by.email, lib, scoped, `store/${name}/${Math.random()}`, deleted]);
  const share = (folderPath, who, permission = 'read') => db.query(
    `INSERT INTO library_grants (library_id, folder_path, subject_type, subject_email, permission) VALUES ($1, $2, 'user', $3, $4)`,
    [LIB, folderPath, who.email, permission]);
  const shareGroup = (folderPath, permission = 'read') => db.query(
    `INSERT INTO library_grants (library_id, folder_path, subject_type, group_id, permission) VALUES ($1, $2, 'group', $3, $4)`,
    [LIB, folderPath, GROUP, permission]);

  async function fixture({ extra = [] } = {}) {
    await db.query('TRUNCATE document_acl, library_grants, library_grants_ended, folder_ops, documents, libraries, user_roles, groups, group_members, folder_notify_prefs CASCADE');
    for (const p of PEOPLE) {
      await db.query('INSERT INTO user_roles (user_id, email, role, verified_email) VALUES ($1, $2, $3, $2)', [p.id, p.email, p.role]);
    }
    for (const [id, name] of [[LIB, 'Clients'], [LIB2, 'Vendors']]) {
      await db.query('INSERT INTO libraries (id, name, owner_id, owner_email) VALUES ($1, $2, $3, $4)', [id, name, OWNER.id, OWNER.email]);
    }
    await db.query('INSERT INTO groups (id, name, owner_id, owner_email) VALUES ($1, $2, $3, $4)', [GROUP, 'VNA', OWNER.id, OWNER.email]);
    await db.query('INSERT INTO group_members (group_id, member_email, added_by_email) VALUES ($1, $2, $3)', [GROUP, CAT.email, OWNER.email]);
    await add('Clients/Mender/plan.pdf');
    await add('Clients/Mender/Deep/detail.pdf');
    await add('Clients/Other/keepme.pdf');
    await share('Clients', ANA, 'write');            // above: survives the delete
    await share('Clients/Mender', BEN, 'write');      // at the folder: ends with it
    await shareGroup('Clients/Mender/Deep', 'read');  // below: ends too
    for (const fn of extra) await fn();
  }

  const levelsOn = async (id) => helpers.levelsOn(documentAccess, helpers.asClient(db), id);
  const mapOf = (m) => Object.fromEntries([...m].sort());
  const idsUnder = async (prefix) => (await db.query(
    "SELECT id, name FROM documents WHERE library_id = $1 AND starts_with(name, $2 || '/') ORDER BY name", [LIB, prefix]));
  async function levelMap(prefix) {
    const out = {};
    for (const d of await idsUnder(prefix)) out[d.name] = mapOf(await levelsOn(d.id));
    return out;
  }
  const TABLES = ['documents', 'library_grants', 'library_grants_ended', 'folder_ops', 'folder_op_documents', 'folder_notify_prefs'];
  async function stateHash() {
    const out = {};
    for (const t of TABLES) out[t] = (await one(`SELECT md5(coalesce(string_agg(x.r::text, '|' ORDER BY x.r::text), '')) AS h FROM ${t} x(r)`, [])).h;
    return out;
  }

  test('F5: delete then undo is the identity -- the same people, the same levels, the same files', async () => {
    await fixture({ extra: [() => add('Clients/Mender/gone.pdf', { deleted: true })] });
    const before = await levelMap('Clients/Mender');
    expect(Object.keys(before)).toHaveLength(3);          // two live, one already in the Trash

    const res = await del(OWNER, { path: 'Clients/Mender' });
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(res.body.shares_ended.map(s => s.subject).sort()).toEqual(['VNA', BEN.email]);
    expect(res.body.undo_until).toEqual(expect.any(String));

    // while it is deleted: the sharing is gone, and Ben cannot write there any more
    expect((await one("SELECT count(*)::int AS n FROM library_grants WHERE folder_path LIKE 'Clients/Mender%'", [])).n).toBe(0);
    const libraries = require('../../lib/libraries');
    expect((await libraries.writeRight({ ...BEN, emailVerified: true }, LIB, 'Clients/Mender')).status).toBe(403);
    expect((await one("SELECT count(*)::int AS n FROM documents WHERE starts_with(name, 'Clients/Mender/') AND deleted_at IS NULL", [])).n).toBe(0);

    const back = await undo(OWNER, res.body.op_id);
    expect(back.status).toBe(200);
    expect(back.body.count).toBe(2);
    expect(back.body.shares_restored.map(s => s.subject).sort()).toEqual(['VNA', BEN.email]);
    // ...and everybody is exactly where they were, including on the file that was already
    // in the Trash before any of this
    expect(await levelMap('Clients/Mender')).toEqual(before);
  });

  test('F5: a second undo has nothing left to do, and says so rather than failing', async () => {
    await fixture();
    const { body } = await del(OWNER, { path: 'Clients/Mender' });
    expect((await undo(OWNER, body.op_id)).body.already_undone).toBe(false);
    const again = await undo(OWNER, body.op_id);
    expect([again.status, again.body.already_undone, again.body.count]).toEqual([200, true, 0]);
    expect((await one("SELECT count(*)::int AS n FROM library_grants WHERE folder_path = 'Clients/Mender'", [])).n).toBe(1);
  });

  test('F5: a share whose group has since been deleted is skipped, and the rest still come back', async () => {
    await fixture();
    const { body } = await del(OWNER, { path: 'Clients/Mender' });
    await db.query('DELETE FROM groups WHERE id = $1', [GROUP]);
    const back = await undo(OWNER, body.op_id);
    expect(back.status).toBe(200);
    expect(back.body.shares_restored.map(s => s.subject)).toEqual([BEN.email]);
    expect(back.body.shares_not_restored).toEqual([{ path: 'Clients/Mender/Deep', permission: 'read', reason: 'group_gone' }]);
    expect((await one("SELECT count(*)::int AS n FROM documents WHERE name = 'Clients/Mender/plan.pdf' AND deleted_at IS NULL", [])).n).toBe(1);
  });

  test('F5: a share is only put back if something actually came back under it', async () => {
    await fixture();
    const { body } = await del(OWNER, { path: 'Clients/Mender' });
    // the only file the group's share covered is purged while the folder sits in the Trash
    await db.query("DELETE FROM documents WHERE name = 'Clients/Mender/Deep/detail.pdf'");
    const back = await undo(OWNER, body.op_id);
    expect(back.body.shares_restored.map(s => s.subject)).toEqual([BEN.email]);
    expect(back.body.shares_not_restored.map(s => s.reason)).toEqual(['nothing_came_back']);
    // no share is left sitting on a name with nothing under it
    expect(await db.query(
      `SELECT g.folder_path FROM library_grants g WHERE g.library_id = $1 AND g.folder_path <> ''
         AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.library_id = g.library_id AND d.deleted_at IS NULL
                          AND starts_with(d.name, g.folder_path || '/'))`, [LIB])).toEqual([]);
  });

  test('F5: if something else took the name meanwhile, nothing is put back', async () => {
    await fixture();
    const { body } = await del(OWNER, { path: 'Clients/Mender' });
    const before = await stateHash();
    await add('Clients/Mender/somebody elses.pdf');
    const back = await undo(OWNER, body.op_id);
    expect([back.status, back.body.code]).toEqual([409, 'FOLDER_EXISTS']);
    await db.query("DELETE FROM documents WHERE name = 'Clients/Mender/somebody elses.pdf'");
    expect(await stateHash()).toEqual(before);            // the refusal changed nothing
    expect((await undo(OWNER, body.op_id)).status).toBe(200);   // and it still works afterwards
  });

  test('F5: after the window it is too late, and the answer says what to do instead', async () => {
    await fixture();
    const { body } = await del(OWNER, { path: 'Clients/Mender' });
    await db.query("UPDATE folder_ops SET expires_at = NOW() - interval '1 minute' WHERE op_id = $1", [body.op_id]);
    const late = await undo(OWNER, body.op_id);
    expect([late.status, late.body.code]).toEqual([409, 'UNDO_EXPIRED']);
    expect(late.body.error).toMatch(/still in the Trash/);
    expect((await one("SELECT count(*)::int AS n FROM documents WHERE starts_with(name, 'Clients/Mender/') AND deleted_at IS NOT NULL", [])).n).toBe(2);
  });

  test('F10: deleting a shared folder is the library owner\'s, and the refusal explains why', async () => {
    await fixture();
    const refused = await del(ANA, { path: 'Clients/Mender' });   // Read-Write above, not the owner
    expect([refused.status, refused.body.code]).toEqual([403, 'FOLDER_MANAGER_ONLY']);
    expect((await one("SELECT count(*)::int AS n FROM documents WHERE starts_with(name, 'Clients/Mender/') AND deleted_at IS NULL", [])).n).toBe(2);
    // an unshared folder she may write in is hers to delete
    await db.query("DELETE FROM library_grants WHERE folder_path LIKE 'Clients/Mender%'");
    expect((await del(ANA, { path: 'Clients/Mender' })).status).toBe(200);
  });

  test('F10: deleting a folder needs the right where the folder sits -- and says no rather than doing nothing', async () => {
    await fixture();
    // Nothing is shared at or below 'Clients/Mender/Deep', so the owner-only rule is not
    // what answers here: Cat simply has no right to change anything in the folder above.
    // Without that check this is a 200 that quietly trashes nothing at all.
    await db.query("DELETE FROM library_grants WHERE folder_path <> 'Clients'");
    await db.query("DELETE FROM library_grants WHERE folder_path = 'Clients'");
    await share('Clients/Mender', CAT, 'read');
    const res = await del(CAT, { path: 'Clients/Mender/Deep' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/can't add files here/i);
    expect((await one("SELECT count(*)::int AS n FROM documents WHERE starts_with(name, 'Clients/Mender/') AND deleted_at IS NULL", [])).n).toBe(2);
    // ...while the owner, who can write above it, may
    expect((await del(OWNER, { path: 'Clients/Mender/Deep' })).status).toBe(200);
  });

  test('F7: every refusal leaves the database exactly as it was', async () => {
    await fixture();
    const before = await stateHash();
    for (const [label, run, want] of [
      ['a folder nobody can see', () => del(CAT, { path: 'Clients/Other' }), 404],
      ['no right where it sits', () => del(BEN, { path: 'Clients/Mender' }), 403],
      ['not the owner of a shared folder', () => del(ANA, { path: 'Clients/Mender' }), 403],
      ['an undo that names nothing', () => undo(OWNER, U(55)), 404],
      ['a purge nobody manages', () => purge(ANA, { path: 'Clients/Mender' }), 403],
    ]) {
      const res = await run();
      expect([label, res.status]).toEqual([label, want]);
      expect([label, await stateHash()]).toEqual([label, before]);
    }
  });

  test('the Trash of one folder can be emptied for good, by whoever manages the library', async () => {
    await fixture();
    const { body } = await del(OWNER, { path: 'Clients/Mender' });
    storage.del.mockClear();
    const res = await purge(OWNER, { path: 'Clients/Mender' });
    expect([res.status, res.body.count]).toEqual([200, 2]);
    expect(storage.del).toHaveBeenCalledTimes(2);                      // the objects go too
    expect((await one("SELECT count(*)::int AS n FROM documents WHERE starts_with(name, 'Clients/Mender/')", [])).n).toBe(0);
    // the deletion's record survives, with nothing left to put back
    expect((await one('SELECT count(*)::int AS n FROM folder_op_documents WHERE op_id = $1', [body.op_id])).n).toBe(0);
    const back = await undo(OWNER, body.op_id);
    expect([back.status, back.body.count]).toEqual([200, 0]);
    expect(back.body.shares_restored).toEqual([]);
  });

  test('a shared folder deleted out of a shared parent leaves the parent kept, not empty', async () => {
    await fixture();
    expect((await del(OWNER, { path: 'Clients/Other' })).status).toBe(200);
    expect((await del(OWNER, { path: 'Clients/Mender' })).status).toBe(200);
    const kept = await db.query("SELECT name, uploaded_by FROM documents WHERE name = 'Clients/.keep' AND deleted_at IS NULL", []);
    expect(kept).toEqual([{ name: 'Clients/.keep', uploaded_by: null }]);
    // Ana's share above survived the whole thing
    expect((await one("SELECT permission FROM library_grants WHERE folder_path = 'Clients'", [])).permission).toBe('write');
  });
});

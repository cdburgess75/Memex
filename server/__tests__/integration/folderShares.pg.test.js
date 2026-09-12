'use strict';
// "Folders keep their shares", against a REAL, THROWAWAY Postgres.
//
// A folder is only a name prefix, so moving one used to be refused whenever a share sat
// at or below it: the share would have been left on the old name. Now everything keyed by
// the path travels together. These are the properties that make that safe:
//
//   F1  a rename changes nobody's access -- the whole level map, before and after
//   F2  a move within the library is an ancestor swap, and nothing else
//   F6  invariant P: nothing keyed by the old path is left pointing at it
//   F7  every refusal is a total no-op, and never a 500
//   F8  a folder is never split: other people's personal files stay, and change nobody
//   F9  the awkward shapes -- emoji, over-long paths, 'P/P' -> 'P'
//   F10 who may do it: the right that counts is where the folder SITS
//
// It DROPS AND RECREATES THE WHOLE public SCHEMA, so it refuses to run unless the
// database name contains "test":
//
//   MEMEX_TEST_PG_URL=postgres://user:pass@localhost:5432/memex_folder_test \
//     npx jest --runInBand integration/folderShares.pg
const fs = require('fs');
const path = require('path');

const PG = process.env.MEMEX_TEST_PG_URL;
const suite = PG ? describe : describe.skip;
if (PG) jest.setTimeout(300000);

jest.mock('jsonwebtoken');
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn(() => ({ getSigningKey: async () => ({ getPublicKey: () => 'k' }) })) }));
jest.mock('../../lib/auditLog', () => ({ append: jest.fn(async () => ({})) }));
jest.mock('../../lib/storage', () => ({
  upload: jest.fn(async () => {}), download: jest.fn(async () => Buffer.alloc(0)), copy: jest.fn(async () => {}), del: jest.fn(async () => {}),
  isLocalProvider: jest.fn(async () => true), getUrl: jest.fn(), localBase: jest.fn(), validateLocalToken: jest.fn(),
}));
jest.mock('../../lib/notifications', () => ({ create: jest.fn(async () => ({})) }));
jest.mock('../../lib/emailEvents', () => ({ send: jest.fn(async () => ({})) }));

const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const LIB = U(90);
const ADMIN = { id: U(1), email: 'admin@acme.test', role: 'admin' };
const OWNER = { id: U(2), email: 'owner@acme.test', role: 'contributor' };
const ANA = { id: U(3), email: 'ana@acme.test', role: 'contributor' };    // Read-Write ABOVE the folder
const BEN = { id: U(4), email: 'ben@acme.test', role: 'contributor' };    // Read-Write AT the folder
const CAT = { id: U(5), email: 'cat@acme.test', role: 'contributor' };    // Read-only at the folder
const DAN = { id: U(6), email: 'dan@acme.test', role: 'contributor' };    // nothing at all
const VIC = { id: U(7), email: 'vic@acme.test', role: 'viewer' };         // can look, never write
const PEOPLE = [ADMIN, OWNER, ANA, BEN, CAT, DAN, VIC];

suite('folders keep their shares', () => {
  let db, request, app, jwt, documentAccess, helpers;
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
    request = require('supertest');
    const express = require('express');
    app = express();
    app.use(express.json());
    app.use('/api/files', require('../../routes/files'));
    app.use('/api/access', require('../../routes/access'));
  });

  afterAll(async () => {
    try { await reset(); } catch { /* best effort */ }
    try { await db.end(); } catch { /* already closed */ }
  });

  const as = (p) => { jwt.verify.mockReturnValue({ sub: p.id, email: p.email, email_verified: true }); return request(app); };
  const authed = (r) => r.set('Authorization', 'Bearer t').set('x-library-id', LIB);
  const rename = (who, body) => authed(as(who).post('/api/files/folder/rename')).send({ source_library_id: LIB, ...body });
  const reparent = (who, body) => authed(as(who).post('/api/files/folder/reparent')).send({ source_library_id: LIB, ...body });
  const one = async (sql, params) => (await db.query(sql, params))[0];

  const add = (name, { by = OWNER, scoped = true, deleted = false, lib = LIB } = {}) => db.query(
    `INSERT INTO documents (name, size, mime_type, storage_path, uploaded_by, uploaded_by_email, library_id, library_scoped, deleted_at)
     VALUES ($1, 10, 'text/plain', $6, $2, $3, $4, $5, CASE WHEN $7 THEN NOW() - interval '2 days' END) RETURNING id`,
    [name, by.id, by.email, lib, scoped, `store/${name}/${Math.random()}`, deleted]);
  const share = (folderPath, who, permission = 'read') => db.query(
    `INSERT INTO library_grants (library_id, folder_path, subject_type, subject_email, permission) VALUES ($1, $2, 'user', $3, $4)`,
    [LIB, folderPath, who.email, permission]);

  // The library everything below starts from: one shared client folder, one file of
  // somebody else's inside it, one thing in the Trash, and a folder to move it into.
  async function fixture({ extra = [] } = {}) {
    await db.query('TRUNCATE document_acl, library_grants, documents, libraries, user_roles, folder_notify_prefs, upload_sessions, folder_ops CASCADE');
    for (const p of PEOPLE) {
      await db.query('INSERT INTO user_roles (user_id, email, role, verified_email) VALUES ($1, $2, $3, $2)', [p.id, p.email, p.role]);
    }
    await db.query('INSERT INTO libraries (id, name, owner_id, owner_email) VALUES ($1, $2, $3, $4)', [LIB, 'Clients', OWNER.id, OWNER.email]);
    await add('Clients/Mender/plan.pdf');
    await add('Clients/Mender/Deep/detail.pdf');
    await add('Clients/Other/x.pdf');
    await add('Archive/old.pdf');
    await share('Clients', ANA, 'write');              // above the folder
    await share('Clients/Mender', BEN, 'write');       // at the folder
    await share('Clients/Mender', CAT, 'read');        // at the folder
    await share('Clients/Mender/Deep', CAT, 'write');  // below the folder
    await share('Clients', VIC, 'read');               // a viewer who can look
    for (const fn of extra) await fn();
  }

  // Who reaches a document, and at what level, straight from the rule.
  const levelsOn = async (id) => helpers.levelsOn(documentAccess, helpers.asClient(db), id);
  const docsUnder = (prefix) => db.query(
    "SELECT id, name FROM documents WHERE library_id = $1 AND starts_with(name, $2 || '/') ORDER BY name", [LIB, prefix]);
  const mapOf = (m) => Object.fromEntries([...m].sort());
  async function levelsByName(prefix) {
    const out = {};
    for (const d of await docsUnder(prefix)) out[d.name] = mapOf(await levelsOn(d.id));
    return out;
  }
  // Everything a folder operation could possibly disturb, as one value.
  const TABLES = ['documents', 'library_grants', 'library_grants_ended', 'folder_ops', 'folder_op_documents',
    'folder_notify_prefs', 'upload_sessions', 'document_acl'];
  async function stateHash() {
    const out = {};
    for (const t of TABLES) {
      const row = await one(`SELECT md5(coalesce(string_agg(x.r::text, '|' ORDER BY x.r::text), '')) AS h FROM ${t} x(r)`, []);
      out[t] = row.h;
    }
    return out;
  }

  test('F1: a rename changes nothing for anybody', async () => {
    await fixture();
    const before = await levelsByName('Clients/Mender');
    const res = await rename(OWNER, { path: 'Clients/Mender', name: 'Mender LLC' });
    expect(res.status).toBe(200);
    expect(res.body.shares_moved).toBe(3);               // at the folder (2) and below it (1)
    const after = await levelsByName('Clients/Mender LLC');
    // the same people, at the same levels, on the same files under their new names
    expect(Object.values(after)).toEqual(Object.values(before));
    expect(Object.keys(after)).toEqual(Object.keys(before).map(n => n.replace('Clients/Mender', 'Clients/Mender LLC')));
    // the shares came along; the one ABOVE stayed where it was
    const grants = await db.query('SELECT folder_path, subject_email, permission FROM library_grants WHERE library_id = $1 ORDER BY folder_path, subject_email', [LIB]);
    expect(grants.map(g => `${g.folder_path} ${g.subject_email} ${g.permission}`)).toEqual([
      'Clients ana@acme.test write',
      'Clients vic@acme.test read',
      'Clients/Mender LLC ben@acme.test write',
      'Clients/Mender LLC cat@acme.test read',
      'Clients/Mender LLC/Deep cat@acme.test write',
    ]);
  });

  test('F2: a move within the library swaps one ancestor for another, and nothing else', async () => {
    await fixture({ extra: [() => share('Archive', DAN, 'read')] });
    const res = await reparent(OWNER, { path: 'Clients/Mender', target: 'Archive' });
    expect(res.status).toBe(200);
    // Every moved file is now reachable by exactly the people the folder's new place
    // says -- worked out independently, by putting a fresh file there and asking the rule.
    const door = mapOf(await helpers.doorLevels(db, documentAccess, LIB, 'Archive/Mender'));
    for (const d of await docsUnder('Archive/Mender')) {
      if (d.name.endsWith('/Deep/detail.pdf')) continue;   // its own share below adds one more
      expect([d.name, mapOf(await levelsOn(d.id))]).toEqual([d.name, door]);
    }
    // Dan, who is shared the destination, gains it; Ana, shared the old parent, loses it.
    expect(door[DAN.id]).toBe('read');
    expect(door[ANA.id]).toBeUndefined();
    // and the shares that travelled still give exactly what they gave before
    expect(door[BEN.id]).toBe('write');
    expect(door[CAT.id]).toBe('read');
  });

  test('F2: the trash moves with the folder, and restoring lands it back inside', async () => {
    await fixture({ extra: [() => add('Clients/Mender/gone.pdf', { deleted: true })] });
    const res = await rename(OWNER, { path: 'Clients/Mender', name: 'Mender LLC' });
    expect([res.body.count, res.body.trashed]).toEqual([2, 1]);
    expect((await one('SELECT name FROM documents WHERE deleted_at IS NOT NULL AND library_id = $1', [LIB])).name)
      .toBe('Clients/Mender LLC/gone.pdf');
  });

  test('F6: nothing keyed by the old path is left pointing at it', async () => {
    await fixture({ extra: [
      () => db.query(`INSERT INTO folder_notify_prefs (library_id, folder_path, subscriber_email, enabled) VALUES ($1, 'Clients/Mender', $2, true)`, [LIB, CAT.email]),
      () => db.query(`INSERT INTO folder_notify_prefs (library_id, folder_path, subscriber_email, enabled) VALUES ($1, 'Clients/Mender LLC', $2, false)`, [LIB, CAT.email]),
      () => db.query(`INSERT INTO upload_sessions (name, size, mime_type, storage_path, chunk_size, total_chunks, uploaded_by, uploaded_by_email, library_id)
                      VALUES ('Clients/Mender/big.zip', 99, 'application/zip', 's/1', 10, 10, $1, $2, $3)`, [OWNER.id, OWNER.email, LIB]),
    ] });
    expect((await rename(OWNER, { path: 'Clients/Mender', name: 'Mender LLC' })).status).toBe(200);
    // the preference followed the folder, and the one already at the new name did not
    // become a duplicate: exactly one row per subscriber per path.
    const prefs = await db.query('SELECT folder_path, subscriber_email, enabled FROM folder_notify_prefs ORDER BY folder_path', []);
    expect(prefs).toEqual([{ folder_path: 'Clients/Mender LLC', subscriber_email: CAT.email, enabled: true }]);
    // the upload still arriving lands where the folder went
    expect((await one('SELECT name FROM upload_sessions', [])).name).toBe('Clients/Mender LLC/big.zip');
    // nothing at all is left at the old path
    for (const t of ['documents', 'library_grants', 'folder_notify_prefs', 'upload_sessions']) {
      const col = t === 'documents' || t === 'upload_sessions' ? 'name' : 'folder_path';
      const left = await db.query(`SELECT ${col} AS v FROM ${t} WHERE ${col} = 'Clients/Mender' OR starts_with(${col}, 'Clients/Mender/')`, []);
      expect([t, left]).toEqual([t, []]);
    }
  });

  test('F6: a move within the library leaves an upload where it was authorised', async () => {
    await fixture({ extra: [
      () => db.query(`INSERT INTO upload_sessions (name, size, mime_type, storage_path, chunk_size, total_chunks, uploaded_by, uploaded_by_email, library_id)
                      VALUES ('Clients/Mender/big.zip', 99, 'application/zip', 's/1', 10, 10, $1, $2, $3)`, [OWNER.id, OWNER.email, LIB]),
    ] });
    expect((await reparent(OWNER, { path: 'Clients/Mender', target: 'Archive' })).status).toBe(200);
    expect((await one('SELECT name FROM upload_sessions', [])).name).toBe('Clients/Mender/big.zip');
  });

  test('F7: every refusal leaves the database exactly as it was, and none of them is a 500', async () => {
    await fixture({ extra: [() => add('Clients/Taken/other.pdf')] });
    const before = await stateHash();
    const refusals = [
      ['onto an existing folder', () => rename(OWNER, { path: 'Clients/Mender', name: 'Taken' }), 409],
      ['no right where the folder sits', () => rename(BEN, { path: 'Clients/Mender', name: 'Mender LLC' }), 403],
      ['a folder nobody can see', () => rename(DAN, { path: 'Clients/Mender', name: 'Mender LLC' }), 404],
      ['into itself', () => reparent(OWNER, { path: 'Clients/Mender', target: 'Clients/Mender/Deep' }), 400],
      ['a name that is far too long', () => rename(OWNER, { path: 'Clients/Mender', name: 'x'.repeat(420) }), 400],
      ['a stale answer', () => rename(OWNER, { path: 'Clients/Mender', name: 'Mender LLC', fingerprint: 'sha256:not-the-one' }), 409],
    ];
    for (const [label, run, want] of refusals) {
      const res = await run();
      expect([label, res.status]).toEqual([label, want]);
      expect([label, await stateHash()]).toEqual([label, before]);
    }
  });

  test('F8: a folder is never split -- other people\'s personal files stay, and nobody new reaches them', async () => {
    await fixture({ extra: [() => add('Clients/Mender/private.pdf', { by: DAN, scoped: false })] });
    const mine = (await docsUnder('Clients/Mender')).find(d => d.name.endsWith('private.pdf'));
    const before = mapOf(await levelsOn(mine.id));
    const res = await rename(ANA, { path: 'Clients/Mender', name: 'Mender LLC' });   // Read-Write ABOVE
    expect(res.status).toBe(200);
    // Dan's file did not move, still reaches only Dan, and Ana is not told about it
    expect((await one('SELECT name FROM documents WHERE id = $1', [mine.id])).name).toBe('Clients/Mender/private.pdf');
    expect(mapOf(await levelsOn(mine.id))).toEqual(before);
    expect(before[DAN.id]).toBe('admin');
    expect(before[ANA.id]).toBeUndefined();
    expect(res.body.left_behind).toBeUndefined();
    // an admin does not move it either, even though the rule would let them reach it --
    // but an admin, who is shown personal files everywhere else, is told it stayed
    await fixture({ extra: [() => add('Clients/Mender/private.pdf', { by: DAN, scoped: false })] });
    const byAdmin = await rename(ADMIN, { path: 'Clients/Mender', name: 'Mender LLC' });
    expect(byAdmin.body.left_behind).toBe(1);
    expect((await one('SELECT name FROM documents WHERE uploaded_by = $1', [DAN.id])).name).toBe('Clients/Mender/private.pdf');
    // the mover's OWN personal file travels with the folder
    await fixture({ extra: [() => add('Clients/Mender/mine.pdf', { by: OWNER, scoped: false })] });
    expect((await rename(OWNER, { path: 'Clients/Mender', name: 'Mender LLC' })).status).toBe(200);
    expect((await one("SELECT name FROM documents WHERE name LIKE '%mine.pdf'", [])).name).toBe('Clients/Mender LLC/mine.pdf');
  });

  test('F9: the awkward shapes', async () => {
    // an emoji in the name: the cut counts code points, as Postgres does
    await fixture({ extra: [() => add('📁 Emoji/inside/file.pdf'), () => share('📁 Emoji/inside', CAT, 'read')] });
    // the cut counts code points, as Postgres' substring() does: counting UTF-16 units
    // would take one character too few and mangle every name under it
    expect((await rename(OWNER, { path: '📁 Emoji/inside', name: 'renamed' })).status).toBe(200);
    expect((await one('SELECT name FROM documents WHERE starts_with(name, $1)', ['📁 Emoji/'])).name).toBe('📁 Emoji/renamed/file.pdf');
    expect((await one('SELECT folder_path FROM library_grants WHERE subject_email = $1 AND starts_with(folder_path, $2)', [CAT.email, '📁'])).folder_path)
      .toBe('📁 Emoji/renamed');

    // a path already over the limit can still be SHORTENED -- the only way out of one
    await fixture();
    const deep = `Clients/${'y'.repeat(395)}`;
    await add(`${deep}/file.pdf`);
    expect((await rename(OWNER, { path: deep, name: 'short' })).status).toBe(200);
    expect((await rename(OWNER, { path: 'Clients/short', name: 'z'.repeat(399) })).body.code).toBe('NAME_TOO_LONG');

    // a folder moved up onto its own parent's name is not a clash with itself
    await fixture();
    await add('P/P/deep.pdf');
    await share('P/P', CAT, 'read');
    const res = await reparent(OWNER, { path: 'P/P', target: '' });
    expect([res.status, res.body.path]).toEqual([200, 'P']);
    expect((await one("SELECT count(*)::int AS n FROM documents WHERE name = 'P/deep.pdf'", [])).n).toBe(1);
    expect((await one('SELECT folder_path FROM library_grants WHERE subject_email = $1 AND library_id = $2 ORDER BY folder_path', [CAT.email, LIB])).folder_path).toBe('Clients/Mender');
    expect((await one("SELECT count(*)::int AS n FROM library_grants WHERE folder_path = 'P'", [])).n).toBe(1);
  });

  test('F10: the right that counts is where the folder SITS, not inside it', async () => {
    const want = {
      rename: [[ADMIN, 200], [OWNER, 200], [ANA, 200], [BEN, 403], [CAT, 403], [VIC, 403], [DAN, 404]],
      // Ana may write at 'Clients' but not at the root, so she cannot move it out
      reparent: [[ADMIN, 200], [OWNER, 200], [ANA, 403], [BEN, 403], [CAT, 403], [VIC, 403], [DAN, 404]],
    };
    for (const [op, rows] of Object.entries(want)) {
      for (const [who, status] of rows) {
        await fixture();
        const res = op === 'rename'
          ? await rename(who, { path: 'Clients/Mender', name: 'Mender LLC' })
          : await reparent(who, { path: 'Clients/Mender', target: 'Archive' });
        expect([op, who.email, res.status]).toEqual([op, who.email, status]);
        // a refusal never says whether anything here is shared
        if (status !== 200) expect(JSON.stringify(res.body)).not.toMatch(/share|shared/i);
      }
    }
  });

  // The case the parent rule exists for: Ben was GIVEN 'Clients/Mender', and he can
  // write in 'Public' as well. Without the rule he could carry the folder he was lent
  // into a place of his own choosing -- taking everyone else's access with it, or
  // dropping it in front of an audience the owner never picked.
  test('F10: a Read-Write recipient cannot carry their own shared folder off somewhere else', async () => {
    await fixture({ extra: [() => add('Public/notes.pdf'), () => share('Public', BEN, 'write')] });
    const res = await reparent(BEN, { path: 'Clients/Mender', target: 'Public' });
    expect(res.status).toBe(403);
    expect((await one("SELECT count(*)::int AS n FROM documents WHERE starts_with(name, 'Clients/Mender/')", [])).n).toBe(2);
    expect((await one("SELECT count(*)::int AS n FROM library_grants WHERE folder_path = 'Clients/Mender'", [])).n).toBe(2);
    // ...but inside the folder he was given, he is free: a subfolder is his to move
    expect((await reparent(BEN, { path: 'Clients/Mender/Deep', target: 'Clients/Mender/Deeper' })).status).toBe(200);
  });

  // Without a share nobody but the owner and admins can even see the folder, so the
  // refusal is the one that says nothing: 404.
  test('F10: with nothing shared, a folder nobody can see is a 404, not a 403', async () => {
    for (const [who, status] of [[OWNER, 200], [ANA, 404], [BEN, 404], [DAN, 404]]) {
      await fixture();
      await db.query('DELETE FROM library_grants WHERE library_id = $1', [LIB]);
      const res = await rename(who, { path: 'Clients/Mender', name: 'Mender LLC' });
      expect([who.email, res.status]).toEqual([who.email, status]);
    }
  });

  test('invariant D: a folder moved out from under a shared ancestor leaves it kept, not empty', async () => {
    await fixture();
    // 'Clients/Other' holds the only other file under 'Clients'; move both away and the
    // shared 'Clients' would be an empty shared name -- a trap for whatever takes it next.
    expect((await reparent(OWNER, { path: 'Clients/Other', target: 'Archive' })).status).toBe(200);
    expect((await reparent(OWNER, { path: 'Clients/Mender', target: 'Archive' })).status).toBe(200);
    const kept = await db.query("SELECT name, library_scoped, uploaded_by FROM documents WHERE name LIKE 'Clients/.keep'", []);
    expect(kept).toEqual([{ name: 'Clients/.keep', library_scoped: true, uploaded_by: null }]);
    // and the share is still on a folder that exists
    const dormant = await db.query(
      `SELECT g.folder_path FROM library_grants g WHERE g.library_id = $1 AND g.folder_path <> ''
         AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.library_id = g.library_id AND d.deleted_at IS NULL
                          AND starts_with(d.name, g.folder_path || '/'))`, [LIB]);
    expect(dormant).toEqual([]);
  });

  test('the answer the mover was shown is checked before the move happens', async () => {
    await fixture();
    const preview = await authed(as(OWNER).post('/api/access/folder-preview'))
      .send({ ops: [{ op: 'reparent', library_id: LIB, path: 'Clients/Mender', target: 'Archive' }] });
    expect(preview.status).toBe(200);
    const { fingerprint } = preview.body.previews[0];
    // somebody is given the destination while the mover is deciding
    await share('Archive', DAN, 'read');
    const stale = await reparent(OWNER, { path: 'Clients/Mender', target: 'Archive', fingerprint });
    expect([stale.status, stale.body.code]).toEqual([409, 'CHANGED']);
    expect((await one("SELECT count(*)::int AS n FROM documents WHERE starts_with(name, 'Clients/Mender/')", [])).n).toBe(2);
    // with the answer they were actually shown, it goes through
    const fresh = await authed(as(OWNER).post('/api/access/folder-preview'))
      .send({ ops: [{ op: 'reparent', library_id: LIB, path: 'Clients/Mender', target: 'Archive' }] });
    expect((await reparent(OWNER, { path: 'Clients/Mender', target: 'Archive', fingerprint: fresh.body.previews[0].fingerprint })).status).toBe(200);
  });

  test('a folder too big to rewrite in one go says so, and how big it is', async () => {
    await fixture();
    const was = process.env.FOLDER_OP_MAX_ROWS;
    process.env.FOLDER_OP_MAX_ROWS = '1';
    try {
      const res = await rename(OWNER, { path: 'Clients/Mender', name: 'Mender LLC' });
      expect([res.status, res.body.code, res.body.count]).toEqual([409, 'FOLDER_TOO_LARGE', 2]);
      expect(res.body.error).toContain('2 files');
    } finally { if (was === undefined) delete process.env.FOLDER_OP_MAX_ROWS; else process.env.FOLDER_OP_MAX_ROWS = was; }
  });

  test('what happened is written down: one folder_ops row per operation, none for a refusal', async () => {
    await fixture();
    expect((await rename(OWNER, { path: 'Clients/Mender', name: 'Mender LLC' })).body.op_id).toEqual(expect.any(String));
    await rename(BEN, { path: 'Clients/Mender LLC', name: 'Nope' });  // refused: no right above
    const ops = await db.query('SELECT kind, path, new_path, actor_email FROM folder_ops ORDER BY created_at', []);
    expect(ops).toEqual([{ kind: 'rename', path: 'Clients/Mender', new_path: 'Clients/Mender LLC', actor_email: OWNER.email }]);
  });
});

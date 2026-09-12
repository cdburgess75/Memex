'use strict';
// "Who gains and who loses if I move this folder?" against a REAL, THROWAWAY Postgres.
//
// The preview is worked out from reads alone, so the thing worth proving is that it says
// what actually happens: each case previews the operation, then performs the equivalent
// change inside a transaction that is rolled back, re-reads the rule, and compares.
// It also checks that each half of the answer is only shown to whoever manages that side.
const fs = require('fs');
const path = require('path');

const PG = process.env.MEMEX_TEST_PG_URL;
const suite = PG ? describe : describe.skip;
if (PG) jest.setTimeout(180000);

jest.mock('../../lib/auditLog', () => ({ append: jest.fn(async () => ({})) }));

const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const LIB = U(90);
const LIB2 = U(91);
const OWNER = { id: U(2), email: 'owner@acme.test', role: 'contributor' };
const ANA = { id: U(3), email: 'ana@acme.test', role: 'contributor' };     // shared the folder
const VIC = { id: U(4), email: 'vic@vendor.test', role: 'contributor' };   // shared the destination
const ADMIN = { id: U(1), email: 'admin@acme.test', role: 'admin' };
const OTHER_OWNER = { id: U(5), email: 'other@acme.test', role: 'contributor' };

suite('the folder preview says what will actually happen', () => {
  let db, accessKeys, folderPreview, documentAccess, libraries;
  const reset = () => db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');

  beforeAll(async () => {
    const dbName = decodeURIComponent(new URL(PG).pathname.slice(1));
    if (!/test/i.test(dbName)) throw new Error(`refusing to run: "${dbName}" does not look like a throwaway test database`);
    process.env.DATABASE_URL = PG;
    db = require('../../lib/db');
    await reset();
    await db.query(fs.readFileSync(path.join(__dirname, '../../../postgres/init/01_schema.sql'), 'utf8'));
    await require('../../lib/migrations').run();
    accessKeys = require('../../lib/accessKeys');
    folderPreview = require('../../lib/folderPreview');
    documentAccess = require('../../lib/documentAccess');
    libraries = require('../../lib/libraries');
  });

  afterAll(async () => {
    try { await reset(); } catch { /* best effort */ }
    try { await db.end(); } catch { /* already closed */ }
  });

  async function fixture() {
    await db.query('TRUNCATE document_acl, library_grants, documents, libraries, user_roles CASCADE');
    for (const p of [ADMIN, OWNER, ANA, VIC, OTHER_OWNER]) {
      await db.query('INSERT INTO user_roles (user_id, email, role, verified_email) VALUES ($1, $2, $3, $2)', [p.id, p.email, p.role]);
    }
    await db.query('INSERT INTO libraries (id, name, owner_id, owner_email) VALUES ($1, $2, $3, $4)', [LIB, 'Clients', OWNER.id, OWNER.email]);
    await db.query('INSERT INTO libraries (id, name, owner_id, owner_email) VALUES ($1, $2, $3, $4)', [LIB2, 'Vendors', OTHER_OWNER.id, OTHER_OWNER.email]);
    const add = (name, lib = LIB) => db.query(
      `INSERT INTO documents (name, size, mime_type, storage_path, uploaded_by, uploaded_by_email, library_id, library_scoped)
       VALUES ($1, 10, 'text/plain', $2, $3, $4, $5, true)`,
      [name, `s/${Math.random()}`, OWNER.id, OWNER.email, lib]);
    await add('Clients/Mender/a.pdf');
    await add('Clients/Mender/Deep/b.pdf');
    await add('Archive/x.pdf');
    await add('Drop/y.pdf', LIB2);
    const share = (lib, folder, email, permission) => db.query(
      `INSERT INTO library_grants (library_id, folder_path, subject_type, subject_email, permission) VALUES ($1, $2, 'user', $3, $4)`,
      [lib, folder, email, permission]);
    await share(LIB, 'Clients/Mender', ANA.email, 'write');   // travels with the folder
    await share(LIB, 'Archive', VIC.email, 'read');           // already at the destination
    await share(LIB2, 'Drop', VIC.email, 'write');
  }

  // The rule's answer at a door, for everyone.
  const doorLevels = (lib, p, q = db) => accessKeys.gates({ query: (sql, params) => q.query(sql, params) }, { kind: 'folder', libraryId: lib, path: p });
  // Do the operation for real, read the rule again, then roll it all back.
  async function reallyDo(fn) {
    let out;
    await db.withTransaction(async (client) => {
      const q = { query: async (sql, params) => (await client.query(sql, params)).rows };
      out = await fn(q);
      throw Object.assign(new Error('rollback'), { rollback: true });
    }).catch((e) => { if (!e.rollback) throw e; });
    return out;
  }
  const rekey = async (q, lib, oldPath, newPath) => {
    const cut = Array.from(oldPath).length + 1;
    await q.query(`UPDATE documents SET name = $2 || substring(name from $3::int) WHERE library_id = $1 AND starts_with(name, $4 || '/')`, [lib, newPath, cut, oldPath]);
    await q.query(`UPDATE library_grants SET folder_path = $2 || substring(folder_path from $3::int)
                    WHERE library_id = $1 AND folder_path <> '' AND (folder_path = $4 OR starts_with(folder_path, $4 || '/'))`, [lib, newPath, cut, oldPath]);
  };
  const asMap = (m) => Object.fromEntries([...m].sort());
  const managerBoth = { canManageSource: true, canManageTarget: true };

  test('a rename changes nothing for anybody, and the preview says so', async () => {
    await fixture();
    const p = await folderPreview.preview({ op: 'rename', libraryId: LIB, path: 'Clients/Mender', newPath: 'Clients/Mender LLC', targetLibraryId: LIB }, managerBoth);
    expect([p.lose, p.gain, p.changed]).toEqual([[], [], []]);
    expect(p.shares_moving).toBe(1);
    const after = await reallyDo(async (q) => {
      await rekey(q, LIB, 'Clients/Mender', 'Clients/Mender LLC');
      return doorLevels(LIB, 'Clients/Mender LLC', q);
    });
    expect(asMap(after)).toEqual(asMap(await doorLevels(LIB, 'Clients/Mender')));
  });

  test('moving a folder swaps the sharing it inherits, and the preview names who', async () => {
    await fixture();
    const op = { op: 'reparent', libraryId: LIB, path: 'Clients/Mender', newPath: 'Archive/Mender', targetLibraryId: LIB };
    const p = await folderPreview.preview(op, managerBoth);
    expect(p.gain.map(x => x.email)).toEqual([VIC.email]);   // the destination is shared with Vic
    expect(p.gain[0].after).toBe('read');
    expect(p.lose).toEqual([]);                               // Ana's share travels with it
    expect(p.shares_moving).toBe(1);
    // ...and that is what really happens
    const after = await reallyDo(async (q) => {
      await rekey(q, LIB, 'Clients/Mender', 'Archive/Mender');
      return doorLevels(LIB, 'Archive/Mender', q);
    });
    const before = await doorLevels(LIB, 'Clients/Mender');
    const people = await accessKeys.peopleAt({ query: (s2, p2) => db.query(s2, p2) }, [...new Set([...before.keys(), ...after.keys()])]);
    const real = folderPreview.diff(before, after, people);
    expect([real.gain, real.lose, real.changed]).toEqual([p.gain, p.lose, p.changed]);
  });

  test('deleting the folder ends its sharing, and the preview names who loses it', async () => {
    await fixture();
    const p = await folderPreview.preview({ op: 'delete', libraryId: LIB, path: 'Clients/Mender', targetLibraryId: LIB }, managerBoth);
    expect(p.lose.map(x => x.email)).toEqual([ANA.email]);
    expect(p.shares_ending.map(s => s.subject_email)).toEqual([ANA.email]);
    expect(p.gain).toEqual([]);
    const after = await reallyDo(async (q) => {
      await q.query(`DELETE FROM library_grants WHERE library_id = $1 AND folder_path = $2`, [LIB, 'Clients/Mender']);
      return doorLevels(LIB, 'Clients/Mender', q);
    });
    const before = await doorLevels(LIB, 'Clients/Mender');
    const people = await accessKeys.peopleAt({ query: (s2, p2) => db.query(s2, p2) }, [...before.keys()]);
    expect(folderPreview.diff(before, after, people).lose).toEqual(p.lose);
  });

  test('taking a folder to another library ends its sharing there and picks up the new library instead', async () => {
    await fixture();
    const p = await folderPreview.preview({ op: 'library_move', libraryId: LIB, path: 'Clients/Mender', newPath: 'Clients/Mender', targetLibraryId: LIB2 }, managerBoth);
    // Ana's share of the folder ends with the move -- and so does the source library's
    // own owner, because the folder is now in somebody else's library.
    expect(p.lose.map(x => x.email).sort()).toEqual([ANA.email, OWNER.email].sort());
    expect(p.gain.map(x => x.email)).toEqual([OTHER_OWNER.email]); // the destination's owner
    expect(p.shares_ending).toHaveLength(1);
  });

  test('each half of the answer is only for whoever manages that side', async () => {
    await fixture();
    const op = { op: 'reparent', libraryId: LIB, path: 'Clients/Mender', newPath: 'Archive/Mender', targetLibraryId: LIB };
    const sourceOnly = await folderPreview.preview(op, { canManageSource: true, canManageTarget: false });
    expect([sourceOnly.lose_visible, sourceOnly.gain_visible]).toEqual([true, false]);
    expect(sourceOnly.gain).toBeNull();
    expect(sourceOnly.lose).toEqual([]);
    const targetOnly = await folderPreview.preview(op, { canManageSource: false, canManageTarget: true });
    expect(targetOnly.lose).toBeNull();
    expect(targetOnly.shares_moving).toBeNull();   // a count is a probe too
    expect(targetOnly.gain.map(x => x.email)).toEqual([VIC.email]);
  });

  test('admins are counted, never named', async () => {
    await fixture();
    const p = await folderPreview.preview({ op: 'delete', libraryId: LIB, path: 'Clients/Mender', targetLibraryId: LIB }, managerBoth);
    expect(JSON.stringify(p)).not.toContain(ADMIN.email);
    expect(p.admins_unaffected).toBe(1);
  });

  test('the fingerprint changes when anything the answer depends on changes', async () => {
    await fixture();
    const op = { op: 'reparent', libraryId: LIB, path: 'Clients/Mender', newPath: 'Archive/Mender', targetLibraryId: LIB };
    const first = (await folderPreview.preview(op, managerBoth)).fingerprint;
    expect((await folderPreview.preview(op, managerBoth)).fingerprint).toBe(first);
    // a share added ABOVE the destination: not at either path, but it changes the answer
    await db.query(`INSERT INTO library_grants (library_id, folder_path, subject_type, subject_email, permission)
                    VALUES ($1, 'Archive', $2, 'user', 'read') ON CONFLICT DO NOTHING`, [LIB, ADMIN.email]).catch(() => {});
    await db.query(`INSERT INTO library_grants (library_id, folder_path, subject_type, subject_email, permission)
                    VALUES ($1, 'Archive', $2, 'read') ON CONFLICT DO NOTHING`, [LIB, OTHER_OWNER.email]).catch(() => {});
    await db.query(`INSERT INTO library_grants (library_id, folder_path, subject_type, subject_email, permission)
                    VALUES ($1, 'Archive', 'user', $2, 'read')`, [LIB, OTHER_OWNER.email]);
    expect((await folderPreview.preview(op, managerBoth)).fingerprint).not.toBe(first);
  });
});

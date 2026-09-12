'use strict';
// The one-off repair, and what the Share panel says about a folder with nothing in it.
//
// Shares made before folders learned to keep themselves alive can already be sitting on a
// name with nothing under it -- a trap, because the next folder to take that name inherits
// the share. scripts/piece4-keep-shared-folders.js finds them and either keeps the folder
// (default) or ends the share (--retire), and libraryShares reports which is which so a
// manager is never shown an empty share as live access.
//
//   MEMEX_TEST_PG_URL=postgres://user:pass@localhost:5432/memex_folder_test \
//     npx jest --runInBand integration/piece4Repair.pg
const fs = require('fs');
const path = require('path');

const PG = process.env.MEMEX_TEST_PG_URL;
const suite = PG ? describe : describe.skip;
if (PG) jest.setTimeout(180000);

jest.mock('../../lib/auditLog', () => ({ append: jest.fn(async () => ({})) }));
jest.mock('../../lib/storage', () => ({ upload: jest.fn(async () => {}), del: jest.fn(async () => {}) }));

const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const LIB = U(90);
const OWNER = { id: U(2), email: 'owner@acme.test' };
const ANA = 'ana@acme.test';
const BEN = 'ben@acme.test';

suite('the piece 4 repair', () => {
  let db, shares, repair, auditLog;
  const reset = () => db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');

  beforeAll(async () => {
    const dbName = decodeURIComponent(new URL(PG).pathname.slice(1));
    if (!/test/i.test(dbName)) throw new Error(`refusing to run: "${dbName}" does not look like a throwaway test database`);
    process.env.DATABASE_URL = PG;
    db = require('../../lib/db');
    await reset();
    await db.query(fs.readFileSync(path.join(__dirname, '../../../postgres/init/01_schema.sql'), 'utf8'));
    await require('../../lib/migrations').run();
    shares = require('../../lib/libraryShares');
    auditLog = require('../../lib/auditLog');
    repair = require('../../../scripts/piece4-keep-shared-folders');
  });

  afterAll(async () => {
    try { await reset(); } catch { /* best effort */ }
    try { await db.end(); } catch { /* already closed */ }
  });

  const add = (name) => db.query(
    `INSERT INTO documents (name, size, mime_type, storage_path, uploaded_by, uploaded_by_email, library_id, library_scoped)
     VALUES ($1, 10, 'text/plain', $2, $3, $4, $5, true)`, [name, `s/${name}`, OWNER.id, OWNER.email, LIB]);
  const share = (folderPath, email, permission = 'read') => db.query(
    `INSERT INTO library_grants (library_id, folder_path, subject_type, subject_email, permission) VALUES ($1, $2, 'user', $3, $4)`,
    [LIB, folderPath, email, permission]);
  const stateOf = async (folderPath) => (await shares.listShares(LIB)).find(s => s.folder_path === folderPath)?.folder_state;

  async function fixture() {
    await db.query('TRUNCATE library_grants, library_grants_ended, folder_ops, folder_op_documents, documents, libraries, user_roles CASCADE');
    await db.query('INSERT INTO user_roles (user_id, email, role, verified_email) VALUES ($1, $2, $3, $2)', [OWNER.id, OWNER.email, 'contributor']);
    await db.query('INSERT INTO libraries (id, name, owner_id, owner_email) VALUES ($1, $2, $3, $4)', [LIB, 'Clients', OWNER.id, OWNER.email]);
    await add('Clients/Live/plan.pdf');
    await share('Clients/Live', ANA, 'write');     // a folder with something in it
    await share('Clients/Empty', BEN, 'read');     // a share on a name with nothing under it
    jest.clearAllMocks();
  }

  test('a dry run changes nothing, and still records what it found', async () => {
    await fixture();
    const out = await repair.run({ apply: false });
    expect(out).toEqual({ found: 1, planted: 0, retired: 0 });
    expect((await db.query("SELECT 1 FROM documents WHERE name LIKE '%/.keep'")).length).toBe(0);
    // even a dry run is somebody finding out which outside addresses hold an empty share
    expect(auditLog.append).toHaveBeenCalledWith(expect.objectContaining({
      actorEmail: 'system@piece4-repair',
      detail: expect.stringContaining(BEN),
    }));
    expect(auditLog.append.mock.calls[0][0].detail).toMatch(/^dry run \(keep\)/);
  });

  test('applying it keeps the folder, changes nobody\'s access, and stays distinguishable', async () => {
    await fixture();
    expect(await repair.run({ apply: true })).toEqual({ found: 1, planted: 1, retired: 0 });
    const kept = await db.query("SELECT name, uploaded_by, library_scoped FROM documents WHERE name LIKE '%/.keep'");
    expect(kept).toEqual([{ name: 'Clients/Empty/.keep', uploaded_by: null, library_scoped: true }]);
    // the marker is recorded under a release_keep operation, so this set stays tellable
    // apart from a folder somebody emptied yesterday
    const op = await db.query(`SELECT o.kind, o.path FROM folder_ops o
                                 JOIN folder_op_documents od ON od.op_id = o.op_id
                                 JOIN documents d ON d.id = od.document_id AND d.name = 'Clients/Empty/.keep'`);
    expect(op).toEqual([{ kind: 'release_keep', path: 'Clients/Empty' }]);
    expect(await stateOf('Clients/Empty')).toBe('release_keep');
    expect(await stateOf('Clients/Live')).toBe('live');
    // and there is nothing left for it to do
    expect(await repair.run({ apply: true })).toEqual({ found: 0, planted: 0, retired: 0 });
  });

  test('--retire ends the share instead, and it is recorded as ended', async () => {
    await fixture();
    expect(await repair.run({ apply: true, retire: true })).toEqual({ found: 1, planted: 0, retired: 1 });
    expect((await db.query("SELECT 1 FROM library_grants WHERE folder_path = 'Clients/Empty'")).length).toBe(0);
    const ended = await db.query('SELECT folder_path, subject_email, cause, ended_by_email FROM library_grants_ended');
    expect(ended).toEqual([{ folder_path: 'Clients/Empty', subject_email: BEN, cause: 'folder_purged', ended_by_email: 'system@piece4-repair' }]);
    expect((await db.query("SELECT 1 FROM documents WHERE name LIKE '%/.keep'")).length).toBe(0);
  });

  test('a folder emptied AFTER release reads as kept, not as one of the repair\'s', async () => {
    await fixture();
    await repair.run({ apply: true });
    // somebody empties a live folder now: the ordinary keep marker, not the repair's
    await db.query("DELETE FROM documents WHERE name = 'Clients/Live/plan.pdf'");
    const { keepSharedFoldersAlive } = require('../../lib/keepMarker');
    await db.withTransaction(async (client) => {
      await keepSharedFoldersAlive({ query: async (sql, params) => (await client.query(sql, params)).rows }, LIB, ['Clients/Live/plan.pdf']);
    });
    expect(await stateOf('Clients/Live')).toBe('empty_kept');
    expect(await stateOf('Clients/Empty')).toBe('release_keep');
  });

  test('a share on a path with nothing at all is reported as gone, so it cannot hide', async () => {
    await fixture();
    expect(await stateOf('Clients/Empty')).toBe('gone');
  });
});

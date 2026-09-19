'use strict';
// A LIVE folder link points at its folder by path, so it has to travel with the folder and
// end with it -- otherwise it goes on pointing at the old name, and publishes whatever
// folder takes that name next to whoever the old link was sent to.
jest.mock('../../lib/db', () => ({ query: jest.fn(), queryOne: jest.fn() }));
const carry = require('../../lib/folderCarry');

const recorder = () => { const calls = []; return { calls, query: async (sql, params) => { calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params }); return []; }, queryOne: async () => null }; };
const LIB = 'aaaaaaaa-0000-4000-8000-000000000001', DEST = 'bbbbbbbb-0000-4000-8000-000000000002';

test('a rename carries the live links at and under the folder, and only those', async () => {
  const q = recorder();
  await carry.carryPathState(q, { libraryId: LIB, oldPath: 'Clients/Acme', newPath: 'Clients/Acme Ltd', kind: 'rename' });
  const upd = q.calls.find(c => c.sql.startsWith('UPDATE folder_share_links'));
  expect(upd.sql).toContain("SET folder_path = $2 || substring(f.folder_path from $3::int), library_id = $5");
  expect(upd.sql).toContain('WHERE f.live AND f.library_id = $1 AND f.revoked_at IS NULL');       // snapshots hold ids and need nothing
  expect(upd.sql).toContain("(f.folder_path = $4 OR starts_with(f.folder_path, $4 || '/'))");    // "Acme/", never "AcmeSecret"
  expect(upd.params).toEqual([LIB, 'Clients/Acme Ltd', 'Clients/Acme'.length + 1, 'Clients/Acme', LIB]);
});
test('a move to another library takes the link there', async () => {
  const q = recorder();
  await carry.carryPathState(q, { libraryId: LIB, destLibraryId: DEST, oldPath: 'Acme', newPath: 'Acme', kind: 'move' });
  expect(q.calls.find(c => c.sql.startsWith('UPDATE folder_share_links')).params[4]).toBe(DEST);
});
test('deleting a folder ends its live links, before the name can be taken by another folder', async () => {
  const q = recorder();
  await carry.endShares(q, { libraryId: LIB, path: 'Clients/Acme', opId: 'op-1', user: { id: 'u1', email: 'me@x.com' }, cause: 'delete' });
  const upd = q.calls.find(c => c.sql.startsWith('UPDATE folder_share_links'));
  expect(upd.sql).toContain('SET revoked_at = NOW(), revoked_by = $3');
  expect(upd.sql).toContain('WHERE f.live AND f.library_id = $1 AND f.revoked_at IS NULL');
  expect(upd.params).toEqual([LIB, 'Clients/Acme', 'u1']);
});
test('the library root is not a folder: nothing is ended', async () => {
  const q = recorder();
  await carry.endShares(q, { libraryId: LIB, path: '', opId: 'op-1', user: { id: 'u1' }, cause: 'delete' });
  expect(q.calls).toHaveLength(0);
});

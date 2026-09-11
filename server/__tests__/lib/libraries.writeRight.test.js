'use strict';
// writeRight decides, before anything is stored, whether a caller may add files at a
// place in a library, and whether what lands there is library content.
jest.mock('../../lib/db', () => ({ query: jest.fn(), queryOne: jest.fn() }));
const db = require('../../lib/db');
const { writeRight, sharedFolderAt } = require('../../lib/libraries');

const LIB = 'aaaaaaaa-0000-4000-8000-000000000001';
const row = (over) => ({ id: LIB, owner_id: 'owner-1', is_owner: false, shared: false, rw_grant: false, legacy_listed: true, ...over });
const contributor = { id: 'u1', email: 'u@x.com', role: 'contributor', emailVerified: true };
beforeEach(() => db.queryOne.mockReset());

test('a malformed id is a 400 and never reaches the database', async () => {
  expect(await writeRight(contributor, 'lib-1', '')).toEqual({ status: 400, error: 'Bad library id' });
  expect(db.queryOne).not.toHaveBeenCalled();
});
test('an unknown library is a 404', async () => {
  db.queryOne.mockResolvedValueOnce(null);
  expect((await writeRight(contributor, LIB, '')).status).toBe(404);
});
test('an admin may always write; content is library content once the library has an owner or shares', async () => {
  const admin = { ...contributor, role: 'admin' };
  db.queryOne.mockResolvedValueOnce(row({ owner_id: null }));
  expect(await writeRight(admin, LIB, '')).toEqual({ right: 'admin', scoped: false });
  db.queryOne.mockResolvedValueOnce(row({}));
  expect(await writeRight(admin, LIB, '')).toEqual({ right: 'admin', scoped: true });
  db.queryOne.mockResolvedValueOnce(row({ owner_id: null, shared: true }));
  expect(await writeRight(admin, LIB, '')).toEqual({ right: 'admin', scoped: true });
});
test('a viewer never has a right, even owning the library or holding a write share', async () => {
  db.queryOne.mockResolvedValueOnce(row({ is_owner: true, rw_grant: true }));
  expect((await writeRight({ ...contributor, role: 'viewer' }, LIB, '')).status).toBe(403);
});
test('the owner, and a Read-Write share holder, write library content', async () => {
  db.queryOne.mockResolvedValueOnce(row({ is_owner: true, shared: true }));
  expect(await writeRight(contributor, LIB, 'a/b')).toEqual({ right: 'owner', scoped: true });
  db.queryOne.mockResolvedValueOnce(row({ shared: true, rw_grant: true }));
  expect(await writeRight(contributor, LIB, 'a/b')).toEqual({ right: 'grant', scoped: true });
});
test("an unshared, open library keeps today's rule, and what lands there stays personal", async () => {
  db.queryOne.mockResolvedValueOnce(row({}));
  expect(await writeRight(contributor, LIB, '')).toEqual({ right: 'legacy', scoped: false });
});
test('once a library is shared, only its owner and Read-Write holders may add to it', async () => {
  db.queryOne.mockResolvedValueOnce(row({ shared: true }));
  expect((await writeRight(contributor, LIB, '')).status).toBe(403);
});
test('a member-restricted library the caller is not listed in is refused', async () => {
  db.queryOne.mockResolvedValueOnce(row({ legacy_listed: false }));
  expect((await writeRight(contributor, LIB, '')).status).toBe(403);
});
// The old open-library rule is today's rule, unchanged: members are matched on the
// address the account signs in with, as the library switcher matches them. Shares match
// only the verified address, which the SQL looks up by account id ($2), not this slot.
test('the legacy member match uses the address the switcher uses, even unverified', async () => {
  db.queryOne.mockResolvedValueOnce(row({}));
  await writeRight({ ...contributor, email: 'U@X.com', emailVerified: false }, LIB, 'Clients');
  expect(db.queryOne.mock.calls[0][1]).toEqual([LIB, 'u1', 'Clients', 'u@x.com']);
  expect(db.queryOne.mock.calls[0][0]).toMatch(/g\.subject_email = \(SELECT ur\.verified_email FROM user_roles ur WHERE ur\.user_id = \$2\)/);
});
test('sharedFolderAt looks at and below the path, and ignores bad input', async () => {
  expect(await sharedFolderAt('nope', 'a')).toBe(false);
  expect(await sharedFolderAt(LIB, '')).toBe(false);
  db.queryOne.mockResolvedValueOnce({ '?column?': 1 });
  expect(await sharedFolderAt(LIB, 'Clients')).toBe(true);
  expect(db.queryOne.mock.calls[0][0]).toMatch(/folder_path = \$2 OR starts_with\(folder_path, \$2 \|\| '\/'\)/);
});

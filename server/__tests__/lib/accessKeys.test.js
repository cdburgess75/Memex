'use strict';
// Shared with me, as lib/accessKeys shapes it. The SQL runs for real (rows, levels,
// what's excluded) in integration/accessKeys.pg.test.js; here the data layer answers
// only the exact statements the function is expected to send, so the shaping --
// merging, capping, trimming, what an unverified account gets -- is pinned down alone.
const mockClient = { query: jest.fn() };
jest.mock('../../lib/db', () => ({ withTransaction: jest.fn(async (fn) => fn(mockClient)) }));

const db = require('../../lib/db');
const documentAccess = require('../../lib/documentAccess');
const accessKeys = require('../../lib/accessKeys');

const ME = { id: '11111111-1111-4111-8111-111111111111', email: 'me@acme.test', emailVerified: true, verifiedEmail: 'me@acme.test', role: 'contributor' };
const LIB = 'aaaaaaaa-0000-4000-8000-000000000001';
const LIB2 = 'aaaaaaaa-0000-4000-8000-000000000002';

const shareRow = (over = {}) => ({
  share_id: 's1', library_id: LIB, folder_path: '', group_id: null, permission: 'write', granted_by_email: 'olive@acme.test', created_at: '2026-09-01',
  library_name: 'Accounting', owner_email: 'olive@acme.test', owner_name: 'Olive', group_name: null, granted_by_name: 'Olive',
  level: 'write', files: 4, bytes: '400', updated_at: '2026-09-02', ...over,
});
const fileRow = (over = {}) => ({
  id: 'd1', name: 'Tax & Co/Q1.pdf', size: '12', created_at: '2026-08-01', library_id: LIB2, library_scoped: true,
  uploaded_by: 'u9', uploaded_by_email: 'uploader@acme.test', grant_id: 'g1', permission: 'read', granted_by_email: 'g@acme.test',
  granted_at: '2026-09-03', library_name: 'Ops', library_owner_email: 'ops@acme.test', granted_by_name: null, owner_name: 'Ops Owner', level: 'read', ...over,
});

// Answers by statement: the snapshot, then the shares, then the files -- anything else fails.
function answer({ shares = [], files = [] } = {}) {
  mockClient.query.mockImplementation(async (sql) => {
    if (/^SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY$/.test(sql)) return { rows: [] };
    if (/FROM library_grants g/.test(sql)) return { rows: shares };
    if (/FROM document_acl acl/.test(sql)) return { rows: files };
    throw new Error(`unexpected statement: ${sql.slice(0, 80)}`);
  });
}
const statements = () => mockClient.query.mock.calls.map(c => c[0]);

beforeEach(() => { jest.clearAllMocks(); answer(); });

describe('who gets a list', () => {
  test('an account without a verified address is told so and reads nothing', async () => {
    const out = await accessKeys.sharedWithMe({ ...ME, emailVerified: false, verifiedEmail: null });
    expect(out).toEqual({ email_verified: false, is_admin: false, libraries: [], folders: [], files: [], truncated: { files: false } });
    expect(db.withTransaction).not.toHaveBeenCalled();
  });
  test('everything is read in one read-only snapshot, the snapshot set first', async () => {
    await accessKeys.sharedWithMe(ME);
    expect(db.withTransaction).toHaveBeenCalledTimes(1);
    expect(statements()[0]).toBe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(statements()).toHaveLength(3);
  });
  test("the caller's own parameters, then the write and admin sets", async () => {
    await accessKeys.sharedWithMe(ME);
    const expected = [...documentAccess.userParams(ME, 'read'), documentAccess.permissionsFor('write'), documentAccess.permissionsFor('admin')];
    expect(mockClient.query.mock.calls[1][1]).toEqual(expected);
    expect(mockClient.query.mock.calls[2][1]).toEqual(expected);
  });
  test("shares use the rule's own subject match and skip libraries the caller owns", async () => {
    await accessKeys.sharedWithMe(ME);
    const sql = statements()[1];
    expect(sql).toContain(documentAccess.shareSubject('g', documentAccess.refsAt(1)));
    expect(sql).toContain('l.owner_id IS DISTINCT FROM $2');
  });
  test('files are kept only where the rule itself lets the caller in', async () => {
    await accessKeys.sharedWithMe(ME);
    const sql = statements()[2];
    expect(sql).toContain(documentAccess.condition('m', 1));
    expect(sql).toMatch(/NOT \(NOT d\.library_scoped AND d\.uploaded_by IS NOT DISTINCT FROM \$2\)/);
    expect(sql).toMatch(/LIMIT 501/);
  });
});

describe('the shapes', () => {
  test('two routes to one door become one row at the higher level, the direct share first', async () => {
    answer({ shares: [
      shareRow({ share_id: 's-group', group_id: 'grp', group_name: 'Bookkeepers', permission: 'read', level: 'read' }),
      shareRow({ share_id: 's-direct', level: 'write' }),
    ] });
    const out = await accessKeys.sharedWithMe(ME);
    expect(out.libraries).toHaveLength(1);
    const [lib] = out.libraries;
    expect(lib).not.toHaveProperty('path');
    expect(lib.level).toBe('write');
    expect(lib.effective).toBe('write');
    expect(lib.library).toEqual({ id: LIB, name: 'Accounting', owner: { email: 'olive@acme.test', name: 'Olive' } });
    expect(lib.shares.map(s => s.share_id)).toEqual(['s-group', 's-direct']);
    expect(lib.shares[0].via_group).toEqual({ id: 'grp', name: 'Bookkeepers' });
    expect(lib.bytes).toBe(400);
  });
  test('a folder row is named by its last segment, and knows when the whole library is also yours', async () => {
    answer({ shares: [
      shareRow({ share_id: 'whole', level: 'read' }),
      shareRow({ share_id: 'f-low', folder_path: 'Clients/Mender', level: 'read' }),
      shareRow({ share_id: 'f-high', folder_path: 'Clients/Mender Extra', level: 'write' }),
    ] });
    const out = await accessKeys.sharedWithMe(ME);
    expect(out.folders.map(f => [f.path, f.name, f.also_whole_library])).toEqual([
      ['Clients/Mender', 'Mender', true],
      ['Clients/Mender Extra', 'Mender Extra', false], // the folder gives more than the library does
    ]);
  });
  test('a share the rule does not honour for this account is left out', async () => {
    answer({ shares: [shareRow({ level: null })] });
    expect((await accessKeys.sharedWithMe(ME)).libraries).toEqual([]);
  });
  test('a view-only account is shown what it can use', async () => {
    answer({ shares: [shareRow({ level: 'read' })], files: [fileRow({ level: 'admin' })] });
    const out = await accessKeys.sharedWithMe({ ...ME, role: 'viewer' });
    expect(out.libraries[0]).toMatchObject({ level: 'read', effective: 'read', view_only: true });
    expect(out.files[0]).toMatchObject({ level: 'admin', effective: 'read' });
  });
  test('a file is split into folder and name, owned by its library when it is library content', async () => {
    answer({ files: [fileRow(), fileRow({ id: 'd2', name: 'loose.txt', library_scoped: false, library_id: null, owner_name: null })] });
    const out = await accessKeys.sharedWithMe(ME);
    expect(out.files[0].document).toEqual({ id: 'd1', name: 'Q1.pdf', folder: 'Tax & Co', size: 12, created_at: '2026-08-01', library: { id: LIB2, name: 'Ops' } });
    expect(out.files[0].owner).toEqual({ email: 'ops@acme.test', name: 'Ops Owner' });
    expect(out.files[0].granted_by).toEqual({ email: 'g@acme.test', name: null });
    expect(out.files[1].document).toMatchObject({ name: 'loose.txt', folder: '', library: null });
    expect(out.files[1].owner).toEqual({ email: 'uploader@acme.test', name: null });
  });
  test('more than 500 files: the newest 500, and it says so', async () => {
    answer({ files: Array.from({ length: 501 }, (_, i) => fileRow({ id: `d${i}` })) });
    const out = await accessKeys.sharedWithMe(ME);
    expect(out.files).toHaveLength(500);
    expect(out.truncated.files).toBe(true);
  });
  test('admins are flagged, so the page can say this is only what was shared with them', async () => {
    expect((await accessKeys.sharedWithMe({ ...ME, role: 'admin' })).is_admin).toBe(true);
  });
});

describe('the helpers', () => {
  test('maxLevel and effectiveFor', () => {
    expect(accessKeys.maxLevel(null, 'read')).toBe('read');
    expect(accessKeys.maxLevel('write', 'read')).toBe('write');
    expect(accessKeys.maxLevel('read', 'admin')).toBe('admin');
    expect(accessKeys.maxLevel(null, null)).toBe(null);
    expect(accessKeys.effectiveFor('viewer', 'admin')).toBe('read');
    expect(accessKeys.effectiveFor('contributor', 'write')).toBe('write');
    expect(accessKeys.effectiveFor('', 'write')).toBe('read');
    expect(accessKeys.effectiveFor('admin', null)).toBe(null);
  });
  test("the caller's level is the rule at each set, highest first", () => {
    const sql = accessKeys.callerLevel('p');
    const R = documentAccess.refsAt(1);
    expect(sql.indexOf(documentAccess.conditionWith('p', { ...R, perms: '$7' }))).toBeGreaterThan(-1);
    expect(sql.indexOf(documentAccess.conditionWith('p', { ...R, perms: '$7' })))
      .toBeLessThan(sql.indexOf(documentAccess.conditionWith('p', { ...R, perms: '$6' })));
    expect(sql).toContain(documentAccess.conditionWith('p', R));
  });
  test('the door probe is library content with no id and no uploader, a folder ending in "/"', () => {
    expect(accessKeys.probe('l.id', 'g.folder_path')).toMatch(/NULL::uuid AS id, NULL::uuid AS uploaded_by, true AS library_scoped/);
    expect(accessKeys.probe('l.id', 'g.folder_path')).toContain("CASE WHEN g.folder_path = '' THEN '' ELSE g.folder_path || '/' END AS name");
  });
});

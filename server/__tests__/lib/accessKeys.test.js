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
    if (sql === 'SET LOCAL jit = off') return { rows: [] };
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
    expect(statements()[1]).toBe('SET LOCAL jit = off');
    expect(statements()).toHaveLength(4);
  });
  test("the caller's own parameters, then the write and admin sets", async () => {
    await accessKeys.sharedWithMe(ME);
    const expected = [...documentAccess.userParams(ME, 'read'), documentAccess.permissionsFor('write'), documentAccess.permissionsFor('admin')];
    expect(mockClient.query.mock.calls[2][1]).toEqual(expected);
    expect(mockClient.query.mock.calls[3][1]).toEqual(expected);
  });
  test("shares use the rule's own subject match and skip libraries the caller owns", async () => {
    await accessKeys.sharedWithMe(ME);
    const sql = statements()[2];
    expect(sql).toContain(documentAccess.shareSubject('g', documentAccess.refsAt(1)));
    expect(sql).toContain('l.owner_id IS DISTINCT FROM $2');
  });
  test('files are kept only where the rule itself lets the caller in', async () => {
    await accessKeys.sharedWithMe(ME);
    const sql = statements()[3];
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

describe('reconcile: the rule is the truth', () => {
  const r = (key, level, relation = 'door') => ({ key, kind: 'library_share', relation, level });
  beforeEach(() => jest.spyOn(console, 'error').mockImplementation(() => {}));
  afterEach(() => console.error.mockRestore());
  test('reasons that explain the level exactly are left alone, and nothing is logged', () => {
    const out = accessKeys.reconcile('write', [r('ls:1', 'write'), r('ls:2', 'read')], {});
    expect(out).toEqual({ reasons: [r('ls:1', 'write'), r('ls:2', 'read')], drift: false });
    expect(console.error).not.toHaveBeenCalled();
  });
  test('a level the reasons cannot explain is named, never hidden', () => {
    const out = accessKeys.reconcile('admin', [r('ls:1', 'write')], { door: 'library', id: 'L', user_id: 'U' });
    expect(out.drift).toBe(true);
    expect(out.reasons.at(-1)).toEqual({ key: null, kind: 'unexplained', relation: 'door', level: 'admin' });
    expect(console.error).toHaveBeenCalledWith('access-keys drift', { door: 'library', id: 'L', user_id: 'U', gate: 'admin', best: 'write' });
  });
  test('reasons claiming more than the rule gives are capped at it', () => {
    const out = accessKeys.reconcile('read', [r('ls:1', 'write'), r('fs:2', 'read')], {});
    expect(out.reasons.map(x => x.level)).toEqual(['read', 'read']);
    expect(out.drift).toBe(true);
  });
  test('reasons for someone the rule keeps out all go', () => {
    expect(accessKeys.reconcile(null, [r('ls:1', 'read')], {}).reasons).toEqual([]);
  });
});

describe('impactOf: what removing a key does', () => {
  const person = (ref, level, reasons, extra = {}) => ({ ref, level, reasons, drift: false, ...extra });
  const r = (key, level, relation = 'door', more = {}) => ({ key, kind: key.startsWith('fs') ? 'folder_share' : 'library_share', relation, level, ...more });
  test('someone with no other way in loses access; someone with one keeps the best of the rest', () => {
    const people = [
      person('u:a', 'write', [r('ls:1', 'write')]),
      person('u:b', 'write', [r('ls:1', 'write'), r('ls:2', 'read')]),
      person('u:c', 'read', [r('ls:9', 'read')]),
    ];
    expect(accessKeys.impactOf(people, 'ls:1')).toEqual({
      lose: ['u:a'], keep: [{ ref: 'u:b', before: 'write', after: 'read', via: ['ls:2'] }], unknown: [], admins_unaffected: 0,
    });
  });
  test('the admin reason never goes', () => {
    const people = [person('u:admin', 'admin', [{ key: 'admins', kind: 'admin', relation: 'door', level: 'admin' }, r('ls:1', 'write')])];
    expect(accessKeys.impactOf(people, 'ls:1').keep).toEqual([{ ref: 'u:admin', before: 'admin', after: 'admin', via: ['admins'] }]);
  });
  test('lowering a share to Read-only keeps them, at read, unless something else gives more', () => {
    const people = [person('u:a', 'write', [r('ls:1', 'write')]), person('u:b', 'write', [r('ls:1', 'write'), r('fs:2', 'write', 'above')])];
    const out = accessKeys.impactOf(people, 'ls:1', { lowerTo: 'read' });
    expect(out.lose).toEqual([]);
    expect(out.keep).toEqual([{ ref: 'u:a', before: 'write', after: 'read', via: [] }, { ref: 'u:b', before: 'write', after: 'write', via: ['fs:2'] }]);
  });
  test('a person whose reasons disagree with the rule is "unknown", never a promise', () => {
    const people = [person('u:a', 'write', [r('ls:1', 'write')], { drift: true })];
    expect(accessKeys.impactOf(people, 'ls:1')).toMatchObject({ lose: [], keep: [], unknown: ['u:a'] });
  });
  test('a share of a folder inside: the door, or another share at or above that folder, keeps it open', () => {
    const inside = (key, path, level) => r(key, level, 'inside', { folder_path: path });
    const people = [
      person('u:door', 'read', [r('ls:1', 'read'), inside('fs:5', 'A/B', 'write')]),
      person('u:above', null, [inside('fs:6', 'A', 'read'), inside('fs:5', 'A/B', 'write')]),
      person('u:beside', null, [inside('fs:7', 'A/C', 'write'), inside('fs:5', 'A/B', 'write')]),
    ];
    expect(accessKeys.impactOf(people, 'fs:5')).toEqual({
      lose: ['u:beside'],
      keep: [{ ref: 'u:door', before: 'write', after: 'read', via: ['ls:1'] }, { ref: 'u:above', before: 'write', after: 'read', via: ['fs:6'] }],
      unknown: [], admins_unaffected: 0,
    });
  });
  test('admins it lets in are counted, not named', () => {
    expect(accessKeys.impactOf([], 'ls:1', { adminsAdmitted: 2 }).admins_unaffected).toBe(2);
  });
});

describe('stillOpen and shareRelation', () => {
  const file = (over = {}) => ({ id: 'f', name: 'A/B/x.pdf', library_scoped: true, uploaded_by: 'up', ...over });
  const p = (over = {}) => ({ user_id: 'u', is_admin_account: false, door_level: null, reasons: [], ...over });
  test('a file given one by one stays open through the door, a folder share above it, or another grant', () => {
    expect(accessKeys.stillOpen(p({ door_level: 'read' }), file())).toBe(true);
    expect(accessKeys.stillOpen(p({ reasons: [{ kind: 'folder_share', relation: 'inside', folder_path: 'A' }] }), file())).toBe(true);
    expect(accessKeys.stillOpen(p({ reasons: [{ kind: 'folder_share', relation: 'inside', folder_path: 'A/B x' }] }), file())).toBe(false);
    expect(accessKeys.stillOpen(p(), file(), () => true)).toBe(true);
    expect(accessKeys.stillOpen(p(), file())).toBe(false);
  });
  test("library keys don't reach a personal file; its uploader and admins do", () => {
    expect(accessKeys.stillOpen(p({ door_level: 'write' }), file({ library_scoped: false }))).toBe(false);
    expect(accessKeys.stillOpen(p({ user_id: 'up' }), file({ library_scoped: false }))).toBe(true);
    expect(accessKeys.stillOpen(p({ is_admin_account: true }), file({ library_scoped: false }))).toBe(true);
  });
  test('where a share sits relative to the door', () => {
    const lib = { kind: 'library', path: '' };
    const folder = { kind: 'folder', path: 'A/B' };
    expect(accessKeys.shareRelation(lib, '')).toBe('door');
    expect(accessKeys.shareRelation(lib, 'A')).toBe('inside');
    expect(accessKeys.shareRelation(folder, '')).toBe('above');
    expect(accessKeys.shareRelation(folder, 'A')).toBe('above');
    expect(accessKeys.shareRelation(folder, 'A/B')).toBe('at');
    expect(accessKeys.shareRelation(folder, 'A/B/C')).toBe('inside');
    expect(accessKeys.shareRelation({ kind: 'file' }, 'A')).toBe('above');
  });
});

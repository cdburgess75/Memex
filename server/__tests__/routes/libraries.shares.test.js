'use strict';
// The share routes: who may see and change a library's shares, what is validated before
// anything is written, and what is recorded and who is told. The SQL behind them (the
// listing rule, the shares table, what a share grants) is exercised against real
// Postgres in integration/librarySharing.pg.test.js; here the data layer is controlled.
const request = require('supertest');
const express = require('express');

const LIB = 'aaaaaaaa-0000-4000-8000-000000000001';
const GROUP = 'bbbbbbbb-0000-4000-8000-000000000001';
const SHARE = 'cccccccc-0000-4000-8000-000000000001';
const OWNER = { id: '11111111-1111-4111-8111-111111111111', email: 'owner@corp.com', verifiedEmail: 'owner@corp.com', role: 'contributor' };
const ADMIN = { id: '22222222-2222-4222-8222-222222222222', email: 'admin@corp.com', verifiedEmail: 'admin@corp.com', role: 'admin' };
const OTHER = { id: '33333333-3333-4333-8333-333333333333', email: 'other@corp.com', verifiedEmail: 'other@corp.com', role: 'contributor' };

const mockState = { user: OWNER, lib: null, share: null, created: null, createError: null, folderVisible: true, group: null, groupVisible: true, members: [] };
jest.mock('../../middleware/auth', () => (req, _res, next) => { req.user = { ...mockState.user }; next(); });
jest.mock('../../lib/libraries', () => ({
  visibleLibrary: jest.fn(async (_u, id) => (mockState.lib && id === mockState.lib.id ? mockState.lib : null)),
  listMembers: jest.fn(async () => [{ id: 'm1', subject_email: 'legacy@corp.com' }]),
  listLibraries: jest.fn(async () => []),
}));
jest.mock('../../lib/libraryShares', () => ({
  listShares: jest.fn(async () => [{ id: 'cccccccc-0000-4000-8000-000000000001' }]),
  getShare: jest.fn(async () => mockState.share),
  findShare: jest.fn(async () => ({ id: 'existing' })),
  createShare: jest.fn(async (args) => { if (mockState.createError) throw mockState.createError; mockState.created = args; return { id: 'new-share', ...args }; }),
  setPermission: jest.fn(async () => null),
  deleteShare: jest.fn(async () => ({ id: 'cccccccc-0000-4000-8000-000000000001' })),
  folderVisibleTo: jest.fn(async () => mockState.folderVisible),
  countForGroup: jest.fn(async () => 0),
}));
jest.mock('../../lib/groups', () => ({
  ...jest.requireActual('../../lib/groups'),
  getGroup: jest.fn(async (id) => (mockState.group && id === mockState.group.id ? mockState.group : null)),
  canView: jest.fn(async () => mockState.groupVisible),
  listMembers: jest.fn(async () => mockState.members),
}));
jest.mock('../../lib/notifications', () => ({ create: jest.fn().mockResolvedValue({}) }));
jest.mock('../../lib/emailEvents', () => ({ send: jest.fn().mockResolvedValue({}) }));
jest.mock('../../lib/auditLog', () => ({ append: jest.fn().mockResolvedValue({}) }));
jest.mock('../../lib/db', () => ({
  query: jest.fn(async () => []),
  queryOne: jest.fn(async () => null),
  // Creating a share runs under the library's tree lock, in a transaction.
  withTransaction: jest.fn(async (fn) => fn({ query: jest.fn(async () => ({ rows: [] })) })),
  paramList: jest.requireActual('../../lib/db').paramList,
}));

const shares = require('../../lib/libraryShares');
const notifications = require('../../lib/notifications');
const emailEvents = require('../../lib/emailEvents');
const auditLog = require('../../lib/auditLog');
const app = () => { const a = express(); a.use(express.json()); a.use('/api/libraries', require('../../routes/libraries')); return a; };
const lib = (over = {}) => ({ id: LIB, name: 'Clients', owner_id: OWNER.id, owner_email: OWNER.email, can_manage: true, ...over });
const post = (body) => request(app()).post(`/api/libraries/${LIB}/shares`).send(body);
const events = (type) => auditLog.append.mock.calls.map(c => c[0]).filter(e => e.eventType === type);

beforeEach(() => {
  jest.clearAllMocks();
  Object.assign(mockState, { user: OWNER, lib: lib(), share: null, created: null, createError: null, folderVisible: true, group: null, groupVisible: true, members: [] });
});

describe('who may see and change shares', () => {
  test('a library the caller cannot see is a 404, whatever the id', async () => {
    mockState.lib = null;
    for (const id of [LIB, 'not-a-uuid']) expect((await request(app()).get(`/api/libraries/${id}/shares`)).status).toBe(404);
  });
  test('seeing it without managing it is a 403, and nothing is listed', async () => {
    mockState.lib = lib({ can_manage: false });
    const res = await request(app()).get(`/api/libraries/${LIB}/shares`);
    expect(res.status).toBe(403);
    expect(shares.listShares).not.toHaveBeenCalled();
  });
  test('a viewer never manages shares', async () => {
    mockState.user = { ...OWNER, role: 'viewer' };
    expect((await request(app()).get(`/api/libraries/${LIB}/shares`)).status).toBe(403);
    expect((await post({ email: 'a@b.com', permission: 'read' })).status).toBe(403);
    expect(shares.createShare).not.toHaveBeenCalled();
  });
  test('the owner sees the shares; only an admin also sees the old member list', async () => {
    const mine = await request(app()).get(`/api/libraries/${LIB}/shares`);
    expect(mine.status).toBe(200);
    expect(mine.body.library).toEqual({ id: LIB, name: 'Clients', owner_id: OWNER.id, owner_email: OWNER.email });
    expect(mine.body.legacy_members).toBeUndefined();
    mockState.user = ADMIN;
    expect((await request(app()).get(`/api/libraries/${LIB}/shares`)).body.legacy_members).toHaveLength(1);
  });
  test.each([
    ['POST', () => post({ email: 'a@b.com', permission: 'read' })],
    ['PUT', () => request(app()).put(`/api/libraries/${LIB}/shares/${SHARE}`).send({ permission: 'read' })],
    ['DELETE', () => request(app()).delete(`/api/libraries/${LIB}/shares/${SHARE}`)],
  ])('%s by someone who can see but not manage is a 403 and writes nothing', async (_m, call) => {
    mockState.lib = lib({ can_manage: false });
    mockState.share = { id: SHARE, permission: 'write' };
    expect((await call()).status).toBe(403);
    expect(shares.createShare).not.toHaveBeenCalled();
    expect(shares.setPermission).not.toHaveBeenCalled();
    expect(shares.deleteShare).not.toHaveBeenCalled();
    expect(auditLog.append).not.toHaveBeenCalled();
  });
});

describe('adding a share', () => {
  test('a library with no owner cannot be shared yet', async () => {
    mockState.lib = lib({ owner_id: null, owner_email: null });
    mockState.user = ADMIN;
    const res = await post({ email: 'a@b.com', permission: 'read' });
    expect(res.status).toBe(409);
    expect(shares.createShare).not.toHaveBeenCalled();
  });
  test.each([
    ['neither a person nor a group', { permission: 'read' }, 400],
    ['both a person and a group', { email: 'a@b.com', group_id: GROUP, permission: 'read' }, 400],
    ['no level', { email: 'a@b.com' }, 400],
    ['admin, which a share can never be', { email: 'a@b.com', permission: 'admin' }, 400],
    ['a malformed address', { email: 'not an address', permission: 'read' }, 400],
    ['a folder that cannot be a share key', { email: 'a@b.com', permission: 'read', folder_path: 'a/../b' }, 400],
    ['a folder with an edge space', { email: 'a@b.com', permission: 'read', folder_path: 'Clients /x' }, 400],
  ])('%s is refused before anything is written', async (_l, body, status) => {
    expect((await post(body)).status).toBe(status);
    expect(shares.createShare).not.toHaveBeenCalled();
  });
  test("a group the caller can't see is 'not found', never confirmed to exist", async () => {
    mockState.group = { id: GROUP, name: 'Payroll' };
    mockState.groupVisible = false;
    const hidden = await post({ group_id: GROUP, permission: 'read' });
    const missing = await post({ group_id: 'bbbbbbbb-0000-4000-8000-0000000000ff', permission: 'read' });
    expect([hidden.status, hidden.body]).toEqual([missing.status, missing.body]);
    expect(hidden.status).toBe(404);
  });
  test("a folder the caller can't read in this library is 'not found' (no peeking at others' folders)", async () => {
    mockState.folderVisible = false;
    const res = await post({ email: 'a@b.com', permission: 'read', folder_path: 'Payroll' });
    expect(res.status).toBe(404);
    expect(shares.folderVisibleTo).toHaveBeenCalledWith(LIB, 'Payroll', expect.objectContaining({ id: OWNER.id }));
    expect(shares.createShare).not.toHaveBeenCalled();
  });
  test('a person: stored lower-cased at the exact folder, chained, and told in-app and by email', async () => {
    const res = await post({ email: ' Tim@DTS-Tax.com ', permission: 'write', folder_path: '/Clients//Mender/' });
    expect(res.status).toBe(201);
    expect(mockState.created).toMatchObject({ libraryId: LIB, folderPath: 'Clients/Mender', email: 'tim@dts-tax.com', permission: 'write' });
    expect(events('library_shared').map(e => e.detail)).toEqual([`library ${LIB} "Clients" "Clients/Mender" -> user "tim@dts-tax.com" write by ${OWNER.id}`]);
    expect(notifications.create).toHaveBeenCalledWith(expect.objectContaining({ userEmail: 'tim@dts-tax.com', type: 'share_granted', refType: 'library', refId: LIB }));
    expect(emailEvents.send).toHaveBeenCalledWith('share_granted', expect.objectContaining({ to: 'tim@dts-tax.com', actorEmail: 'owner@corp.com' }));
  });
  test("a sharer whose address isn't verified: the mail comes from the workspace and says so", async () => {
    mockState.user = { ...OWNER, email: 'owner@corp.com', verifiedEmail: null, emailVerified: false };
    await post({ email: 'tim@dts-tax.com', permission: 'read' });
    const [, mail] = emailEvents.send.mock.calls[0];
    expect(mail.actorEmail).toBeNull();
    expect(mail.subject).toBe('owner@corp.com (unverified address) shared a library with you');
    expect(notifications.create.mock.calls[0][0].title).toMatch(/\(unverified address\)/);
  });
  test('a library name cannot break lines in the mail', async () => {
    mockState.lib = lib({ name: 'Clients\nBcc: x@evil.com' });
    await post({ email: 'tim@dts-tax.com', permission: 'read' });
    expect(emailEvents.send.mock.calls[0][1].text).toMatch(/the library "Clients Bcc: x@evil\.com"/);
  });
  test('sharing with yourself tells nobody', async () => {
    await post({ email: OWNER.email, permission: 'read' });
    expect(notifications.create).not.toHaveBeenCalled();
    expect(emailEvents.send).not.toHaveBeenCalled();
  });
  test('a group: each member but the sharer is told in-app; no email goes out', async () => {
    mockState.group = { id: GROUP, name: 'Acctg' };
    mockState.members = [{ member_email: 'A@corp.com' }, { member_email: 'owner@corp.com' }, { member_email: 'b@corp.com' }];
    const res = await post({ group_id: GROUP, permission: 'read' });
    expect(res.status).toBe(201);
    expect(mockState.created).toMatchObject({ groupId: GROUP, email: null, folderPath: '' });
    expect(notifications.create.mock.calls.map(c => c[0].userEmail).sort()).toEqual(['a@corp.com', 'b@corp.com']);
    expect(emailEvents.send).not.toHaveBeenCalled();
    expect(events('library_shared')[0].detail).toBe(`library ${LIB} "Clients" "" -> group ${GROUP} "Acctg" read by ${OWNER.id}`);
  });
  test('the same person twice is a 409 that hands back the existing share', async () => {
    mockState.createError = Object.assign(new Error('dup'), { code: '23505' });
    const res = await post({ email: 'tim@dts-tax.com', permission: 'read' });
    expect(res.status).toBe(409);
    expect(res.body.share).toEqual({ id: 'existing' });
    expect(auditLog.append).not.toHaveBeenCalled();
  });
  test('a library or group deleted mid-request is a 404, not a 500', async () => {
    mockState.createError = Object.assign(new Error('fk'), { code: '23503' });
    expect((await post({ email: 'tim@dts-tax.com', permission: 'read' })).status).toBe(404);
  });
});

describe('changing and removing a share', () => {
  const put = (permission) => request(app()).put(`/api/libraries/${LIB}/shares/${SHARE}`).send({ permission });
  beforeEach(() => { mockState.share = { id: SHARE, folder_path: '', subject_type: 'user', subject_email: 'tim@dts-tax.com', permission: 'read', group: null }; });
  test('the change is conditional on the level the caller saw', async () => {
    shares.setPermission.mockResolvedValueOnce({ ...mockState.share, permission: 'write' });
    const res = await put('write');
    expect(res.status).toBe(200);
    expect(shares.setPermission).toHaveBeenCalledWith(LIB, SHARE, 'read', 'write');
    expect(events('library_share_changed')[0].detail).toBe(`library ${LIB} "Clients" "" -> user "tim@dts-tax.com" read -> write by ${OWNER.id}`);
  });
  test('someone else changed it first: 409, nothing recorded', async () => {
    const res = await put('write'); // setPermission answers null, and the share is still there
    expect(res.status).toBe(409);
    expect(auditLog.append).not.toHaveBeenCalled();
  });
  test('the same level again writes and records nothing', async () => {
    expect((await put('read')).status).toBe(200);
    expect(shares.setPermission).not.toHaveBeenCalled();
    expect(auditLog.append).not.toHaveBeenCalled();
  });
  test('admin is never a share level', async () => {
    expect((await put('admin')).status).toBe(400);
  });
  test('an unknown or malformed share id is a 404', async () => {
    mockState.share = null;
    expect((await put('write')).status).toBe(404);
    expect((await request(app()).put(`/api/libraries/${LIB}/shares/nope`).send({ permission: 'write' })).status).toBe(404);
  });
  test('a group share: changing and removing it are chained with the group named', async () => {
    mockState.share = { id: SHARE, folder_path: 'Team', subject_type: 'group', subject_email: null, group_id: GROUP, group: { id: GROUP, name: 'Acctg' }, permission: 'write' };
    shares.setPermission.mockResolvedValueOnce({ ...mockState.share, permission: 'read' });
    await put('read');
    shares.deleteShare.mockResolvedValueOnce({ id: SHARE, permission: 'read' });
    await request(app()).delete(`/api/libraries/${LIB}/shares/${SHARE}`);
    expect(events('library_share_changed')[0].detail).toBe(`library ${LIB} "Clients" "Team" -> group ${GROUP} "Acctg" write -> read by ${OWNER.id}`);
    // the level recorded is the one the removed row had, not the one read before
    expect(events('library_unshared')[0].detail).toBe(`library ${LIB} "Clients" "Team" -> group ${GROUP} "Acctg" read by ${OWNER.id}`);
  });
  test('removing it is chained once; a second, concurrent removal is a 404', async () => {
    expect((await request(app()).delete(`/api/libraries/${LIB}/shares/${SHARE}`)).status).toBe(200);
    shares.deleteShare.mockResolvedValueOnce(null);
    expect((await request(app()).delete(`/api/libraries/${LIB}/shares/${SHARE}`)).status).toBe(404);
    expect(events('library_unshared')).toHaveLength(1);
  });
});

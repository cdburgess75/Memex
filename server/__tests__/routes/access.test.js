'use strict';
// The /api/access routes: signed in only; who may see a library or file at all (404,
// never a hint); who gets the full list (a manager) and who only their own access; bad
// input refused before anything is read; a failure is a plain 500 with nothing from the
// database in it. What the lists contain is tested against real Postgres in
// integration/accessKeys.pg and integration/accessDoors.pg.
const request = require('supertest');
const express = require('express');

const LIB = 'aaaaaaaa-0000-4000-8000-000000000001';
const DOC = 'dddddddd-0000-4000-8000-000000000001';
const ME = { id: '11111111-1111-4111-8111-111111111111', email: 'me@acme.test', verifiedEmail: 'me@acme.test', role: 'contributor' };
const mockState = { user: ME, listed: null, readable: null, admin: false, library: null, folderVisible: false, sharedAt: false, otherLibrary: null };

jest.mock('../../middleware/auth', () => (req, res, next) => {
  if (!mockState.user) return res.status(401).json({ error: 'Unauthorized' });
  req.user = { ...mockState.user };
  next();
});
jest.mock('../../lib/accessKeys', () => ({
  sharedWithMe: jest.fn(), libraryDoor: jest.fn(async () => ({ ok: 'library' })), fileDoor: jest.fn(async () => ({ ok: 'file' })),
}));
jest.mock('../../lib/libraries', () => ({
  visibleLibraryRow: jest.fn(async (_u, id) => (mockState.listed && id === LIB ? mockState.listed : null)),
  shapeLibrary: jest.fn((_u, r) => ({ id: r.id, name: r.name, can_manage: !!r.manage })),
  sharedFolderAt: jest.fn(async () => mockState.sharedAt),
  visibleLibrary: jest.fn(async (_u, id) => {
    const r = id === LIB ? mockState.listed : mockState.otherLibrary;
    return r ? { id: r.id, name: r.name, can_manage: !!r.manage } : null;
  }),
}));
jest.mock('../../lib/folderPreview', () => ({ preview: jest.fn(async () => ({ op: 'preview' })) }));
jest.mock('../../lib/libraryShares', () => ({ folderVisibleTo: jest.fn(async () => mockState.folderVisible) }));
jest.mock('../../lib/documentAccess', () => ({
  getAccessibleDocument: jest.fn(async ({ required }) => (required === 'admin' ? (mockState.admin ? { id: DOC } : null) : mockState.readable)),
}));
jest.mock('../../lib/db', () => ({ queryOne: jest.fn(async () => mockState.library), query: jest.fn() }));

const accessKeys = require('../../lib/accessKeys');
const libraryShares = require('../../lib/libraryShares');
const documentAccess = require('../../lib/documentAccess');
const folderPreview = require('../../lib/folderPreview');
const db = require('../../lib/db');
const app = () => { const a = express(); a.use('/api/access', require('../../routes/access')); return a; };
const get = (url) => request(app()).get(url);

beforeEach(() => {
  jest.clearAllMocks();
  Object.assign(mockState, { user: ME, listed: null, readable: null, admin: false, library: null, folderVisible: false, sharedAt: false, otherLibrary: null });
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => console.error.mockRestore());

describe('GET /api/access/shared-with-me', () => {
  test('needs a signed-in caller', async () => {
    mockState.user = null;
    expect((await get('/api/access/shared-with-me')).status).toBe(401);
    expect(accessKeys.sharedWithMe).not.toHaveBeenCalled();
  });
  test('any role gets its own list', async () => {
    mockState.user = { ...ME, role: 'viewer' };
    accessKeys.sharedWithMe.mockResolvedValue({ email_verified: true, libraries: [] });
    const res = await get('/api/access/shared-with-me');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ email_verified: true, libraries: [] });
    expect(accessKeys.sharedWithMe).toHaveBeenCalledWith(expect.objectContaining({ id: ME.id, role: 'viewer' }));
  });
  test('a database failure is a generic 500', async () => {
    accessKeys.sharedWithMe.mockRejectedValue(Object.assign(new Error('relation "secret_table" does not exist'), { code: '42P01' }));
    const res = await get('/api/access/shared-with-me');
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('secret_table');
  });
});

describe('GET /api/access/libraries/:id', () => {
  test('a library the caller does not see listed is a 404, whatever the id', async () => {
    for (const id of [LIB, 'not-a-uuid', "'; DROP TABLE x"]) {
      const res = await get(`/api/access/libraries/${encodeURIComponent(id)}`);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Library not found' });
    }
    expect(accessKeys.libraryDoor).not.toHaveBeenCalled();
  });
  test('a malformed folder is refused before anything else is read', async () => {
    mockState.listed = { id: LIB, name: 'Clients', manage: true };
    const controlChar = encodeURIComponent('a\u0001b');
    for (const q of ['?folder=../x', '?folder=a/./b', '?folder[]=a', '?folder=a&folder=b', `?folder=${controlChar}`]) {
      const res = await get(`/api/access/libraries/${LIB}${q}`);
      expect([q, res.status, res.body.error]).toEqual([q, 400, 'Bad folder path']);
    }
    expect(libraryShares.folderVisibleTo).not.toHaveBeenCalled();
    expect(accessKeys.libraryDoor).not.toHaveBeenCalled();
  });
  test('a manager asking about a folder that is neither visible to them nor shared gets a 404', async () => {
    mockState.listed = { id: LIB, name: 'Clients', manage: true };
    const res = await get(`/api/access/libraries/${LIB}?folder=Private%20Stuff`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Folder not found in this library' });
    expect(accessKeys.libraryDoor).not.toHaveBeenCalled();
  });
  test.each([['visible to them', { folderVisible: true }], ['shared, with no files yet', { sharedAt: true }]])('a folder %s is a door', async (_w, st) => {
    Object.assign(mockState, { listed: { id: LIB, name: 'Clients', manage: true }, ...st });
    const res = await get(`/api/access/libraries/${LIB}?folder=Clients%2FMender`);
    expect(res.status).toBe(200);
    expect(accessKeys.libraryDoor).toHaveBeenCalledWith(expect.objectContaining({ id: ME.id }), expect.objectContaining({ path: 'Clients/Mender', manager: true }));
  });
  test('someone who only sees it listed gets their own access, with no folder check that could reveal anything', async () => {
    mockState.listed = { id: LIB, name: 'Clients', manage: false };
    const res = await get(`/api/access/libraries/${LIB}?folder=Anything`);
    expect(res.status).toBe(200);
    expect(libraryShares.folderVisibleTo).not.toHaveBeenCalled();
    expect(accessKeys.libraryDoor.mock.calls[0][1]).toMatchObject({ path: 'Anything', manager: false });
  });
  test('the library root is the default door', async () => {
    mockState.listed = { id: LIB, name: 'Clients', manage: true };
    await get(`/api/access/libraries/${LIB}`);
    await get(`/api/access/libraries/${LIB}?folder=`);
    expect(accessKeys.libraryDoor.mock.calls.map(c => c[1].path)).toEqual(['', '']);
  });
  test('a failure is a generic 500', async () => {
    mockState.listed = { id: LIB, name: 'Clients', manage: true };
    accessKeys.libraryDoor.mockRejectedValueOnce(new Error('column "secret" does not exist'));
    const res = await get(`/api/access/libraries/${LIB}`);
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('secret');
  });
});

describe('GET /api/access/files/:id', () => {
  const doc = (over = {}) => ({ id: DOC, name: 'A/x.pdf', library_id: LIB, library_scoped: true, uploaded_by: 'u9', uploaded_by_email: 'up@acme.test', ...over });
  test('a malformed id is a 404 without touching the database', async () => {
    const res = await get('/api/access/files/not-a-uuid');
    expect(res.status).toBe(404);
    expect(documentAccess.getAccessibleDocument).not.toHaveBeenCalled();
  });
  test('a file the caller cannot read is a 404', async () => {
    const res = await get(`/api/access/files/${DOC}`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Document not found' });
    expect(accessKeys.fileDoor).not.toHaveBeenCalled();
  });
  test('a reader who does not manage the file gets only their own access', async () => {
    mockState.readable = doc();
    await get(`/api/access/files/${DOC}`);
    expect(accessKeys.fileDoor.mock.calls[0][1]).toMatchObject({ full: false });
  });
  test('a viewer never gets the full list, even with a "Can manage" grant', async () => {
    Object.assign(mockState, { user: { ...ME, role: 'viewer' }, readable: doc(), admin: true });
    await get(`/api/access/files/${DOC}`);
    expect(accessKeys.fileDoor.mock.calls[0][1]).toMatchObject({ full: false });
  });
  test("someone who manages a library file but not its library sees the file's own keys only", async () => {
    Object.assign(mockState, { readable: doc(), admin: true, library: { id: LIB, name: 'Clients', owner_id: 'someone-else', owner_email: 'o@acme.test' } });
    await get(`/api/access/files/${DOC}`);
    expect(accessKeys.fileDoor.mock.calls[0][1]).toMatchObject({ full: true, detail: 'hidden' });
  });
  test("the library's owner, an admin, and anyone managing a personal file see everything", async () => {
    const lib = { id: LIB, name: 'Clients', owner_id: ME.id, owner_email: ME.email };
    Object.assign(mockState, { readable: doc(), admin: true, library: lib });
    await get(`/api/access/files/${DOC}`);
    Object.assign(mockState, { user: { ...ME, id: 'admin-id', role: 'admin' }, library: { ...lib, owner_id: 'x' } });
    await get(`/api/access/files/${DOC}`);
    Object.assign(mockState, { user: ME, readable: doc({ library_scoped: false }), library: { ...lib, owner_id: 'x' } });
    await get(`/api/access/files/${DOC}`);
    expect(accessKeys.fileDoor.mock.calls.map(c => c[1].detail)).toEqual(['full', 'full', 'full']);
  });
  test('a demoted owner (now a viewer) manages nothing', async () => {
    Object.assign(mockState, { user: { ...ME, role: 'viewer' }, readable: doc(), admin: false, library: { id: LIB, name: 'Clients', owner_id: ME.id, owner_email: ME.email } });
    await get(`/api/access/files/${DOC}`);
    expect(accessKeys.fileDoor.mock.calls[0][1]).toMatchObject({ full: false, detail: 'hidden' });
  });
  test('a file outside any library reads no library', async () => {
    Object.assign(mockState, { readable: doc({ library_id: null, library_scoped: false }), admin: true });
    await get(`/api/access/files/${DOC}`);
    expect(db.queryOne).not.toHaveBeenCalled();
    expect(accessKeys.fileDoor.mock.calls[0][1]).toMatchObject({ library: null, detail: 'full' });
  });
});

describe('POST /api/access/folder-preview', () => {
  beforeEach(() => { mockState.listed = { id: LIB, name: 'Clients', manage: true }; });
  const post = (body) => {
    const a = express();
    a.use(express.json());
    a.use('/api/access', require('../../routes/access'));
    return request(a).post('/api/access/folder-preview').send(body);
  };
  test('needs ops, and only knows the four folder operations', async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ ops: [{ op: 'explode', library_id: LIB, path: 'A' }] })).status).toBe(400);
  });
  test('a library the caller does not see is a 404', async () => {
    mockState.listed = null;
    expect((await post({ ops: [{ op: 'rename', library_id: LIB, path: 'A', name: 'B' }] })).status).toBe(404);
  });
  test('a bad path or name is refused before anything is read', async () => {
    for (const op of [{ op: 'rename', library_id: LIB, path: '../x', name: 'B' }, { op: 'rename', library_id: LIB, path: 'A', name: 'a/b' }]) {
      expect((await post({ ops: [op] })).status).toBe(400);
    }
  });
  test('each side is visible only to whoever manages that library', async () => {
    await post({ ops: [{ op: 'reparent', library_id: LIB, path: 'A', target: 'B' }] });
    expect(folderPreview.preview).toHaveBeenCalledWith(
      expect.objectContaining({ op: 'reparent', path: 'A', newPath: 'B/A' }),
      { canManageSource: true, canManageTarget: true });
    mockState.listed = { id: LIB, name: 'Clients', manage: false };
    await post({ ops: [{ op: 'rename', library_id: LIB, path: 'A', name: 'B' }] });
    expect(folderPreview.preview).toHaveBeenLastCalledWith(expect.anything(), { canManageSource: false, canManageTarget: false });
  });
});

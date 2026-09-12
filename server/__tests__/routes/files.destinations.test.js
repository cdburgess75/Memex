'use strict';
// Every write checks, before anything is stored, that the caller may add files at the
// destination (libraries.writeRight), and records whether the result is library content.
const request = require('supertest');
const express = require('express');

const mockQueries = [];
const mockRows = { doc: null, version: null, session: null, transfer: [], share: null, keptCount: 0, grants: [], library: null };
jest.mock('../../lib/db', () => {
  const api = {
  query: jest.fn(async (sql, params) => {
    mockQueries.push({ sql, params });
    // the per-file rename/move is a conditional UPDATE now, and runs on the client
    if (/^\s*UPDATE documents SET name = \$2, library_scoped = \$3/.test(sql)) return [{ id: 'd1', name: params[1] }];
    if (/WHERE d\.id = ANY\(\$6::uuid\[\]\)/.test(sql)) return mockRows.transfer;
    if (/SELECT DISTINCT d\.library_id/.test(sql)) return [{ library_id: 'aaaaaaaa-0000-4000-8000-000000000001' }];
    if (/FROM library_grants g\b[\s\S]*FOR UPDATE/.test(sql)) return mockRows.grants;
    return [];
  }),
  queryOne: jest.fn(async (sql, params) => {
    mockQueries.push({ sql, params });
    if (/INSERT INTO documents/.test(sql)) return { id: 'new-doc', name: params[0] };
    if (/INSERT INTO upload_sessions/.test(sql)) return { id: 's1', received_chunks: [] };
    if (/FROM document_share_links s\s+JOIN documents d/.test(sql)) return mockRows.share;
    if (/SELECT count\(\*\)::int AS n FROM documents d/.test(sql)) return { n: mockRows.keptCount };
    if (/SELECT owner_id FROM libraries WHERE id = \$1/.test(sql)) return mockRows.library;
    if (/INSERT INTO folder_ops/.test(sql)) return { op_id: '99999999-0000-4000-8000-000000000009' };
    if (/FROM upload_sessions WHERE id = \$1 AND uploaded_by = \$2/.test(sql)) return mockRows.session;
    // the name the row has NOW, read under the library's lock (restore-version)
    if (/^\s*SELECT name FROM documents WHERE id = \$1$/.test(sql)) return mockRows.doc;
    if (/FROM document_versions\s+WHERE id = \$1 AND document_id = \$2/.test(sql)) return mockRows.version;
    if (/UPDATE documents\s+SET name = \$1, size = \$2/.test(sql)) return { id: 'd1', name: params[0] };
    if (/UPDATE documents SET name = \$2, library_scoped = \$3/.test(sql)) return { id: 'd1', name: params[1] };
    if (/COALESCE\(MAX\(version_number\)/.test(sql)) return { next: 1 };
    // folderLibraryId() with an explicit library: the folder is there
    if (/SELECT 1 FROM documents d\s+WHERE d\.deleted_at IS NULL AND d\.library_id = \$1 AND starts_with/.test(sql)) return { '?column?': 1 };
    return null;
  }),
  };
  // The folder operations, and every placement of a document by name, run inside one
  // transaction; the stand-in hands the callback a client backed by the same mocks (a pg
  // client answers { rows }).
  api.withTransaction = jest.fn(async (fn) => fn({ query: async (sql, params = []) => {
      // The lock's own plumbing (lib/folderLocks) answers itself: it is not something a
      // test mocks, and letting it reach the mocks would consume their queued rows.
      if (/^\s*(SET LOCAL|SELECT DISTINCT hashtext|SELECT pg_advisory)/i.test(sql)) return { rows: [] };
      const rows = await api.query(sql, params);
      if (rows && rows.length) return { rows };
      // the single-row mock answers reads, and the writes that RETURN the row they wrote
      if (/^\s*SELECT/i.test(sql) || /RETURNING/i.test(sql)) {
        const one = await api.queryOne(sql, params);
        return { rows: one ? [one] : [] };
      }
      return { rows: [] };
    } }));
  api.paramList = jest.requireActual('../../lib/db').paramList;
  return api;
});
jest.mock('../../lib/storage', () => ({
  upload: jest.fn().mockResolvedValue(undefined), uploadStream: jest.fn().mockResolvedValue({ size: 3 }),
  download: jest.fn().mockResolvedValue(Buffer.from('abc')), del: jest.fn().mockResolvedValue(undefined),
  copy: jest.fn().mockResolvedValue(undefined), isLocalProvider: jest.fn().mockResolvedValue(true),
  getUrl: jest.fn(), localBase: jest.fn(), validateLocalToken: jest.fn(),
}));
jest.mock('../../lib/settings', () => ({ getOrEnv: jest.fn().mockResolvedValue(null) }));
jest.mock('../../lib/textExtraction', () => ({ extractText: jest.fn().mockResolvedValue(null) }));
jest.mock('../../lib/notifications', () => ({ create: jest.fn().mockResolvedValue({}) }));
jest.mock('../../lib/emailEvents', () => ({ send: jest.fn().mockResolvedValue({}) }));
jest.mock('../../lib/auditLog', () => ({ append: jest.fn().mockResolvedValue({}) }));
jest.mock('../../lib/uploadNotify', () => ({ record: jest.fn() }));

const LIB = 'aaaaaaaa-0000-4000-8000-000000000001';
const mockRight = { value: { right: 'owner', scoped: true } };
jest.mock('../../lib/libraries', () => ({
  ...jest.requireActual('../../lib/libraries'),
  writeRight: jest.fn(async (_u, _lib, path) => (typeof mockRight.value === 'function' ? mockRight.value(String(path ?? '')) : mockRight.value)),
  sharedFolderAt: jest.fn(async () => false),
  defaultLibraryId: jest.fn(async () => 'aaaaaaaa-0000-4000-8000-000000000001'),
}));
jest.mock('../../lib/documentAccess', () => ({
  ...jest.requireActual('../../lib/documentAccess'),
  getAccessibleDocument: jest.fn(async () => mockRows.doc),
  resolveActor: jest.fn(async (id) => ({ id, role: 'contributor', email: 'creator@x.com', emailVerified: true })),
  grantOwnerAdmin: jest.fn().mockResolvedValue(undefined),
}));

const USER = { id: '11111111-1111-4111-8111-111111111111', email: 'me@x.com', role: 'contributor' };
const mockAuth = { user: null };
jest.mock('../../middleware/auth', () => (req, _res, next) => { req.user = { ...mockAuth.user }; next(); });
const ADMIN = { id: '44444444-4444-4444-8444-444444444444', email: 'admin@x.com', role: 'admin' };

const libraries = require('../../lib/libraries');
const storage = require('../../lib/storage');
const app = () => { const a = express(); a.use(express.json()); a.use('/api/files', require('../../routes/files')); return a; };
const inserted = () => mockQueries.find(q => /INSERT INTO documents/.test(q.sql));
// the value an INSERT INTO documents gave one column (resolving $n against its params)
const insertedValue = (col) => {
  const q = inserted();
  const m = q.sql.match(/INSERT INTO documents\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)/);
  const cols = m[1].split(',').map(c => c.trim());
  const val = m[2].split(',').map(v => v.trim())[cols.indexOf(col)];
  const ref = val && val.match(/^\$(\d+)$/);
  return ref ? q.params[Number(ref[1]) - 1] : val;
};
const REFUSED = { status: 403, error: "You can't add files here. Ask the library owner for Read-Write access." };

beforeEach(() => {
  mockQueries.length = 0;
  mockRight.value = { right: 'owner', scoped: true };
  Object.assign(mockRows, { doc: null, version: null, session: null, transfer: [], share: null, keptCount: 0, grants: [], library: null });
  mockAuth.user = USER;
  jest.clearAllMocks();
});

describe('uploads and new files', () => {
  const stream = (q = `displayName=Clients/Acme/a.txt&libraryId=${LIB}`) =>
    request(app()).post(`/api/files/upload-stream?${q}`).set('Content-Type', 'text/plain').send('abc');

  test('a refused upload stores nothing', async () => {
    mockRight.value = REFUSED;
    const res = await stream();
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Read-Write/);
    expect(storage.uploadStream).not.toHaveBeenCalled();
    expect(inserted()).toBeUndefined();
  });
  test('the right is checked at the folder the file lands in', async () => {
    await stream();
    expect(libraries.writeRight).toHaveBeenCalledWith(expect.objectContaining({ id: USER.id }), LIB, 'Clients/Acme');
  });
  test.each([[true], [false]])('library_scoped is recorded as the right says (%p)', async (scoped) => {
    mockRight.value = { right: scoped ? 'owner' : 'legacy', scoped };
    await stream();
    expect(inserted().params[8]).toBe(scoped);
  });
  test('a malformed library id is a 400 before anything is stored', async () => {
    const res = await stream('displayName=a.txt&libraryId=lib-1');
    expect(res.status).toBe(400);
    expect(storage.uploadStream).not.toHaveBeenCalled();
  });
  test('"New file" checks its destination and records library content', async () => {
    mockRight.value = REFUSED;
    expect((await request(app()).post('/api/files/create').send({ name: 'Plan', type: 'docx', folder: 'Q1', library_id: LIB })).status).toBe(403);
    expect(storage.upload).not.toHaveBeenCalled();
    mockRight.value = { right: 'grant', scoped: true };
    await request(app()).post('/api/files/create').send({ name: 'Plan', type: 'docx', folder: 'Q1', library_id: LIB });
    // asked before anything is stored, and again on the transaction's client, where the
    // destination is resolved under the library's lock
    expect(libraries.writeRight).toHaveBeenLastCalledWith(expect.anything(), LIB, 'Q1', expect.anything());
    expect(inserted().params[9]).toBe(true);
  });
  test('a chunked upload naming its library is refused at the start', async () => {
    mockRight.value = REFUSED;
    const res = await request(app()).post('/api/files/uploads').send({ displayName: 'big.bin', size: 10, libraryId: LIB });
    expect(res.status).toBe(403);
    expect(mockQueries.some(q => /INSERT INTO upload_sessions/.test(q.sql))).toBe(false);
  });
  test('and checked again at completion, before the file is assembled', async () => {
    mockRows.session = { id: 's1', status: 'active', name: 'Q1/big.bin', total_chunks: 0, received_chunks: [], storage_path: 'p', mime_type: 'x' };
    mockRight.value = REFUSED;
    expect((await request(app()).post('/api/files/uploads/s1/complete').send({ libraryId: LIB })).status).toBe(403);
    expect(storage.uploadStream).not.toHaveBeenCalled();
  });
});

describe('renames, restores and transfers', () => {
  const doc = (over) => ({ id: 'd1', name: 'Clients/a.txt', library_id: LIB, library_scoped: false, uploaded_by: USER.id, storage_path: 'p', mime_type: 'text/plain', ...over });
  test('a rename that keeps the folder needs no destination check', async () => {
    mockRows.doc = doc();
    await request(app()).put('/api/files/d1/rename').send({ name: 'Clients/b.txt' });
    expect(libraries.writeRight).not.toHaveBeenCalled();
  });
  test('a rename into another folder is a move: checked there, and refused without a right', async () => {
    mockRows.doc = doc();
    mockRight.value = REFUSED;
    expect((await request(app()).put('/api/files/d1/rename').send({ name: 'Shared/a.txt' })).status).toBe(403);
    expect(libraries.writeRight).toHaveBeenCalledWith(expect.anything(), LIB, 'Shared');
    expect(mockQueries.some(q => /UPDATE documents SET name = \$2, library_scoped/.test(q.sql))).toBe(false);
  });
  test('moving your own file where writes are scoped makes it library content; someone else\'s stays personal', async () => {
    mockRows.doc = doc();
    await request(app()).put('/api/files/d1/rename').send({ name: 'Shared/a.txt' });
    expect(mockQueries.find(q => /library_scoped = \$3/.test(q.sql)).params[2]).toBe(true);
    mockQueries.length = 0;
    mockRows.doc = doc({ uploaded_by: '99999999-9999-4999-8999-999999999999' });
    await request(app()).put('/api/files/d1/rename').send({ name: 'Shared/a.txt' });
    expect(mockQueries.find(q => /library_scoped = \$3/.test(q.sql)).params[2]).toBe(false);
  });
  test('library content never goes back to being personal', async () => {
    mockRows.doc = doc({ library_scoped: true });
    mockRight.value = { right: 'legacy', scoped: false };
    await request(app()).put('/api/files/d1/rename').send({ name: 'Other/a.txt' });
    expect(mockQueries.find(q => /library_scoped = \$3/.test(q.sql)).params[2]).toBe(true);
  });
  test('restoring a version keeps the file in its current folder', async () => {
    mockRows.doc = doc({ name: 'Now/Here/report.docx' });
    mockRows.version = { id: 'v1', version_number: 2, name: 'Old/Place/report-v2.docx', size: 1, mime_type: 'x', storage_path: 'vp' };
    await request(app()).post('/api/files/d1/restore-version/v1');
    const upd = mockQueries.find(q => /SET name = \$1, size = \$2/.test(q.sql));
    expect(upd.params[0]).toBe('Now/Here/report-v2.docx');
  });
  test('a library transfer checks the target once per folder, and refuses the whole move without a right', async () => {
    mockRows.transfer = [doc({ id: 'd1', name: 'A/1.txt' }), doc({ id: 'd2', name: 'A/2.txt' }), doc({ id: 'd3', name: 'B/3.txt' })];
    mockRight.value = REFUSED;
    const res = await request(app()).post('/api/files/library-transfer').send({ ids: ['d1', 'd2', 'd3'], libraryId: LIB, mode: 'move' });
    expect(res.status).toBe(403);
    expect(libraries.writeRight.mock.calls.map(c => c[2])).toEqual(['A']);
    expect(mockQueries.some(q => /UPDATE documents SET library_id/.test(q.sql))).toBe(false);
  });
  const OTHER = 'bbbbbbbb-0000-4000-8000-000000000002';
  test('library content is not moved into a library held only under the old open rule', async () => {
    mockRows.transfer = [doc({ id: 'd1', name: 'A/1.txt', library_scoped: true, library_id: OTHER, library_owner_id: USER.id }), doc({ id: 'd2', name: 'A/2.txt', library_id: OTHER })];
    mockRight.value = { right: 'legacy', scoped: false };
    const res = await request(app()).post('/api/files/library-transfer').send({ ids: ['d1', 'd2'], libraryId: LIB, mode: 'move' });
    expect(res.body).toMatchObject({ count: 1, skipped: 0, kept: 1 });
    const upd = mockQueries.filter(q => /UPDATE documents SET library_id/.test(q.sql));
    expect(upd.flatMap(q => q.params[1])).toEqual(['d2']);
  });
  // Taking library content to ANOTHER library hands it to that library's owner and ends
  // its shares; a Read-Write share doesn't carry that, only managing the source library.
  test.each([
    ['a Read-Write sharee (not the source owner)', { library_owner_id: '99999999-9999-4999-8999-999999999999' }, USER, 0, 1],
    ['the source library owner', { library_owner_id: USER.id }, USER, 1, 0],
    ['an admin', { library_owner_id: '99999999-9999-4999-8999-999999999999' }, { ...USER, role: 'admin' }, 1, 0],
    ['anyone, within the same library', { library_owner_id: '99999999-9999-4999-8999-999999999999', library_id: LIB }, USER, 1, 0],
  ])('moving library content to another library: %s', async (_l, over, who, count, kept) => {
    mockAuth.user = who;
    mockRows.transfer = [doc({ id: 'd1', name: 'A/1.txt', library_scoped: true, library_id: OTHER, ...over })];
    mockRight.value = { right: 'owner', scoped: true };
    const res = await request(app()).post('/api/files/library-transfer').send({ ids: ['d1'], libraryId: LIB, mode: 'move' });
    expect(res.body).toMatchObject({ count, kept });
    expect(mockQueries.some(q => /UPDATE documents SET library_id/.test(q.sql))).toBe(count > 0);
  });
});

describe('folders', () => {
  const post = (url, body) => request(app()).post(`/api/files/folder${url}`).send({ source_library_id: LIB, ...body });
  test('taking a shared folder to another library is refused to someone who does not manage it', async () => {
    mockRows.grants = [{ id: 'g1', folder_path: 'Clients/Acme', permission: 'read' }];
    const res = await post('/move', { path: 'Clients/Acme', library_id: 'bbbbbbbb-0000-4000-8000-000000000002' });
    expect([res.status, res.body.code]).toEqual([403, 'FOLDER_MANAGER_ONLY']);
    expect(mockQueries.some(q => /^\s*UPDATE documents/.test(q.sql))).toBe(false);
  });
  // Deleting a folder ENDS its sharing, so it is the library owner's to delete -- and
  // whoever merely writes there is told that, rather than being told it can't be done.
  test('deleting a shared folder is refused to someone who does not manage the library', async () => {
    mockRows.grants = [{ id: 'g1', folder_path: 'Clients/Acme', permission: 'read' }];
    const res = await post('/delete', { path: 'Clients/Acme' });
    expect([res.status, res.body.code]).toEqual([403, 'FOLDER_MANAGER_ONLY']);
    expect(res.body.error).toMatch(/owns this library/);
    expect(mockQueries.some(q => /^\s*UPDATE documents/.test(q.sql))).toBe(false);
    expect(mockQueries.some(q => /INSERT INTO folder_ops/.test(q.sql))).toBe(false);
  });
  test('the library owner may delete it, and the shares end into the record', async () => {
    mockRows.grants = [{ id: 'g1', folder_path: 'Clients/Acme', permission: 'read' }];
    mockRows.library = { owner_id: USER.id };
    const res = await post('/delete', { path: 'Clients/Acme' });
    expect(res.status).toBe(200);
    expect(res.body.op_id === null || typeof res.body.op_id === 'string').toBe(true);
    expect(mockQueries.some(q => /INSERT INTO folder_ops/.test(q.sql))).toBe(true);
    expect(mockQueries.some(q => /DELETE FROM library_grants g[\s\S]*INSERT INTO library_grants_ended/.test(q.sql))).toBe(true);
    expect(res.body.undo_until).toEqual(expect.any(String));
  });
  test.each([
    ['rename', '/rename', { path: 'Clients/Acme', name: 'Acme2' }, 'Clients/Acme2'],
    ['reparent', '/reparent', { path: 'Clients/Acme', target: 'Archive' }, 'Archive/Acme'],
  ])('%s carries the shares instead of refusing, and never asks whether one is there', async (_n, url, body, to) => {
    const res = await post(url, body);
    expect(res.status).toBe(200);
    expect(libraries.sharedFolderAt).not.toHaveBeenCalled();
    // the files, then the shares at and below, in that order: moving the grants first
    // would strip coverage from the very people whose shares are moving
    const names = mockQueries.map(q => q.sql);
    const docs = names.findIndex(sql => /^\s*UPDATE documents d SET name = \$2/.test(sql));
    const grants = names.findIndex(sql => /^\s*UPDATE library_grants g/.test(sql));
    expect(docs).toBeGreaterThan(-1);
    expect(grants).toBeGreaterThan(docs);
    const upd = mockQueries[grants];
    expect(upd.sql).toMatch(/folder_path = \$2 \|\| substring\(g\.folder_path from \$3::int\)/);
    expect(upd.params).toEqual([LIB, to, 'Clients/Acme'.length + 1, 'Clients/Acme']);
    // how many shares moved is a count of things the caller may not be able to see, so
    // it goes to whoever manages the library; everyone else is told only that the
    // sharing came along
    expect(res.body).toMatchObject({ shares_kept: false });
    expect(res.body.shares_moved).toBeUndefined();
  });
  test('a folder operation needs the right where the folder SITS, not inside it', async () => {
    // Read-Write on the folder itself is the right to fill and reorganise what is in it;
    // its own name and place belong to whoever can write in the folder above.
    mockRight.value = (path) => (path === 'Clients' ? REFUSED : { right: 'grant', scoped: true });
    for (const [url, body] of [['/rename', { path: 'Clients/Acme', name: 'Acme2' }], ['/reparent', { path: 'Clients/Acme', target: 'Archive' }]]) {
      mockQueries.length = 0;
      expect((await post(url, body)).status).toBe(403);
      expect(mockQueries.some(q => /^\s*UPDATE documents/.test(q.sql))).toBe(false);
    }
    expect(libraries.writeRight).toHaveBeenCalledWith(expect.anything(), LIB, 'Clients');
  });
  test('moving a folder into another needs the right to add files there', async () => {
    mockRight.value = (path) => (path === 'Shared/Acme' ? REFUSED : { right: 'owner', scoped: true });
    expect((await post('/reparent', { path: 'Clients/Acme', target: 'Shared' })).status).toBe(403);
    expect(libraries.writeRight).toHaveBeenCalledWith(expect.anything(), LIB, 'Shared/Acme', expect.anything());
    expect(mockQueries.some(q => /^\s*UPDATE documents/.test(q.sql))).toBe(false);
  });
  test('a folder rename keeps the folder where it is, so nothing changes scope', async () => {
    await post('/rename', { path: 'Clients/Acme', name: 'Acme2' });
    const upd = mockQueries.find(q => /UPDATE documents d SET name = \$2/.test(q.sql));
    expect(upd.sql).toMatch(/^\s*UPDATE documents d SET name = \$2 \|\| substring\(d\.name from \$3::int\)\s+WHERE/);
    // ...and somebody else's personal file inside it is not part of the folder: the
    // rule's five parameters, then the mover, and nothing about scope
    expect(upd.sql).toMatch(/AND \(d\.library_scoped OR d\.uploaded_by IS NOT DISTINCT FROM \$10::uuid\)/);
    expect(upd.params).toHaveLength(10);
    expect(upd.params[9]).toBe(USER.id);
  });
  test('a folder rename still needs a right to change files there', async () => {
    mockRight.value = (path) => (path === 'Clients/Acme2' ? REFUSED : { right: 'owner', scoped: true });
    expect((await post('/rename', { path: 'Clients/Acme', name: 'Acme2' })).status).toBe(403);
    expect(libraries.writeRight).toHaveBeenCalledWith(expect.anything(), LIB, 'Clients/Acme2', expect.anything());
    expect(mockQueries.some(q => /^\s*UPDATE documents/.test(q.sql))).toBe(false);
  });
  test("a reparent without a right at the destination says so, whether or not a share sits there", async () => {
    // (answering FOLDER_SHARED first would let anyone probe for shares where they can't write)
    mockRight.value = (path) => (path === 'Shared/Acme' ? REFUSED : { right: 'owner', scoped: true });
    libraries.sharedFolderAt.mockImplementation(async (_lib, p) => p === 'Shared/Acme');
    try {
      const res = await post('/reparent', { path: 'Clients/Acme', target: 'Shared' });
      expect(res.status).toBe(403);
      expect(res.body.code).toBeUndefined();
    } finally { libraries.sharedFolderAt.mockImplementation(async () => false); }
  });
  test('a reparent carries the move rule: only the mover\'s own files, with its parameters after the rest', async () => {
    await post('/reparent', { path: 'Clients/Acme', target: 'Archive' });
    const upd = mockQueries.find(q => /UPDATE documents d SET name = \$2/.test(q.sql));
    expect(upd.sql).toMatch(/library_scoped = d\.library_scoped OR \(\$10::boolean AND d\.uploaded_by IS NOT DISTINCT FROM \$11\)/);
    expect(upd.sql).toMatch(/AND \(d\.library_scoped OR d\.uploaded_by IS NOT DISTINCT FROM \$12::uuid\)/);
    expect(upd.params.slice(9)).toEqual([true, USER.id, USER.id]);
  });
  test('a folder moved to a library held only under the old open rule leaves library content behind, and says how much', async () => {
    mockRight.value = { right: 'legacy', scoped: false };
    mockRows.keptCount = 2;
    const res = await post('/move', { path: 'Clients/Acme', library_id: 'bbbbbbbb-0000-4000-8000-000000000002' });
    const upd = mockQueries.find(q => /UPDATE documents d SET library_id = \$2/.test(q.sql));
    expect(upd.sql).toMatch(/NOT d\.library_scoped OR \$11::boolean/);
    expect(upd.sql).toMatch(/library_scoped = d\.library_scoped OR \(\$9::boolean AND d\.uploaded_by IS NOT DISTINCT FROM \$10::uuid\)/);
    expect(upd.params.slice(8)).toEqual([false, USER.id, false]);
    expect(res.body.kept).toBe(2);
  });
  test('a folder copy checks the target library at that folder, and records scope as the right says', async () => {
    mockRight.value = REFUSED;
    expect((await post('/copy', { path: 'Clients/Acme', library_id: LIB })).status).toBe(403);
    expect(libraries.writeRight).toHaveBeenCalledWith(expect.anything(), LIB, 'Clients/Acme');
    expect(storage.copy).not.toHaveBeenCalled();
  });
  test('creating a folder needs a right there, and its marker is library content when that says so', async () => {
    mockRight.value = REFUSED;
    expect((await request(app()).post('/api/files/folder').send({ path: 'New', library_id: LIB })).status).toBe(403);
    expect(storage.upload).not.toHaveBeenCalled();
    mockRight.value = { right: 'owner', scoped: true };
    await request(app()).post('/api/files/folder').send({ path: 'New', library_id: LIB });
    expect(inserted().params[6]).toBe(true);
  });
});

// An admin tidying folders must never turn a colleague's private file into library
// content: the flag never flips back, and the library's shares would hand it out.
describe('an admin moving other people\'s files', () => {
  const OTHER = '99999999-9999-4999-8999-999999999999';
  const doc = (over) => ({ id: 'd1', name: 'Clients/a.txt', library_id: LIB, library_scoped: false, uploaded_by: OTHER, storage_path: 'p', mime_type: 'text/plain', ...over });
  beforeEach(() => { mockAuth.user = ADMIN; mockRight.value = { right: 'admin', scoped: true }; });
  const post = (url, body) => request(app()).post(`/api/files/folder${url}`).send({ source_library_id: LIB, ...body });
  test('a file rename into another folder leaves a colleague\'s file personal', async () => {
    mockRows.doc = doc();
    await request(app()).put('/api/files/d1/rename').send({ name: 'Shared/a.txt' });
    expect(mockQueries.find(q => /library_scoped = \$3/.test(q.sql)).params[2]).toBe(false);
  });
  test('but the admin\'s own file becomes library content, as anyone\'s would', async () => {
    mockRows.doc = doc({ uploaded_by: ADMIN.id });
    await request(app()).put('/api/files/d1/rename').send({ name: 'Shared/a.txt' });
    expect(mockQueries.find(q => /library_scoped = \$3/.test(q.sql)).params[2]).toBe(true);
  });
  test('a library transfer moves a colleague\'s files without scoping them', async () => {
    mockRows.transfer = [doc({ id: 'd1', name: 'A/1.txt' }), doc({ id: 'd2', name: 'A/2.txt', uploaded_by: ADMIN.id })];
    await request(app()).post('/api/files/library-transfer').send({ ids: ['d1', 'd2'], libraryId: LIB, mode: 'move' });
    const scoped = mockQueries.find(q => /SET library_id = \$1, library_scoped = true/.test(q.sql));
    const plain = mockQueries.find(q => /SET library_id = \$1 WHERE id/.test(q.sql));
    expect(scoped.params[1]).toEqual(['d2']);
    expect(plain.params[1]).toEqual(['d1']);
  });
  test.each([
    ['reparent', '/reparent', { target: 'Archive' }, 9],
    ['move', '/move', { library_id: LIB }, 8],   // $9 scoped, $10 the mover
  ])('a folder %s scopes only the admin\'s own files (no admin exception in the SQL)', async (_n, url, body, from) => {
    await post(url, { path: 'Clients/Acme', ...body });
    const upd = mockQueries.find(q => /^\s*UPDATE documents d SET (name = \$2|library_id = \$2::uuid)/.test(q.sql));
    expect(upd.sql).toMatch(/d\.uploaded_by IS NOT DISTINCT FROM \$\d+(::uuid)?\)/);
    expect(upd.sql).not.toMatch(/OR \$\d+::boolean\)\)/);
    expect(upd.params.slice(from, from + 2)).toEqual([true, ADMIN.id]);
  });
});

describe('the plain upload and the public-link upload', () => {
  test('POST /upload checks the folder the file lands in before storing, and records scope', async () => {
    mockRight.value = REFUSED;
    const refused = await request(app()).post('/api/files/upload').field('displayName', 'Clients/Acme/a.txt').field('libraryId', LIB).attach('file', Buffer.from('abc'), 'a.txt');
    expect(refused.status).toBe(403);
    expect(storage.upload).not.toHaveBeenCalled();
    expect(libraries.writeRight).toHaveBeenCalledWith(expect.objectContaining({ id: USER.id }), LIB, 'Clients/Acme');
    mockRight.value = { right: 'grant', scoped: true };
    await request(app()).post('/api/files/upload').field('displayName', 'Clients/Acme/a.txt').field('libraryId', LIB).attach('file', Buffer.from('abc'), 'a.txt');
    expect(insertedValue('library_scoped')).toBe(true);
  });

  const CREATOR = '22222222-2222-4222-8222-222222222222';
  const share = () => ({
    id: 'link-1', document_id: 'd9', created_by: CREATOR, created_by_email: 'creator@x.com', name: 'Clients/Acme/report.pdf',
    mime_type: 'application/pdf', doc_size: 3, deleted_at: null, revoked_at: null, expires_at: null, password_hash: null,
    password_salt: null, allow_upload: true, upload_count: 0, upload_bytes: 0, library_id: LIB, storage_path: 'p', recipient_email: null,
  });
  test('a public-link upload is checked as the link\'s creator, at the shared file\'s folder', async () => {
    mockRows.share = share();
    mockRows.doc = { id: 'd9', name: 'Clients/Acme/report.pdf' };
    mockRight.value = REFUSED;
    const res = await request(app()).post('/api/files/share/tok/upload').attach('file', Buffer.from('abc'), 'back.txt');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('This link can no longer receive files.');
    expect(libraries.writeRight).toHaveBeenCalledWith(expect.objectContaining({ id: CREATOR, role: 'contributor' }), LIB, 'Clients/Acme');
    expect(storage.upload).not.toHaveBeenCalled();
  });
});

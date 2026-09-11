'use strict';
// Everything that acts on someone's behalf without a request of theirs in hand --
// public links they created, notices about files -- checks their access live, at the
// moment it happens. These tests keep the real SQL builders (condition / userParams)
// and control only what the live checks answer.
const request = require('supertest');
const express = require('express');

const mockQueries = [];
const mockRows = { share: null, folderShare: null, session: null, folderDocs: [] };
jest.mock('../../lib/db', () => ({
  query: jest.fn(async (sql, params) => {
    mockQueries.push({ sql, params });
    if (/FROM documents d\s+WHERE d\.id = ANY\(\$1::uuid\[\]\) AND d\.deleted_at IS NULL AND/.test(sql)) return mockRows.folderDocs;
    return [];
  }),
  queryOne: jest.fn(async (sql, params) => {
    mockQueries.push({ sql, params });
    if (/FROM document_share_links s\s+JOIN documents d/.test(sql)) return mockRows.share;
    if (/FROM folder_share_links WHERE token_hash/.test(sql)) return mockRows.folderShare;
    if (/FROM upload_sessions WHERE id = \$1 AND uploaded_by = \$2/.test(sql)) return mockRows.session;
    return null;
  }),
  withTransaction: jest.fn(),
}));
jest.mock('../../lib/storage', () => ({
  getUrl: jest.fn(), download: jest.fn().mockResolvedValue(Buffer.from('x')), isLocalProvider: jest.fn().mockResolvedValue(true),
  localBase: jest.fn(), validateLocalToken: jest.fn(), upload: jest.fn(), del: jest.fn(), copy: jest.fn(),
  downloadStream: jest.fn(async () => { const { Readable } = require('stream'); return { stream: Readable.from([Buffer.from('file')]), length: 4 }; }),
}));
jest.mock('../../lib/settings', () => ({ getOrEnv: jest.fn().mockResolvedValue(null) }));
jest.mock('../../lib/textExtraction', () => ({ extractText: jest.fn() }));
jest.mock('../../lib/notifications', () => ({ create: jest.fn().mockResolvedValue({}) }));
jest.mock('../../lib/emailEvents', () => ({ send: jest.fn().mockResolvedValue({}) }));
jest.mock('../../lib/auditLog', () => ({ append: jest.fn().mockResolvedValue({}) }));
jest.mock('../../lib/docFollows', () => ({ followersOf: jest.fn().mockResolvedValue([]) }));

// The live answers: who the account is now, and whether it can read / write the file.
const mockLive = { actor: undefined, read: true, write: true };
jest.mock('../../lib/documentAccess', () => {
  const real = jest.requireActual('../../lib/documentAccess');
  return {
    ...real,
    resolveActor: jest.fn(async (id) => (mockLive.actor === undefined ? { id, role: 'contributor', email: 'creator@x.com', emailVerified: true } : mockLive.actor)),
    getAccessibleDocument: jest.fn(async ({ id, required }) => ((required === 'write' ? mockLive.write : mockLive.read) ? { id, name: 'report.pdf', deleted_at: null } : null)),
  };
});

let mockUser = { id: '11111111-1111-4111-8111-111111111111', email: 'me@x.com', role: 'contributor' };
jest.mock('../../middleware/auth', () => (req, _res, next) => { req.user = mockUser; next(); });

const documentAccess = require('../../lib/documentAccess');
const app = () => { const a = express(); a.use(express.json()); a.use('/api/files', require('../../routes/files')); return a; };
const CREATOR = '22222222-2222-4222-8222-222222222222';
const DOC = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  // Destination rights are libraries.writeRight's business (tested on its own); here the
  // creator may always add files beside what they shared.
  jest.spyOn(require('../../lib/libraries'), 'writeRight').mockResolvedValue({ right: 'owner', scoped: true });
  mockQueries.length = 0;
  Object.assign(mockLive, { actor: undefined, read: true, write: true });
  mockRows.share = {
    id: 'link-1', document_id: DOC, created_by: CREATOR, created_by_email: 'creator@x.com',
    name: 'report.pdf', mime_type: 'application/pdf', doc_size: 4, deleted_at: null, revoked_at: null,
    expires_at: null, password_hash: null, password_salt: null, allow_upload: true, upload_count: 0, upload_bytes: 0,
    library_id: null, storage_path: 'documents/report.pdf', recipient_email: null,
  };
  mockRows.folderShare = null; mockRows.session = null; mockRows.folderDocs = [];
  jest.clearAllMocks();
});

describe('a public file link lives only while its creator could still publish the file', () => {
  const paths = [
    ['info', (t) => request(app()).get(`/api/files/share/${t}/info`)],
    ['download', (t) => request(app()).get(`/api/files/share/${t}`)],
    ['ticket', (t) => request(app()).post(`/api/files/share/${t}/ticket`)],
    ['upload', (t) => request(app()).post(`/api/files/share/${t}/upload`)],
  ];
  test.each(paths)('%s works while the creator can edit the file', async (_n, call) => {
    const res = await call('tok');
    expect([200, 400, 401]).toContain(res.status); // 400/401: reached the route proper (no file, no ticket)
    expect(documentAccess.getAccessibleDocument).toHaveBeenCalledWith(expect.objectContaining({ id: DOC, required: 'write', deleted: 'active' }));
  });
  test.each(paths)('%s answers 404 once the creator has lost edit access', async (_n, call) => {
    mockLive.write = false;
    expect((await call('tok')).status).toBe(404);
  });
  test.each(paths)('%s answers 404 once the creator is only a viewer', async (_n, call) => {
    mockLive.actor = { id: CREATOR, role: 'viewer', email: 'creator@x.com', emailVerified: true };
    expect((await call('tok')).status).toBe(404);
  });
  test.each(paths)('%s answers 404 when the creator account is gone', async (_n, call) => {
    mockLive.actor = null;
    expect((await call('tok')).status).toBe(404);
  });
  test('the download streams the linked file itself (its storage path comes with the link)', async () => {
    const res = await request(app()).get('/api/files/share/tok');
    expect(res.status).toBe(200);
    const q = mockQueries.find(x => /FROM document_share_links s\s+JOIN documents d/.test(x.sql));
    expect(q.sql).toMatch(/d\.storage_path/);
    expect(require('../../lib/storage').downloadStream).toHaveBeenCalledWith('documents/report.pdf');
  });
  test('a refused link looks exactly like a revoked one', async () => {
    mockLive.write = false;
    const lost = await request(app()).get('/api/files/share/tok/info');
    mockLive.write = true; mockRows.share = { ...mockRows.share, revoked_at: new Date() };
    const revoked = await request(app()).get('/api/files/share/tok/info');
    expect(lost.status).toBe(revoked.status);
    expect(lost.body).toEqual(revoked.body);
  });
});

describe('a folder link serves only what its creator could still publish', () => {
  beforeEach(() => {
    mockRows.folderShare = { id: 'fl-1', folder_path: 'Clients/Acme', document_ids: [DOC], created_by: CREATOR, created_by_email: 'creator@x.com', revoked_at: null, expires_at: null, password_hash: null };
  });
  // The folder's files are there and readable in both cases, so only the creator's
  // role decides the outcome.
  const withFiles = () => { mockRows.folderDocs = [{ id: DOC, name: 'Clients/Acme/report.pdf', storage_path: 'documents/report.pdf', size: 4 }]; };
  test('a creator who can still edit serves the folder', async () => {
    withFiles();
    expect((await request(app()).get('/api/files/folder/share/tok')).status).toBe(200);
  });
  test('a creator who is now a viewer takes the link down', async () => {
    withFiles();
    mockLive.actor = { id: CREATOR, role: 'viewer', email: 'creator@x.com', emailVerified: true };
    expect((await request(app()).get('/api/files/folder/share/tok')).status).toBe(404);
    expect(mockQueries.some(x => /d\.id = ANY\(\$1::uuid\[\]\)/.test(x.sql))).toBe(false); // refused on the role alone
  });
  test("a creator whose address isn't verified reaches files by address grant no longer", async () => {
    withFiles();
    mockLive.actor = { id: CREATOR, role: 'contributor', email: 'creator@x.com', emailVerified: false };
    await request(app()).get('/api/files/folder/share/tok');
    const q = mockQueries.find(x => /d\.id = ANY\(\$1::uuid\[\]\)/.test(x.sql));
    expect(q.params[4]).toBe(''); // matchEmail: the address slot is blank
  });
  test('the files are filtered by the creator\'s live WRITE access, not served as a frozen list', async () => {
    await request(app()).get('/api/files/folder/share/tok');
    const q = mockQueries.find(x => /d\.id = ANY\(\$1::uuid\[\]\)/.test(x.sql));
    expect(q).toBeDefined();
    expect(q.params[0]).toEqual([DOC]);
    expect(q.params[1]).toBe('contributor');           // the creator's live role
    expect(q.params[2]).toBe(CREATOR);                 // and id
    expect(q.params[5]).toEqual(['write', 'admin']);   // at write, the bar for publishing
  });
});

describe('who may see link lists, move files, and resume an upload', () => {
  test('a file\'s link list needs write, the same bar as making a link', async () => {
    await request(app()).get(`/api/files/${DOC}/shares`);
    expect(documentAccess.getAccessibleDocument).toHaveBeenCalledWith(expect.objectContaining({ id: DOC, required: 'write' }));
  });
  test('the list of all links covers only files the caller could publish', async () => {
    await request(app()).get('/api/files/shares');
    const q = mockQueries.find(x => /FROM document_share_links s\s+JOIN documents d ON d\.id = s\.document_id\s+WHERE/.test(x.sql));
    expect(q.params[4]).toEqual(['write', 'admin']);
  });
  test('moving files to another library needs write on each; copying needs read', async () => {
    const libs = require('../../lib/libraries');
    jest.spyOn(libs, 'writeRight').mockResolvedValue({ right: 'owner', scoped: true });
    await request(app()).post('/api/files/library-transfer').send({ ids: [DOC], libraryId: '44444444-4444-4444-8444-444444444444', mode: 'move' });
    let q = mockQueries.find(x => /WHERE d\.id = ANY\(\$6::uuid\[\]\)/.test(x.sql));
    expect(q.params[4]).toEqual(['write', 'admin']);
    mockQueries.length = 0;
    await request(app()).post('/api/files/library-transfer').send({ ids: [DOC], libraryId: '44444444-4444-4444-8444-444444444444', mode: 'copy' });
    q = mockQueries.find(x => /WHERE d\.id = ANY\(\$6::uuid\[\]\)/.test(x.sql));
    expect(q.params[4]).toEqual(['read', 'write', 'admin']);
  });
  test('a move reports how many files it skipped', async () => {
    const libs = require('../../lib/libraries');
    jest.spyOn(libs, 'writeRight').mockResolvedValue({ right: 'owner', scoped: true });
    const res = await request(app()).post('/api/files/library-transfer').send({ ids: [DOC, '55555555-5555-4555-8555-555555555555'], libraryId: '44444444-4444-4444-8444-444444444444', mode: 'move' });
    expect(res.body).toMatchObject({ count: 0, skipped: 2 });
  });
  test('resuming a finished upload hands the file back only if the caller can still read it', async () => {
    mockRows.session = { id: 's1', status: 'complete', document_id: DOC, uploaded_by: mockUser.id, received_chunks: [] };
    mockLive.read = false;
    expect((await request(app()).post('/api/files/uploads/s1/complete').send({})).status).toBe(404);
    mockLive.read = true;
    expect((await request(app()).post('/api/files/uploads/s1/complete').send({})).status).toBe(200);
  });
});

describe('the Collabora editing token', () => {
  test('a viewer opens read-only even when a grant says write', async () => {
    const files = require('../../routes/files');
    const settings = require('../../lib/settings');
    const realFetch = global.fetch;
    const conf = { collabora_url: 'http://collabora:9980', wopi_internal_url: 'http://memex-app:3000' };
    settings.getOrEnv.mockImplementation(async (k) => conf[k] || null);
    global.fetch = jest.fn(async () => ({ ok: true, text: async () => '<wopi-discovery><net-zone name="external-http"><app name="x"><action name="edit" ext="docx" urlsrc="http://collabora:9980/c.html?"/></app></net-zone></wopi-discovery>' }));
    try {
      const url = await files.collaboraEditUrl({ id: DOC }, 'docx', { user: { id: 'v1', email: 'v@x.com', role: 'viewer' }, protocol: 'https', get: () => 'memex.acme.com' });
      const token = new URL(url).searchParams.get('access_token');
      expect(require('../../lib/wopiTokens').validateToken(token).canWrite).toBe(false);
    } finally { global.fetch = realFetch; settings.getOrEnv.mockReset(); settings.getOrEnv.mockResolvedValue(null); }
  });
});

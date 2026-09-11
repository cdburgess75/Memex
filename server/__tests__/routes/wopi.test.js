'use strict';
// WOPI (Collabora). A token proves who opened the editor and for which file; what they
// may do is decided live on every call, against the account's access right now.
const request = require('supertest');
const express = require('express');
const { generateToken } = require('../../lib/wopiTokens');

jest.mock('../../lib/db', () => ({
  query: jest.fn().mockResolvedValue(undefined),
  queryOne: jest.fn(),
}));

jest.mock('../../lib/storage', () => ({
  download: jest.fn().mockResolvedValue(Buffer.from('file body')),
  upload: jest.fn().mockResolvedValue(undefined),
  copy: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../lib/textExtraction', () => ({
  extractText: jest.fn().mockResolvedValue('file body'),
}));

jest.mock('../../lib/auditLog', () => ({ append: jest.fn().mockResolvedValue({}) }));
jest.mock('../../lib/notifications', () => ({ create: jest.fn().mockResolvedValue({}) }));
jest.mock('../../lib/emailEvents', () => ({ send: jest.fn().mockResolvedValue({}) }));
jest.mock('../../lib/documentVersions', () => ({ pruneOldVersions: jest.fn().mockResolvedValue(undefined) }));

// Access, as the live check sees it. Each test says what the account can do right now.
const mockAccess = { actor: null, read: true, write: true, deleted: false };
jest.mock('../../lib/documentAccess', () => ({
  resolveActor: jest.fn(async (id) => (mockAccess.actor === null ? { id, role: 'contributor', email: 'user@test.com' } : mockAccess.actor)),
  getAccessibleDocument: jest.fn(async ({ id, required, deleted }) => {
    if (deleted === 'active' && mockAccess.deleted) return null;
    if (required === 'write' ? !mockAccess.write : !mockAccess.read) return null;
    return {
      id, name: 'report.docx', size: 9,
      mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      storage_path: `documents/${id}.docx`, uploaded_by: 'owner-1', uploaded_by_email: 'owner@test.com',
      created_at: '2026-06-15T00:00:00.000Z',
    };
  }),
  readersAmong: jest.fn(async (ids, emails) => new Map(emails.map((e) => [e.toLowerCase(), new Set(mockAccess.read ? ids.map(String) : [])]))),
}));

const db = require('../../lib/db');
const storage = require('../../lib/storage');
const documentAccess = require('../../lib/documentAccess');
const notifications = require('../../lib/notifications');

function makeApp() {
  const app = express();
  app.use('/wopi', require('../../routes/wopi'));
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  Object.assign(mockAccess, { actor: null, read: true, write: true, deleted: false });
  db.queryOne.mockImplementation(async (sql) => (sql.includes('COALESCE(MAX(version_number)') ? { next: 1 } : null));
});

const put = (token, body = 'new body') => request(makeApp())
  .post(`/wopi/files/doc-1/contents?access_token=${token}`)
  .set('Content-Type', 'application/octet-stream')
  .send(Buffer.from(body));
const op = (token, override, file = 'doc-1') => request(makeApp())
  .post(`/wopi/files/${file}?access_token=${token}`)
  .set('X-WOPI-Override', override)
  .set('X-WOPI-Lock', 'lock-1');

describe('the token', () => {
  test('serves file info when the token belongs to the requested file, checked as that account', async () => {
    const token = generateToken('doc-1', 'user-1', 'user@test.com');
    const res = await request(makeApp()).get(`/wopi/files/doc-1?access_token=${token}`);
    expect(res.status).toBe(200);
    expect(res.body.BaseFileName).toBe('report.docx');
    expect(documentAccess.resolveActor).toHaveBeenCalledWith('user-1');
    expect(documentAccess.getAccessibleDocument).toHaveBeenCalledWith(expect.objectContaining({ id: 'doc-1', required: 'read', deleted: 'active' }));
  });

  test('rejects a token issued for a different file before touching anything', async () => {
    const token = generateToken('doc-1', 'user-1', 'user@test.com');
    const res = await request(makeApp()).get(`/wopi/files/doc-2/contents?access_token=${token}`);
    expect(res.status).toBe(401);
    expect(documentAccess.getAccessibleDocument).not.toHaveBeenCalled();
    expect(storage.download).not.toHaveBeenCalled();
  });

  test('rejects lock operations when the token belongs to another file', async () => {
    const token = generateToken('doc-1', 'user-1', 'user@test.com');
    expect((await op(token, 'LOCK', 'doc-2')).status).toBe(401);
  });

  // The token is checked by middleware in front of the 50 MB body parser. (With a
  // large body the server answers and closes before reading it, which a test client
  // sees as EPIPE -- so this uses a small one and asserts nothing downstream ran.)
  test('a save with a bad token is refused in front of the body parser', async () => {
    const res = await request(makeApp())
      .post('/wopi/files/doc-1/contents?access_token=nope')
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('x'));
    expect(res.status).toBe(401);
    expect(documentAccess.resolveActor).not.toHaveBeenCalled();
    expect(storage.upload).not.toHaveBeenCalled();
  });

  test('a save with a token never minted for editing is refused in front of the body parser too', async () => {
    const readToken = generateToken('doc-1', 'user-1', 'viewer@test.com', false);
    const res = await put(readToken, 'x');
    expect(res.status).toBe(403);
    // answered by the middleware: the handler's live lookup never ran
    expect(documentAccess.resolveActor).not.toHaveBeenCalled();
    expect(storage.upload).not.toHaveBeenCalled();
  });

  test("every check runs as the token's live account, never as the address in the token", async () => {
    const live = { id: 'user-1', role: 'contributor', email: 'live@test.com', emailVerified: true };
    mockAccess.actor = live;
    const token = generateToken('doc-1', 'user-1', 'claimed@test.com', true);
    expect((await request(makeApp()).get(`/wopi/files/doc-1?access_token=${token}`)).status).toBe(200);
    expect((await put(token)).status).toBe(200);
    const users = documentAccess.getAccessibleDocument.mock.calls.map(([a]) => a.user);
    expect(users.length).toBeGreaterThan(0);
    for (const u of users) expect(u).toBe(live);
  });
});

describe('access is decided live, on every call', () => {
  test('CheckFileInfo reports UserCanWrite from live access, and only for an editing token', async () => {
    const readToken = generateToken('doc-1', 'user-1', 'viewer@test.com', false);
    const writeToken = generateToken('doc-1', 'user-1', 'editor@test.com', true);
    expect((await request(makeApp()).get(`/wopi/files/doc-1?access_token=${readToken}`)).body.UserCanWrite).toBe(false);
    expect((await request(makeApp()).get(`/wopi/files/doc-1?access_token=${writeToken}`)).body.UserCanWrite).toBe(true);
    mockAccess.write = false; // their write access ended after the editor opened
    expect((await request(makeApp()).get(`/wopi/files/doc-1?access_token=${writeToken}`)).body.UserCanWrite).toBe(false);
  });

  test('a viewer never gets UserCanWrite, whatever the token says', async () => {
    mockAccess.actor = { id: 'user-1', role: 'viewer', email: 'v@test.com' };
    const token = generateToken('doc-1', 'user-1', 'v@test.com', true);
    expect((await request(makeApp()).get(`/wopi/files/doc-1?access_token=${token}`)).body.UserCanWrite).toBe(false);
    expect((await put(token)).status).toBe(403);
  });

  test('PutFile refuses a read-only session', async () => {
    const readToken = generateToken('doc-1', 'user-1', 'viewer@test.com', false);
    expect((await put(readToken, 'malicious overwrite')).status).toBe(403);
    expect(storage.upload).not.toHaveBeenCalled();
  });

  test('PutFile refuses someone whose write access ended after the editor opened', async () => {
    const token = generateToken('doc-1', 'user-1', 'editor@test.com', true);
    mockAccess.write = false;
    expect((await put(token)).status).toBe(403);
    expect(storage.upload).not.toHaveBeenCalled();
  });

  test('once read access is gone the file is gone too: info, contents and saves all 404', async () => {
    const token = generateToken('doc-1', 'user-1', 'editor@test.com', true);
    mockAccess.read = false; mockAccess.write = false;
    expect((await request(makeApp()).get(`/wopi/files/doc-1?access_token=${token}`)).status).toBe(404);
    expect((await request(makeApp()).get(`/wopi/files/doc-1/contents?access_token=${token}`)).status).toBe(404);
    expect(storage.download).not.toHaveBeenCalled();
  });

  test('an account that no longer exists gets nothing', async () => {
    mockAccess.actor = undefined; // resolveActor finds no account
    documentAccess.resolveActor.mockResolvedValueOnce(null);
    const token = generateToken('doc-1', 'gone', 'x@test.com', true);
    expect((await request(makeApp()).get(`/wopi/files/doc-1?access_token=${token}`)).status).toBe(404);
  });

  test('a file moved to Trash while open answers 404', async () => {
    const token = generateToken('doc-1', 'user-1', 'editor@test.com', true);
    mockAccess.deleted = true;
    expect((await put(token)).status).toBe(404);
  });

  test('an editor with live write access saves', async () => {
    const token = generateToken('doc-1', 'user-1', 'editor@test.com', true);
    expect((await put(token)).status).toBe(200);
    expect(storage.upload).toHaveBeenCalledTimes(1);
  });
});

describe('locks', () => {
  test.each(['LOCK', 'REFRESH_LOCK', 'UNLOCK_AND_RELOCK'])('%s needs write, so a read-only session cannot block saves', async (o) => {
    const readToken = generateToken('doc-1', 'user-1', 'viewer@test.com', false);
    expect((await op(readToken, o)).status).toBe(403);
  });

  // Releasing a lock you hold can't block anyone, and a session that lost write after
  // taking the lock must still be able to let go of it when it closes -- otherwise the
  // file stays locked against every other editor for 30 minutes.
  test('a session that lost write can still release the lock it holds, and only that lock', async () => {
    const token = generateToken('doc-1', 'user-1', 'editor@test.com', true);
    expect((await op(token, 'LOCK')).status).toBe(200);
    mockAccess.write = false;
    const wrong = await request(makeApp()).post(`/wopi/files/doc-1?access_token=${token}`)
      .set('X-WOPI-Override', 'UNLOCK').set('X-WOPI-Lock', 'someone-elses');
    expect(wrong.status).toBe(409);
    expect((await op(token, 'UNLOCK')).status).toBe(200);
    mockAccess.read = false;
    expect((await op(token, 'UNLOCK')).status).toBe(404); // no access at all: nothing
  });

  test('GET_LOCK needs only read', async () => {
    const readToken = generateToken('doc-1', 'user-1', 'viewer@test.com', false);
    expect((await op(readToken, 'GET_LOCK')).status).toBe(200);
  });

  test('an editor can take and release the lock', async () => {
    const token = generateToken('doc-1', 'user-1', 'editor@test.com', true);
    expect((await op(token, 'LOCK')).status).toBe(200);
    expect((await op(token, 'UNLOCK')).status).toBe(200);
  });
});

describe('notices after a save', () => {
  test("the edit notice names the editor, and mails as them, only by a verified address", async () => {
    const emailEvents = require('../../lib/emailEvents');
    const token = generateToken('doc-1', 'user-1', 'editor@test.com', true);
    mockAccess.actor = { id: 'user-1', role: 'contributor', email: 'editor@test.com', emailVerified: true };
    await put(token);
    expect(emailEvents.send).toHaveBeenCalledWith('document_edited', expect.objectContaining({ to: 'owner@test.com', actorEmail: 'editor@test.com' }));
    emailEvents.send.mockClear(); notifications.create.mockClear();
    mockAccess.actor = { id: 'user-1', role: 'contributor', email: 'cfo@test.com', emailVerified: false };
    await put(token);
    expect(emailEvents.send).toHaveBeenCalledWith('document_edited', expect.objectContaining({ to: 'owner@test.com', actorEmail: null }));
    expect(notifications.create).toHaveBeenCalledWith(expect.objectContaining({ title: 'cfo@test.com (unverified address) edited your file' }));
  });

  test("the uploader is told someone edited their file only while they can still read it", async () => {
    const token = generateToken('doc-1', 'user-1', 'editor@test.com', true);
    await put(token);
    expect(notifications.create).toHaveBeenCalledWith(expect.objectContaining({ userEmail: 'owner@test.com', type: 'document_edited' }));
    notifications.create.mockClear();
    documentAccess.readersAmong.mockResolvedValueOnce(new Map([['owner@test.com', new Set()]]));
    await put(token);
    expect(notifications.create).not.toHaveBeenCalledWith(expect.objectContaining({ userEmail: 'owner@test.com' }));
  });
});

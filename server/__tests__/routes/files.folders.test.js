'use strict';
// Guards the ST-1 split: the folder operations now live in routes/files/folders.js,
// mounted at /api/files/folder by routes/files.js. These tests assert the sub-router
// is reachable at the original absolute paths (including the no-trailing-slash mount
// point) and that the extracted lib helpers (documents.safeDocName, shareLinks.tokenHash)
// are wired in. Deep behavior is unchanged code, so this focuses on routing + wiring.
const request = require('supertest');
const express = require('express');

jest.mock('../../lib/db', () => ({
  query: jest.fn().mockResolvedValue([]),
  queryOne: jest.fn().mockResolvedValue(null),
  withTransaction: jest.fn(),
}));
jest.mock('../../lib/auditLog', () => ({ append: jest.fn().mockResolvedValue({}) }));
jest.mock('../../lib/storage', () => ({
  upload: jest.fn().mockResolvedValue(undefined),
  download: jest.fn().mockResolvedValue(Buffer.from('x')),
  copy: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../lib/settings', () => ({ getOrEnv: jest.fn().mockResolvedValue(null) }));
jest.mock('../../lib/libraries', () => ({
  defaultLibraryId: jest.fn().mockResolvedValue('lib-1'),
  canAccessLibrary: jest.fn().mockResolvedValue(true),
}));
jest.mock('../../lib/documentAccess', () => ({
  condition: () => 'TRUE',
  userParams: () => [],
  grantOwnerAdmin: jest.fn().mockResolvedValue(undefined),
  normalizeEmail: (e) => String(e || '').toLowerCase(),
  validPermission: () => true,
}));
jest.mock('../../lib/notifications', () => ({ create: jest.fn().mockResolvedValue({}) }));
jest.mock('../../lib/emailEvents', () => ({ send: jest.fn().mockResolvedValue({}) }));

let mockUser = { id: '810da857-4296-473f-99e9-96f2a5ebd47e', email: 'user@test.com', role: 'contributor' };
jest.mock('../../middleware/auth', () => (req, _res, next) => { req.user = mockUser; next(); });

const db = require('../../lib/db');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/files', require('../../routes/files'));
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUser = { id: '810da857-4296-473f-99e9-96f2a5ebd47e', email: 'user@test.com', role: 'contributor' };
});

describe('folder sub-router mount (ST-1)', () => {
  test('POST /api/files/folder (mount point, no trailing slash) reaches the create-folder handler', async () => {
    // The handler validates path first; empty body must hit the handler and 400 —
    // proving the request routed into the sub-router, not fell through to a 404.
    const res = await request(makeApp()).post('/api/files/folder').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/path required/i);
  });

  test('POST /api/files/folder creates the folder marker for a valid path', async () => {
    db.queryOne.mockResolvedValueOnce({ id: 'doc-1', name: 'Reports/.keep' });
    const res = await request(makeApp()).post('/api/files/folder').send({ path: 'Reports' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, path: 'Reports' });
    // safeDocName (lib/documents) sanitized the path; the INSERT ran; owner ACL granted.
    expect(db.queryOne).toHaveBeenCalledTimes(1);
    expect(require('../../lib/documentAccess').grantOwnerAdmin).toHaveBeenCalledTimes(1);
  });

  test('POST /api/files/folder/rename requires a name', async () => {
    const res = await request(makeApp()).post('/api/files/folder/rename').send({ path: 'A' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/path and name required/i);
  });

  test('GET /api/files/folder/zip requires a path', async () => {
    const res = await request(makeApp()).get('/api/files/folder/zip');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/path required/i);
  });

  test('GET /api/files/folder/share/:token is public and 404s an unknown token', async () => {
    // No auth header needed (public route); tokenHash (lib/shareLinks) + db lookup → null → 404.
    db.queryOne.mockResolvedValueOnce(null);
    const res = await request(makeApp()).get('/api/files/folder/share/deadbeef');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });
});

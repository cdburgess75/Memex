'use strict';
const request = require('supertest');
const express = require('express');

jest.mock('../../lib/db', () => ({
  query: jest.fn().mockResolvedValue([]),
  queryOne: jest.fn().mockResolvedValue(null),
}));

jest.mock('../../lib/storage', () => ({
  getUrl: jest.fn().mockResolvedValue('http://signed.example/file'),
  download: jest.fn().mockResolvedValue(Buffer.from('file body')),
  isLocalProvider: jest.fn().mockResolvedValue(true),
  localBase: jest.fn().mockResolvedValue('/tmp/memex-docs'),
  validateLocalToken: jest.fn(),
}));

jest.mock('../../lib/settings', () => ({
  getOrEnv: jest.fn().mockResolvedValue(null),
}));

jest.mock('../../lib/textExtraction', () => ({
  extractText: jest.fn().mockResolvedValue('file body'),
}));

let mockUser = {
  id: '810da857-4296-473f-99e9-96f2a5ebd47e',
  email: 'user@test.com',
  role: 'contributor',
};

jest.mock('../../middleware/auth', () => (req, _res, next) => {
  req.user = mockUser;
  next();
});

const db = require('../../lib/db');
const storage = require('../../lib/storage');
const documentAccess = require('../../lib/documentAccess');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/files', require('../../routes/files'));
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  documentAccess._resetForTests();
  mockUser = {
    id: '810da857-4296-473f-99e9-96f2a5ebd47e',
    email: 'user@test.com',
    role: 'contributor',
  };
});

describe('file route document access checks', () => {
  test('download URL returns 404 and does not sign storage URL when access check misses', async () => {
    db.queryOne.mockResolvedValueOnce(null);

    const res = await request(makeApp()).get('/api/files/11111111-1111-1111-1111-111111111111/url');

    expect(res.status).toBe(404);
    expect(storage.getUrl).not.toHaveBeenCalled();
    expect(db.queryOne.mock.calls[0][0]).toContain('FROM document_acl da');
  });

  test('file list includes ACL condition', async () => {
    const res = await request(makeApp()).get('/api/files');

    expect(res.status).toBe(200);
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('CREATE TABLE IF NOT EXISTS document_acl'));
    const listQuery = db.query.mock.calls.find(call => String(call[0]).includes('ORDER BY d.created_at DESC'));
    expect(listQuery[0]).toContain('FROM document_acl da');
    expect(listQuery[1]).toEqual(['contributor', mockUser.id, mockUser.id, 'user@test.com', ['read', 'write', 'admin']]);
  });
});

'use strict';
// Covers the resumable session-create size validation: reject a zero/negative size
// (which would disable the per-chunk check) and reject a size over the upload cap.
const request = require('supertest');
const express = require('express');

jest.mock('../../lib/db', () => ({
  query: jest.fn().mockResolvedValue([]),
  queryOne: jest.fn().mockResolvedValue(null),
  withTransaction: jest.fn(),
}));
jest.mock('../../lib/auditLog', () => ({ append: jest.fn().mockResolvedValue({}) }));
jest.mock('../../lib/storage', () => ({
  isLocalProvider: jest.fn().mockResolvedValue(true),
  localBase: jest.fn().mockResolvedValue('/tmp/memex-docs-test'),
  del: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../lib/settings', () => ({ getOrEnv: jest.fn() }));
jest.mock('../../lib/textExtraction', () => ({ extractText: jest.fn().mockResolvedValue('') }));

let mockUser = { id: 'u1', email: 'user@test.com', role: 'contributor' };
jest.mock('../../middleware/auth', () => (req, _res, next) => { req.user = mockUser; next(); });

const settings = require('../../lib/settings');
const files = require('../../routes/files');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/files', files);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  settings.getOrEnv.mockImplementation((k) => Promise.resolve(k === 'max_upload_mb' ? '1' : null)); // 1 MB cap
});

describe('POST /api/files/uploads size validation', () => {
  test('rejects a zero/negative declared size with 400', async () => {
    const res = await request(makeApp()).post('/api/files/uploads').send({ name: 'f.bin', size: 0 });
    expect(res.status).toBe(400);
  });

  test('rejects a declared size over the cap with 413', async () => {
    const res = await request(makeApp()).post('/api/files/uploads').send({ name: 'big.bin', size: 5 * 1024 * 1024 });
    expect(res.status).toBe(413);
  });
});

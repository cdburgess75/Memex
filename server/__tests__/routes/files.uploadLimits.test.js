'use strict';
// Covers the upload size-cap enforcement: the streaming capGuard aborts past the
// limit, and the resumable session-create route rejects a zero/oversize declared size.
const request = require('supertest');
const express = require('express');
const { Readable } = require('stream');

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
const { capGuard } = files;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/files', files);
  return app;
}

async function collect(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks);
}

beforeEach(() => {
  jest.clearAllMocks();
  // 1 MB upload cap for easy numbers.
  settings.getOrEnv.mockImplementation((k) => Promise.resolve(k === 'max_upload_mb' ? '1' : null));
});

describe('capGuard', () => {
  test('passes data through unchanged when under the cap', async () => {
    const data = Buffer.alloc(500, 7);
    const out = await collect(Readable.from([data]).pipe(capGuard(1000)));
    expect(out.equals(data)).toBe(true);
  });

  test('errors with UPLOAD_TOO_LARGE once bytes exceed the cap', async () => {
    const src = Readable.from([Buffer.alloc(600), Buffer.alloc(600)]); // 1200 > 1000
    let err;
    try { await collect(src.pipe(capGuard(1000))); } catch (e) { err = e; }
    expect(err).toBeDefined();
    expect(err.code).toBe('UPLOAD_TOO_LARGE');
  });
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

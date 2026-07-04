'use strict';
// Inbound upload links (file requests): folder-path normalization, the
// client-safe shape (must never leak the token/hash), and the public info route.
jest.mock('../../lib/db', () => ({
  query: jest.fn().mockResolvedValue([]),
  queryOne: jest.fn().mockResolvedValue(null),
}));
jest.mock('../../lib/storage', () => ({
  getUrl: jest.fn(), download: jest.fn(), isLocalProvider: jest.fn().mockResolvedValue(true),
  localBase: jest.fn(), validateLocalToken: jest.fn(), upload: jest.fn(),
}));
jest.mock('../../lib/settings', () => ({ getOrEnv: jest.fn().mockResolvedValue(null) }));
jest.mock('../../lib/textExtraction', () => ({ extractText: jest.fn() }));
jest.mock('../../middleware/auth', () => (req, _res, next) => { req.user = { id: 'u1', email: 'me@test.com', role: 'contributor' }; next(); });

const request = require('supertest');
const express = require('express');
const db = require('../../lib/db');
const files = require('../../routes/files');
const { normalizeFolderPath, uploadLinkClientShape } = files;

function app() { const a = express(); a.use(express.json()); a.use('/api/files', files); return a; }

describe('normalizeFolderPath', () => {
  test('trims segments, drops empties, collapses slashes', () => {
    expect(normalizeFolderPath('  Clients / Acme // ')).toBe('Clients/Acme');
    expect(normalizeFolderPath('/a/b/')).toBe('a/b');
    expect(normalizeFolderPath('')).toBe('');
    expect(normalizeFolderPath(null)).toBe('');
  });
});

describe('uploadLinkClientShape', () => {
  test('maps the row and never leaks token_hash / password_hash', () => {
    const s = uploadLinkClientShape({
      id: 'x', label: 'L', library_id: 'lib', folder_path: 'f', expires_at: null, revoked_at: null,
      created_at: 't', created_by_email: 'me@test.com', upload_count: '3', last_used_at: null,
      password_hash: 'HASH', token_hash: 'SECRET',
    }, 'https://x/u/tok');
    expect(s).toMatchObject({ id: 'x', label: 'L', has_password: true, upload_count: 3, url: 'https://x/u/tok' });
    const json = JSON.stringify(s);
    expect(json).not.toContain('SECRET');
    expect(json).not.toContain('HASH');
    expect(json).not.toContain('token_hash');
  });
});

describe('GET /api/files/upload-link/:token/info', () => {
  afterEach(() => db.queryOne.mockReset());

  test('404 when the link does not exist', async () => {
    db.queryOne.mockResolvedValue(null);
    const r = await request(app()).get('/api/files/upload-link/abc/info');
    expect(r.status).toBe(404);
  });

  test('200 with label + needsPassword for an active link', async () => {
    db.queryOne.mockResolvedValue({ id: 'l1', label: 'Docs', password_hash: 'h', revoked_at: null, expires_at: null });
    const r = await request(app()).get('/api/files/upload-link/abc/info');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ label: 'Docs', needsPassword: true });
  });

  test('410 when the link has expired', async () => {
    db.queryOne.mockResolvedValue({ id: 'l1', label: 'x', revoked_at: null, expires_at: new Date(Date.now() - 1000).toISOString() });
    const r = await request(app()).get('/api/files/upload-link/abc/info');
    expect(r.status).toBe(410);
  });

  test('404 when the link was revoked', async () => {
    db.queryOne.mockResolvedValue({ id: 'l1', label: 'x', revoked_at: new Date().toISOString(), expires_at: null });
    const r = await request(app()).get('/api/files/upload-link/abc/info');
    expect(r.status).toBe(404);
  });
});

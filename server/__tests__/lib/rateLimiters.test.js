'use strict';

jest.mock('../../lib/settings', () => ({ getOrEnv: jest.fn() }));
const settings = require('../../lib/settings');
const { intFromEnv, rateLimitEnabled, makeRateLimiters, isUploadPath, uploadRequestLimit, UPLOAD_LIMIT_FLOOR } = require('../../lib/rateLimiters');

describe('rateLimiters', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    delete process.env.RATE_LIMIT_ENABLED;
    delete process.env.RATE_LIMIT_WINDOW_MS;
    delete process.env.RATE_LIMIT_API_MAX;
    delete process.env.RATE_LIMIT_AUTH_MAX;
    delete process.env.RATE_LIMIT_SHARE_MAX;
    delete process.env.RATE_LIMIT_SHARE_WINDOW_MS;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('parses positive integer environment values', () => {
    process.env.RATE_LIMIT_API_MAX = '42';
    expect(intFromEnv('RATE_LIMIT_API_MAX', 300)).toBe(42);
  });

  test('falls back for missing, invalid, and non-positive values', () => {
    expect(intFromEnv('RATE_LIMIT_API_MAX', 300)).toBe(300);
    process.env.RATE_LIMIT_API_MAX = 'nope';
    expect(intFromEnv('RATE_LIMIT_API_MAX', 300)).toBe(300);
    process.env.RATE_LIMIT_API_MAX = '0';
    expect(intFromEnv('RATE_LIMIT_API_MAX', 300)).toBe(300);
  });

  test('can disable rate limiting for trusted internal testing', () => {
    expect(rateLimitEnabled()).toBe(true);
    process.env.RATE_LIMIT_ENABLED = 'false';
    expect(rateLimitEnabled()).toBe(false);
  });

  test('returns middleware functions for api, auth, share, and upload limiters', () => {
    const limiters = makeRateLimiters();
    expect(typeof limiters.apiLimiter).toBe('function');
    expect(typeof limiters.authLimiter).toBe('function');
    expect(typeof limiters.shareLimiter).toBe('function');
    expect(typeof limiters.uploadLimiter).toBe('function');
  });

  test('isUploadPath exempts only the authenticated bulk-upload routes', () => {
    const mk = (originalUrl) => ({ originalUrl });
    // exempted (get the high upload limiter, skipped by the general cap)
    expect(isUploadPath(mk('/api/files/upload'))).toBe(true);
    expect(isUploadPath(mk('/api/files/upload-stream'))).toBe(true);
    expect(isUploadPath(mk('/api/files/uploads'))).toBe(true);
    expect(isUploadPath(mk('/api/files/uploads/abc/chunks/3?x=1'))).toBe(true);
    // NOT exempted — similarly-prefixed and unrelated routes stay under the normal cap
    expect(isUploadPath(mk('/api/files/upload-link/tok'))).toBe(false);
    expect(isUploadPath(mk('/api/files/upload-links'))).toBe(false);
    expect(isUploadPath(mk('/api/files/list'))).toBe(false);
    expect(isUploadPath(mk('/api/pages'))).toBe(false);
  });

  test('uses share-specific environment values', () => {
    process.env.RATE_LIMIT_SHARE_MAX = '12';
    process.env.RATE_LIMIT_SHARE_WINDOW_MS = '60000';
    expect(intFromEnv('RATE_LIMIT_SHARE_MAX', 60)).toBe(12);
    expect(intFromEnv('RATE_LIMIT_SHARE_WINDOW_MS', 900000)).toBe(60000);
  });
});

describe('uploadRequestLimit (auto-scales the upload cap off max_upload_files)', () => {
  beforeEach(() => { delete process.env.RATE_LIMIT_UPLOAD_MAX; settings.getOrEnv.mockReset(); });

  test('explicit RATE_LIMIT_UPLOAD_MAX always wins', async () => {
    process.env.RATE_LIMIT_UPLOAD_MAX = '7000';
    settings.getOrEnv.mockResolvedValue('4096');
    await expect(uploadRequestLimit()).resolves.toBe(7000);
  });

  test('scales to max_upload_files × per-file requests when above the floor', async () => {
    settings.getOrEnv.mockResolvedValue('10000');
    await expect(uploadRequestLimit()).resolves.toBe(120000); // 10000 * 12
  });

  test('never drops below the floor for a small file limit', async () => {
    settings.getOrEnv.mockResolvedValue('100');
    await expect(uploadRequestLimit()).resolves.toBe(UPLOAD_LIMIT_FLOOR); // 30000
  });

  test('defaults to 4096 files when the setting is unavailable', async () => {
    settings.getOrEnv.mockRejectedValue(new Error('db down'));
    await expect(uploadRequestLimit()).resolves.toBe(49152); // max(30000, 4096 * 12)
  });
});

describe('a folder link: guessing a password and downloading files answer to different budgets', () => {
  const express = require('express');
  const request = require('supertest');
  const { presentsPassword } = require('../../lib/rateLimiters');
  test.each([
    ['the ticket exchange', { path: '/tok/ticket' }, true],
    ['a password header on the listing', { path: '/tok/info', headers: { 'x-share-password': 'guess' } }, true],
    ['?password= on the old ZIP address', { path: '/tok', query: { password: 'guess' } }, true],
    ['an empty ?password=', { path: '/tok', query: { password: '' } }, true],
    ['the listing', { path: '/tok/info', query: { path: 'Invoices' } }, false],
    ['one file, by ticket', { path: '/tok/file/abc', query: { dl: 'ticket' } }, false],
    ['the ZIP', { path: '/tok/zip' }, false],
    ['the first-open report', { path: '/tok/opened' }, false],
    ['a file somebody NAMED ticket', { path: '/tok/file/ticket' }, false],
  ])('%s', (_n, req, tight) => expect(presentsPassword({ headers: {}, query: {}, ...req })).toBe(tight));

  test('a recipient can download far more files than anyone can guess passwords', async () => {
    process.env.RATE_LIMIT_ENABLED = 'true'; process.env.RATE_LIMIT_SHARE_MAX = '3'; process.env.RATE_LIMIT_FOLDER_BROWSE_MAX = '20';
    try {
      const { shareLimiter, folderBrowseLimiter } = makeRateLimiters();
      const app = express();
      app.use('/s', (req, res, next) => (presentsPassword(req) ? shareLimiter : folderBrowseLimiter)(req, res, next), (_req, res) => res.json({ ok: true }));
      for (let i = 0; i < 10; i++) expect((await request(app).get(`/s/tok/file/f${i}`)).status).toBe(200); // ten files: fine
      const guesses = [];
      for (let i = 0; i < 5; i++) guesses.push((await request(app).post('/s/tok/ticket')).status);
      expect(guesses).toEqual([200, 200, 200, 429, 429]);                                               // guessing: stopped at three
      expect((await request(app).get('/s/tok/info').set('x-share-password', 'x')).status).toBe(429);     // by any door
      expect((await request(app).get('/s/tok/file/f11')).status).toBe(200);                              // and downloads go on
    } finally { delete process.env.RATE_LIMIT_ENABLED; delete process.env.RATE_LIMIT_SHARE_MAX; delete process.env.RATE_LIMIT_FOLDER_BROWSE_MAX; }
  });
});

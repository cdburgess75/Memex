'use strict';

const { intFromEnv, rateLimitEnabled, makeRateLimiters, isUploadPath } = require('../../lib/rateLimiters');

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
    // NOT exempted — public upload links and unrelated routes stay under the normal cap
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

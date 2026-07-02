'use strict';
// Mirror the require-time mocks used by files.access.test.js so requiring the
// files router has no side effects; publicAppBase itself only reads settings.
jest.mock('../../lib/db', () => ({
  query: jest.fn().mockResolvedValue([]),
  queryOne: jest.fn().mockResolvedValue(null),
}));
jest.mock('../../lib/storage', () => ({
  getUrl: jest.fn(),
  download: jest.fn(),
  isLocalProvider: jest.fn().mockResolvedValue(true),
  localBase: jest.fn(),
  validateLocalToken: jest.fn(),
}));
jest.mock('../../lib/settings', () => ({ getOrEnv: jest.fn() }));
jest.mock('../../lib/textExtraction', () => ({ extractText: jest.fn() }));
jest.mock('../../middleware/auth', () => (req, _res, next) => next());

const settings = require('../../lib/settings');
const { publicAppBase } = require('../../routes/files');

function req(host, protocol = 'https') {
  return { protocol, get: (h) => (String(h).toLowerCase() === 'host' ? host : undefined) };
}

describe('publicAppBase — share-link base URL', () => {
  beforeEach(() => settings.getOrEnv.mockReset());

  test('prefers the request host when app_url is stale (the bug)', async () => {
    settings.getOrEnv.mockResolvedValue('http://10.5.91.18:3000'); // dead host
    expect(await publicAppBase(req('memex.acme.com'))).toBe('https://memex.acme.com');
  });

  test('uses the request host on a LAN address even with app_url set', async () => {
    settings.getOrEnv.mockResolvedValue('http://10.5.91.18:3000');
    expect(await publicAppBase(req('192.168.1.32:3000', 'http'))).toBe('http://192.168.1.32:3000');
  });

  test('no regression: a correct app_url matches the request host', async () => {
    settings.getOrEnv.mockResolvedValue('https://memex.acme.com');
    expect(await publicAppBase(req('memex.acme.com'))).toBe('https://memex.acme.com');
  });

  test('falls back to app_url when the request host is loopback (proxy dropped Host)', async () => {
    settings.getOrEnv.mockResolvedValue('https://memex.acme.com');
    expect(await publicAppBase(req('localhost:3000', 'http'))).toBe('https://memex.acme.com');
    expect(await publicAppBase(req('127.0.0.1:3000', 'http'))).toBe('https://memex.acme.com');
    expect(await publicAppBase(req('[::1]:3000', 'http'))).toBe('https://memex.acme.com');
    expect(await publicAppBase(req('0.0.0.0:3000', 'http'))).toBe('https://memex.acme.com');
  });

  test('no app_url + loopback host falls through to the request host', async () => {
    settings.getOrEnv.mockResolvedValue(null);
    expect(await publicAppBase(req('localhost:3000', 'http'))).toBe('http://localhost:3000');
  });

  test('a real (non-loopback) IPv6 host is treated as external', async () => {
    settings.getOrEnv.mockResolvedValue('http://10.5.91.18:3000');
    expect(await publicAppBase(req('[2001:db8::1]:3000', 'https'))).toBe('https://[2001:db8::1]:3000');
  });

  test('trailing slash on app_url is trimmed when used as a fallback', async () => {
    settings.getOrEnv.mockResolvedValue('https://memex.acme.com/');
    expect(await publicAppBase(req('localhost:3000', 'http'))).toBe('https://memex.acme.com');
  });
});

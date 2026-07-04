'use strict';
// Covers the Collabora (in-browser Office editing) URL builder: discovery-XML
// parsing and rebasing the editor URL onto the browser-facing origin with the
// WOPI callback + token. Mirror files.access.test.js require-time mocks.
jest.mock('../../lib/db', () => ({
  query: jest.fn().mockResolvedValue([]),
  queryOne: jest.fn().mockResolvedValue(null),
}));
jest.mock('../../lib/storage', () => ({
  getUrl: jest.fn(), download: jest.fn(), isLocalProvider: jest.fn().mockResolvedValue(true),
  localBase: jest.fn(), validateLocalToken: jest.fn(),
}));
jest.mock('../../lib/settings', () => ({ getOrEnv: jest.fn() }));
jest.mock('../../lib/textExtraction', () => ({ extractText: jest.fn() }));
jest.mock('../../middleware/auth', () => (req, _res, next) => next());

const settings = require('../../lib/settings');
const files = require('../../routes/files');
const { discoveryUrlSrc, collaboraEditUrl } = files;

const DISCOVERY = `<?xml version="1.0" encoding="utf-8"?>
<wopi-discovery>
  <net-zone name="external-http">
    <app name="application/vnd.openxmlformats-officedocument.wordprocessingml.document">
      <action name="edit" ext="docx" urlsrc="http://collabora:9980/browser/abc123/cool.html?"/>
      <action name="view" ext="docx" urlsrc="http://collabora:9980/browser/abc123/cool.html?permission=readonly&amp;"/>
    </app>
    <app name="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet">
      <action name="edit" ext="xlsx" urlsrc="http://collabora:9980/browser/abc123/cool.html?"/>
    </app>
  </net-zone>
</wopi-discovery>`;

describe('discoveryUrlSrc', () => {
  test('prefers the edit action for a matching extension', () => {
    expect(discoveryUrlSrc(DISCOVERY, 'docx')).toBe('http://collabora:9980/browser/abc123/cool.html?');
  });
  test('resolves other extensions', () => {
    expect(discoveryUrlSrc(DISCOVERY, 'xlsx')).toBe('http://collabora:9980/browser/abc123/cool.html?');
  });
  test('returns null for an extension not in discovery', () => {
    expect(discoveryUrlSrc(DISCOVERY, 'pptx')).toBeNull();
  });
  test('tolerates empty/garbage XML', () => {
    expect(discoveryUrlSrc('', 'docx')).toBeNull();
    expect(discoveryUrlSrc('<nope/>', 'docx')).toBeNull();
  });
});

describe('collaboraEditUrl', () => {
  const doc = { id: 'doc-42' };
  const req = { user: { id: 'u1', email: 'u@test.com' }, protocol: 'https', get: () => 'memex.acme.com' };
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; settings.getOrEnv.mockReset(); });

  function settingsMap(map) {
    settings.getOrEnv.mockImplementation(async (k) => (k in map ? map[k] : null));
  }

  test('returns null when neither collabora_enabled nor collabora_url is set', async () => {
    settingsMap({});
    expect(await collaboraEditUrl(doc, 'docx', req)).toBeNull();
  });

  test('same-origin: collabora_enabled builds the editor URL on the request origin', async () => {
    settingsMap({ collabora_enabled: 'true', collabora_internal_url: 'http://collabora:9980', wopi_internal_url: 'http://app:3000' });
    global.fetch = jest.fn().mockResolvedValue({ ok: true, text: async () => DISCOVERY });
    const url = await collaboraEditUrl(doc, 'docx', req);
    expect(url.startsWith('https://memex.acme.com/browser/abc123/cool.html?')).toBe(true); // request origin, not collabora:9980
    expect(url).toContain('WOPISrc=' + encodeURIComponent('http://app:3000/wopi/files/doc-42'));
    expect(url).toMatch(/access_token=[a-f0-9]{64}/);
  });

  test('returns null for a non-editable extension even when configured', async () => {
    settingsMap({ collabora_url: 'https://edit.acme.com' });
    expect(await collaboraEditUrl(doc, 'png', req)).toBeNull();
  });

  test('builds an editor URL rebased onto the browser origin with WOPISrc + token', async () => {
    settingsMap({
      collabora_url: 'https://edit.acme.com',
      collabora_internal_url: 'http://collabora:9980',
      wopi_internal_url: 'http://app:3000',
    });
    global.fetch = jest.fn().mockResolvedValue({ ok: true, text: async () => DISCOVERY });
    const url = await collaboraEditUrl(doc, 'docx', req);
    // discovery was fetched from the internal URL
    expect(global.fetch).toHaveBeenCalledWith('http://collabora:9980/hosting/discovery', expect.anything());
    // rebased onto the browser origin, not the internal collabora host
    expect(url.startsWith('https://edit.acme.com/browser/abc123/cool.html?')).toBe(true);
    expect(url).not.toContain('collabora:9980');
    // WOPI callback points at the internal host Collabora can reach
    expect(url).toContain('WOPISrc=' + encodeURIComponent('http://app:3000/wopi/files/doc-42'));
    expect(url).toMatch(/access_token=[a-f0-9]{64}/);
  });

  test('falls back to COLLABORA_URL for discovery when no internal URL is set', async () => {
    settingsMap({ collabora_url: 'https://edit.acme.com' });
    global.fetch = jest.fn().mockResolvedValue({ ok: true, text: async () => DISCOVERY });
    await collaboraEditUrl(doc, 'docx', req);
    expect(global.fetch).toHaveBeenCalledWith('https://edit.acme.com/hosting/discovery', expect.anything());
  });

  test('returns null (graceful) when discovery is unreachable', async () => {
    settingsMap({ collabora_url: 'https://edit.acme.com' });
    global.fetch = jest.fn().mockRejectedValue(new Error('network down'));
    expect(await collaboraEditUrl(doc, 'docx', req)).toBeNull();
  });
});

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

  test('same-origin: uses the request host even when a stale app_url is set (blank-editor regression)', async () => {
    // app_url is a dead LAN IP; the browser reached Memex via localhost. The
    // editor iframe must load from the request origin, never the stale app_url,
    // or it points at an unreachable host and renders blank.
    settingsMap({ collabora_enabled: 'true', app_url: 'http://10.5.91.18:3000', collabora_internal_url: 'http://collabora:9980', wopi_internal_url: 'http://app:3000' });
    global.fetch = jest.fn().mockResolvedValue({ ok: true, text: async () => DISCOVERY });
    const localReq = { user: { id: 'u1', email: 'u@test.com' }, protocol: 'http', get: () => 'localhost:3000' };
    const url = await collaboraEditUrl(doc, 'docx', localReq);
    expect(url.startsWith('http://localhost:3000/browser/abc123/cool.html?')).toBe(true);
    expect(url).not.toContain('10.5.91.18');
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
    // app_url is required so the WOPI callback host is a configured value (not the
    // client Host); it does not affect which host discovery is fetched from.
    settingsMap({ collabora_url: 'https://edit.acme.com', app_url: 'https://memex.acme.com' });
    global.fetch = jest.fn().mockResolvedValue({ ok: true, text: async () => DISCOVERY });
    await collaboraEditUrl(doc, 'docx', req);
    expect(global.fetch).toHaveBeenCalledWith('https://edit.acme.com/hosting/discovery', expect.anything());
  });

  test('SSRF: the WOPI callback (fetched server-side) uses the configured host, never the client Host', async () => {
    // No wopi_internal_url, so the callback host comes from app_url. A crafted
    // request Host must NOT leak into WOPISrc — that would point Collabora at an
    // internal target server-side and leak the WOPI access token there. It MAY
    // appear as the browser-facing iframe origin (the requester's own browser only).
    settingsMap({ collabora_enabled: 'true', collabora_internal_url: 'http://collabora:9980', app_url: 'http://10.5.91.18:3000' });
    global.fetch = jest.fn().mockResolvedValue({ ok: true, text: async () => DISCOVERY });
    const evilReq = { user: { id: 'u1', email: 'u@test.com' }, protocol: 'http', get: () => '169.254.169.254' };
    const url = await collaboraEditUrl(doc, 'docx', evilReq);
    const wopiSrc = decodeURIComponent(/WOPISrc=([^&]+)/.exec(url)[1]);
    expect(wopiSrc).toBe('http://10.5.91.18:3000/wopi/files/doc-42');
    expect(wopiSrc).not.toContain('169.254.169.254');
    // discovery is fetched from the internal URL, not the attacker Host
    expect(global.fetch).toHaveBeenCalledWith('http://collabora:9980/hosting/discovery', expect.anything());
  });

  test('SSRF: discovery is never fetched from the client Host', async () => {
    // collabora_enabled but no collabora_internal_url and no collabora_url: the old
    // code fell back to the request origin for the discovery fetch (server-side SSRF).
    // With no trusted discovery host, editing is disabled instead.
    settingsMap({ collabora_enabled: 'true', app_url: 'http://10.5.91.18:3000' });
    global.fetch = jest.fn().mockResolvedValue({ ok: true, text: async () => DISCOVERY });
    const evilReq = { user: { id: 'u1', email: 'u@test.com' }, protocol: 'http', get: () => '169.254.169.254' };
    expect(await collaboraEditUrl(doc, 'docx', evilReq)).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('editing is disabled when neither wopi_internal_url nor app_url is set', async () => {
    // Without a configured callback host there is no safe WOPISrc, so editing must
    // be disabled rather than fall back to trusting the client Host header.
    settingsMap({ collabora_enabled: 'true', collabora_internal_url: 'http://collabora:9980' });
    global.fetch = jest.fn().mockResolvedValue({ ok: true, text: async () => DISCOVERY });
    expect(await collaboraEditUrl(doc, 'docx', req)).toBeNull();
  });

  test('returns null (graceful) when discovery is unreachable', async () => {
    settingsMap({ collabora_url: 'https://edit.acme.com', app_url: 'https://memex.acme.com' });
    global.fetch = jest.fn().mockRejectedValue(new Error('network down'));
    expect(await collaboraEditUrl(doc, 'docx', req)).toBeNull();
  });
});

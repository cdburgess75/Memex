'use strict';
jest.mock('../../lib/settings', () => ({ getOrEnv: jest.fn() }));
const { isCollaboraPath, isServicePath } = require('../../lib/collaboraProxy');

describe('isCollaboraPath', () => {
  test('matches Collabora editor asset/endpoint prefixes', () => {
    for (const p of ['/browser', '/browser/abc/cool.html', '/cool/x/ws', '/cool/abc/media', '/cool/abc/clipboard', '/lool/y']) {
      expect(isCollaboraPath(p)).toBe(true);
    }
  });
  test('does not match app routes or the signaling socket', () => {
    for (const p of ['/ws', '/api/files', '/api/notifications', '/u/token', '/vendor/x.js', '/', '/browserify', '/coolant']) {
      expect(isCollaboraPath(p)).toBe(false);
    }
  });

  test('never proxies server-to-server service endpoints (convert-to, discovery, …)', () => {
    for (const p of [
      '/cool/convert-to',
      '/cool/convert-to/',
      '/cool/convert-to?format=png',
      '/lool/convert-to',
      '/cool/extract-link-targets',
      '/cool/extract-document-structure',
      '/cool/render-search-result',
      '/cool/get-thumbnail',
      '/hosting/discovery',
      '/hosting/capabilities',
    ]) {
      expect(isServicePath(p)).toBe(true);
      expect(isCollaboraPath(p)).toBe(false);
    }
    // …while the editor itself and its live WebSocket still proxy
    expect(isServicePath('/cool/abc123/ws')).toBe(false);
    expect(isCollaboraPath('/cool/abc123/ws')).toBe(true);
    expect(isCollaboraPath('/browser/de013a57f9/cool.html')).toBe(true);
  });

  test('never proxies the Collabora admin console / admin websocket', () => {
    for (const p of [
      '/browser/dist/admin/admin.html',
      '/browser/dist/admin/adminSettings.html',
      '/browser/dist/admin-bundle.js',
      '/cool/adminws',
      '/cool/adminws/',
    ]) {
      expect(isCollaboraPath(p)).toBe(false);
    }
    // …while normal editor paths still proxy
    expect(isCollaboraPath('/browser/de013a57f9/cool.html')).toBe(true);
    expect(isCollaboraPath('/cool/abc123/ws')).toBe(true);
  });
});

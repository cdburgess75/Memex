'use strict';
jest.mock('../../lib/settings', () => ({ getOrEnv: jest.fn() }));
const { isCollaboraPath } = require('../../lib/collaboraProxy');

describe('isCollaboraPath', () => {
  test('matches Collabora asset/endpoint prefixes', () => {
    for (const p of ['/browser', '/browser/abc/cool.html', '/hosting/discovery', '/hosting/capabilities', '/cool/x/ws', '/lool/y']) {
      expect(isCollaboraPath(p)).toBe(true);
    }
  });
  test('does not match app routes or the signaling socket', () => {
    for (const p of ['/ws', '/api/files', '/api/notifications', '/u/token', '/vendor/x.js', '/', '/browserify', '/coolant']) {
      expect(isCollaboraPath(p)).toBe(false);
    }
  });
});

'use strict';
// The read-only gate (middleware/licenseGate): which requests it stops while the license
// says read-only, which it never touches, and that it is inert the rest of the time.
const request = require('supertest');
const express = require('express');

jest.mock('../../lib/licenseEnforce', () => ({ readOnly: jest.fn(), refuse: jest.fn((res) => res.status(403).json({ code: 'LICENSE_READONLY', error: 'read-only' })) }));
const enforce = require('../../lib/licenseEnforce');
const gate = require('../../middleware/licenseGate');

const app = express();
app.use(gate);
app.all('*', (req, res) => res.json({ reached: true, method: req.method, path: req.path }));

beforeEach(() => { enforce.readOnly.mockResolvedValue(true); });

describe('what the gate stops', () => {
  const stopped = [
    ['POST', '/api/files/upload'], ['PUT', '/api/files/uploads/s1/chunks/3'], ['DELETE', '/api/files/abc'], ['PATCH', '/api/files/abc'],
    ['POST', '/api/files/abc/shares'], ['POST', '/api/files/share/tok/upload'], ['POST', '/api/files/folder'], ['POST', '/api/files/folder/send'],
    ['POST', '/api/files/folder/share/tok/upload'], ['POST', '/api/files/folder/links'],
    ['POST', '/api/libraries'], ['DELETE', '/api/libraries/1'], ['POST', '/api/groups'], ['POST', '/api/access/grants'],
    ['POST', '/api/meetings'], ['POST', '/api/ai/extract'],
    ['POST', '/api/v1/files'], ['PUT', '/api/v1/files/abc/content'], ['DELETE', '/api/v1/folders/x'],
    ['POST', '/wopi/files/doc-1/contents'], ['POST', '/wopi/files/doc-1'],
    ['PUT', '/dav/Projects/a.txt'], ['DELETE', '/dav/Projects/a.txt'], ['MKCOL', '/dav/Projects/new'], ['MOVE', '/dav/Projects/a.txt'], ['COPY', '/dav/Projects/a.txt'], ['PROPPATCH', '/dav/Projects/a.txt'],
  ];
  test.each(stopped)('%s %s is refused with LICENSE_READONLY', async (method, path) => {
    expect(gate.blocked(method, path)).toBe(true);
    const r = await request(app)[method.toLowerCase()] ? await request(app)[method.toLowerCase()](path) : null;
    if (r) { expect(r.status).toBe(403); expect(r.body.code).toBe('LICENSE_READONLY'); }
  });
});

describe('what keeps working while read-only', () => {
  const open = [
    ['GET', '/api/files'], ['GET', '/api/files/abc/download'], ['GET', '/api/v1/files'], ['HEAD', '/dav/Projects/a.txt'], ['PROPFIND', '/dav/Projects'], ['GET', '/wopi/files/doc-1/contents'],
    ['POST', '/api/files/abc/open'], ['POST', '/api/files/share/tok/opened'], ['POST', '/api/files/share/tok/ticket'],
    ['POST', '/api/files/folder/zip-ticket'], ['POST', '/api/files/folder/share/tok/opened'], ['POST', '/api/files/folder/share/tok/ticket'],
    ['POST', '/api/files/watch'], ['POST', '/api/files/abc/follow'], ['POST', '/api/access/folder-preview'], ['POST', '/api/ai/query'], ['PUT', '/api/ai/active'],
    ['POST', '/api/auth/logout'], ['POST', '/api/license'], ['POST', '/api/log'], ['POST', '/api/csp-report'], ['PUT', '/api/preferences'], ['POST', '/api/notifications/read'],
    ['PUT', '/api/admin/settings'], ['POST', '/api/setup/login-ms365'], ['POST', '/api/tokens'], ['POST', '/api/connectors'], ['POST', '/api/backup/run'], ['PUT', '/api/admin/editor'],
    ['POST', '/api/v1/admin/users/x/disable'], ['LOCK', '/dav/Projects/a.txt'], ['UNLOCK', '/dav/Projects/a.txt'],
  ];
  test.each(open)('%s %s passes', async (method, path) => {
    expect(gate.blocked(method, path)).toBe(false);
    const fn = request(app)[method.toLowerCase()];
    if (fn) {
      const r = await request(app)[method.toLowerCase()](path);
      expect(r.status).toBe(200);
    }
  });
});

describe('when the license is not read-only', () => {
  test('nothing is touched, and the license is only asked about content changes', async () => {
    enforce.readOnly.mockResolvedValue(false);
    expect((await request(app).post('/api/files/upload')).body).toEqual({ reached: true, method: 'POST', path: '/api/files/upload' });
    expect(enforce.readOnly).toHaveBeenCalledTimes(1);
    await request(app).get('/api/files');
    expect(enforce.readOnly).toHaveBeenCalledTimes(1);
  });
  test('a failure to evaluate lets the request through rather than breaking the app', async () => {
    enforce.readOnly.mockRejectedValue(new Error('boom'));
    expect((await request(app).post('/api/files/upload')).status).toBe(200);
  });
});

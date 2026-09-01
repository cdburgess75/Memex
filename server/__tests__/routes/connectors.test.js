'use strict';
// Route-level behavior for external storage connections: who may see what, that a
// read-only mount really is read-only, and that a traversal attempt dies at the edge
// rather than reaching an adapter.
let mockRole = 'admin';
jest.mock('../../middleware/auth', () => (req, _res, next) => {
  req.user = { id: 'u1', email: 'dave@x.com', role: mockRole };
  next();
});
jest.mock('../../middleware/requireRole', () => (...roles) => (req, res, next) =>
  roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'forbidden' }));
jest.mock('../../lib/auditLog', () => ({ append: jest.fn(async () => {}) }));
jest.mock('../../lib/keycloakAdmin', () => ({ getBrokerToken: jest.fn(async () => 'user-graph-token') }));
jest.mock('../../lib/smbSessionCreds', () => ({ get: jest.fn(() => null), set: jest.fn(), forget: jest.fn() }));
jest.mock('../../lib/email', () => ({ sendMail: jest.fn(async () => ({ sent: true, via: 'graph' })) }));
jest.mock('../../lib/connectors', () => ({
  catalog: jest.fn(() => [{ kind: 'smb', label: 'SMB', fields: [] }]),
  list: jest.fn(),
  getRow: jest.fn(),
  resolve: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
  remove: jest.fn(),
  recordTest: jest.fn(async () => {}),
}));

const express = require('express');
const request = require('supertest');
const connectors = require('../../lib/connectors');
const audit = require('../../lib/auditLog');
const keycloakAdmin = require('../../lib/keycloakAdmin');
const smbSessionCreds = require('../../lib/smbSessionCreds');
const email = require('../../lib/email');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/connectors', require('../../routes/connectors'));
  return a;
}

const SMB_ADAPTER = {
  label: 'SMB', caps: { write: true, remove: true, mkdir: true, range: true, move: true, share: true, invite: true },
  list: jest.fn(async () => [{ name: 'a.txt', path: 'a.txt', type: 'file', size: 1, modified: null }]),
  read: jest.fn(), write: jest.fn(async () => {}), remove: jest.fn(), mkdir: jest.fn(),
  move: jest.fn(async () => {}),
  share: jest.fn(async (_cfg, _path, opts) => ({ url: 'https://sp/link', type: opts.type, scope: 'organization' })),
  shareInvite: jest.fn(async (_cfg, _path, opts) => ({ invited: opts.emails, type: opts.type, native: false, url: 'https://sp/x' })),
  test: jest.fn(async () => ({ message: 'Connected.' })),
};

beforeEach(() => {
  mockRole = 'admin';
  jest.clearAllMocks();
  SMB_ADAPTER.list.mockResolvedValue([{ name: 'a.txt', path: 'a.txt', type: 'file', size: 1, modified: null }]);
  SMB_ADAPTER.test.mockResolvedValue({ message: 'Connected.' });
});

describe('GET /api/connectors', () => {
  const full = [{
    id: 'c1', name: 'Engineering', kind: 'smb', label: 'SMB', caps: {}, enabled: true, readOnly: true,
    config: { host: 'files.internal.corp', rootPath: 'Projects' }, hasSecrets: true,
    lastStatus: 'ok', lastError: null, lastCheckedAt: null,
  }];

  test('an admin sees the full record', async () => {
    connectors.list.mockResolvedValue(full);
    const res = await request(app()).get('/api/connectors');
    expect(res.status).toBe(200);
    expect(res.body.connectors[0].config.host).toBe('files.internal.corp');
  });

  test('a non-admin never sees the connection config', async () => {
    // `config` carries internal hostnames and share paths — reconnaissance a viewer
    // has no need for, even though they may legitimately browse the mount.
    mockRole = 'viewer';
    connectors.list.mockResolvedValue(full);
    const res = await request(app()).get('/api/connectors');
    expect(res.status).toBe(200);
    expect(res.body.connectors[0].config).toBeUndefined();
    expect(res.body.connectors[0].hasSecrets).toBeUndefined();
    expect(res.body.connectors[0].name).toBe('Engineering');
  });

  test('a non-admin does not see disabled mounts', async () => {
    mockRole = 'viewer';
    connectors.list.mockResolvedValue([{ ...full[0], enabled: false }]);
    const res = await request(app()).get('/api/connectors');
    expect(res.body.connectors).toHaveLength(0);
  });
});

describe('management is admin-only', () => {
  test.each([
    ['get', '/api/connectors/kinds'],
    ['post', '/api/connectors'],
    ['put', '/api/connectors/c1'],
    ['delete', '/api/connectors/c1'],
    ['post', '/api/connectors/c1/test'],
  ])('%s %s is refused for a contributor', async (method, url) => {
    mockRole = 'contributor';
    const res = await request(app())[method](url).send({});
    expect(res.status).toBe(403);
  });
});

describe('GET /api/connectors/:id/browse', () => {
  test('lists entries at a path', async () => {
    connectors.resolve.mockResolvedValue({ row: { name: 'Eng', read_only: true }, adapter: SMB_ADAPTER, cfg: {} });
    const res = await request(app()).get('/api/connectors/c1/browse?path=sub/dir');
    expect(res.status).toBe(200);
    expect(SMB_ADAPTER.list).toHaveBeenCalledWith({}, 'sub/dir');
    expect(res.body.entries[0].name).toBe('a.txt');
  });

  test('passes an adapter openUrl through untouched (Open in Microsoft 365)', async () => {
    SMB_ADAPTER.list.mockResolvedValue([
      { name: 'plan.docx', path: 'plan.docx', type: 'file', size: 9, modified: null, openUrl: 'https://acme.sharepoint.com/sites/Ops/plan.docx' },
      { name: 'a.txt', path: 'a.txt', type: 'file', size: 1, modified: null },
    ]);
    connectors.resolve.mockResolvedValue({ row: { name: 'Eng', read_only: true }, adapter: SMB_ADAPTER, cfg: {} });
    const res = await request(app()).get('/api/connectors/c1/browse?path=');
    expect(res.body.entries[0].openUrl).toBe('https://acme.sharepoint.com/sites/Ops/plan.docx');
    expect(res.body.entries[1].openUrl).toBeUndefined();
  });

  test('a traversal attempt is refused before the adapter is reached', async () => {
    connectors.resolve.mockResolvedValue({ row: { name: 'Eng', read_only: true }, adapter: SMB_ADAPTER, cfg: {} });
    const res = await request(app()).get('/api/connectors/c1/browse?path=../../etc');
    // 400 with the reason, not a 500: the caller sent a bad path, the server is fine.
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/escapes/);
    expect(SMB_ADAPTER.list).not.toHaveBeenCalled();
  });
});

describe('write paths respect the read-only flag', () => {
  test('PUT is refused on a read-only mount', async () => {
    connectors.resolve.mockResolvedValue({ row: { name: 'Eng', read_only: true }, adapter: SMB_ADAPTER, cfg: {} });
    const res = await request(app()).put('/api/connectors/c1/file?path=a.txt').send('data');
    expect(res.status).toBe(403);
    expect(SMB_ADAPTER.write).not.toHaveBeenCalled();
  });

  test('PUT succeeds on a writable mount and is audited', async () => {
    connectors.resolve.mockResolvedValue({ row: { name: 'Eng', read_only: false }, adapter: SMB_ADAPTER, cfg: {} });
    const res = await request(app()).put('/api/connectors/c1/file?path=a.txt').send('data');
    expect(res.status).toBe(200);
    expect(SMB_ADAPTER.write).toHaveBeenCalled();
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'connector_write' }));
  });

  test('DELETE is refused on a read-only mount', async () => {
    connectors.resolve.mockResolvedValue({ row: { name: 'Eng', read_only: true }, adapter: SMB_ADAPTER, cfg: {} });
    const res = await request(app()).delete('/api/connectors/c1/file?path=a.txt');
    expect(res.status).toBe(403);
    expect(SMB_ADAPTER.remove).not.toHaveBeenCalled();
  });
});

describe('content access gating: delegated defers to 365, app-only is gated by Depot', () => {
  test('app-only mount: a view-only guest is refused browse (shared identity → Depot must gate)', async () => {
    mockRole = 'viewer';
    connectors.resolve.mockResolvedValue({ row: { name: 'Eng', read_only: true }, adapter: SMB_ADAPTER, cfg: {} });
    const res = await request(app()).get('/api/connectors/c1/browse?path=');
    expect(res.status).toBe(403);
    expect(SMB_ADAPTER.list).not.toHaveBeenCalled();
    expect(keycloakAdmin.getBrokerToken).not.toHaveBeenCalled();
  });

  test('delegated SharePoint: any signed-in user may browse — 365 decides — and their own token is injected', async () => {
    mockRole = 'viewer';
    connectors.resolve.mockResolvedValue({ row: { id: 'c1', kind: 'sharepoint', name: 'SP', read_only: true }, adapter: SMB_ADAPTER, cfg: { delegated: true } });
    const res = await request(app()).get('/api/connectors/c1/browse?path=');
    expect(res.status).toBe(200);
    expect(keycloakAdmin.getBrokerToken).toHaveBeenCalled();
    expect(SMB_ADAPTER.list).toHaveBeenCalledWith(expect.objectContaining({ delegatedToken: 'user-graph-token' }), '');
  });

  test('delegated SharePoint: the Depot read-only flag does NOT block writes — SharePoint decides', async () => {
    mockRole = 'viewer';
    connectors.resolve.mockResolvedValue({ row: { id: 'c1', kind: 'sharepoint', name: 'SP', read_only: true }, adapter: SMB_ADAPTER, cfg: { delegated: true } });
    const res = await request(app()).put('/api/connectors/c1/file?path=a.txt').send('data');
    expect(res.status).toBe(200);
    expect(SMB_ADAPTER.write).toHaveBeenCalled();
  });

  test('delegated SMB without an unlock: browse returns 428 with a credentials-required code', async () => {
    mockRole = 'viewer';
    smbSessionCreds.get.mockReturnValueOnce(null);
    connectors.resolve.mockResolvedValue({ row: { id: 'c1', kind: 'smb', name: 'Files', read_only: true }, adapter: SMB_ADAPTER, cfg: { delegated: true } });
    const res = await request(app()).get('/api/connectors/c1/browse?path=');
    expect(res.status).toBe(428);
    expect(res.body.code).toBe('SMB_CREDENTIALS_REQUIRED');
    expect(SMB_ADAPTER.list).not.toHaveBeenCalled();
  });

  test('delegated SMB after unlock: the user’s own credentials are injected into the adapter cfg', async () => {
    mockRole = 'viewer';
    smbSessionCreds.get.mockReturnValueOnce({ domain: 'CORP', username: 'jdoe', password: 'pw' });
    connectors.resolve.mockResolvedValue({ row: { id: 'c1', kind: 'smb', name: 'Files', read_only: true }, adapter: SMB_ADAPTER, cfg: { delegated: true, host: 'fs', share: 'Eng' } });
    const res = await request(app()).get('/api/connectors/c1/browse?path=');
    expect(res.status).toBe(200);
    expect(SMB_ADAPTER.list).toHaveBeenCalledWith(expect.objectContaining({ username: 'jdoe', password: 'pw', domain: 'CORP' }), '');
  });

  test('admin Test on a delegated SMB mount reports per-user, not a persisted failure', async () => {
    mockRole = 'admin';
    smbSessionCreds.get.mockReturnValueOnce(null);
    connectors.resolve.mockResolvedValue({ row: { id: 'c1', kind: 'smb', name: 'Files' }, adapter: SMB_ADAPTER, cfg: { delegated: true } });
    const res = await request(app()).post('/api/connectors/c1/test');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.message).toMatch(/per-user/i);
    // must NOT stamp the connector as errored for lacking a service credential
    expect(connectors.recordTest).not.toHaveBeenCalled();
    expect(SMB_ADAPTER.test).not.toHaveBeenCalled();
  });
});

describe('POST /api/connectors/:id/test', () => {
  test('reports success and records it', async () => {
    connectors.resolve.mockResolvedValue({ row: {}, adapter: SMB_ADAPTER, cfg: {} });
    const res = await request(app()).post('/api/connectors/c1/test');
    expect(res.body).toEqual({ ok: true, message: 'Connected.' });
    expect(connectors.recordTest).toHaveBeenCalledWith('c1', true, null);
  });

  test('a failure is a 200 carrying ok:false, so the UI can show the reason', async () => {
    // A failed *test* is a successful *request* — the operator asked a question and
    // got an answer. Returning 5xx here would make the UI show a generic error
    // instead of the credential or path problem they need to see.
    connectors.resolve.mockResolvedValue({ row: {}, adapter: SMB_ADAPTER, cfg: {} });
    SMB_ADAPTER.test.mockRejectedValue(new Error('STATUS_LOGON_FAILURE'));
    const res = await request(app()).post('/api/connectors/c1/test');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.message).toMatch(/LOGON_FAILURE/);
    expect(connectors.recordTest).toHaveBeenCalledWith('c1', false, 'STATUS_LOGON_FAILURE');
  });
});

describe('POST /api/connectors/:id/move (rename)', () => {
  test('renames when writable — calls adapter.move(cfg, from, to)', async () => {
    connectors.resolve.mockResolvedValue({ row: { name: 'Eng', read_only: false }, adapter: SMB_ADAPTER, cfg: {} });
    const res = await request(app()).post('/api/connectors/c1/move').send({ from: 'a.txt', to: 'b.txt' });
    expect(res.status).toBe(200);
    expect(SMB_ADAPTER.move).toHaveBeenCalledWith({}, 'a.txt', 'b.txt');
  });

  test('read-only connector rejects rename (403, adapter untouched)', async () => {
    connectors.resolve.mockResolvedValue({ row: { name: 'Eng', read_only: true }, adapter: SMB_ADAPTER, cfg: {} });
    const res = await request(app()).post('/api/connectors/c1/move').send({ from: 'a.txt', to: 'b.txt' });
    expect(res.status).toBe(403);
    expect(SMB_ADAPTER.move).not.toHaveBeenCalled();
  });

  test('requires both from and to', async () => {
    connectors.resolve.mockResolvedValue({ row: { name: 'Eng', read_only: false }, adapter: SMB_ADAPTER, cfg: {} });
    const res = await request(app()).post('/api/connectors/c1/move').send({ from: 'a.txt' });
    expect(res.status).toBe(400);
    expect(SMB_ADAPTER.move).not.toHaveBeenCalled();
  });
});

describe('POST /api/connectors/:id/share (sharing link)', () => {
  test('view link works even on a read-only mount, and returns the url', async () => {
    connectors.resolve.mockResolvedValue({ row: { name: 'SP', read_only: true }, adapter: SMB_ADAPTER, cfg: {} });
    const res = await request(app()).post('/api/connectors/c1/share').send({ path: 'CEO.docx', type: 'view' });
    expect(res.status).toBe(200);
    expect(res.body.url).toBe('https://sp/link');
    expect(SMB_ADAPTER.share).toHaveBeenCalledWith({}, 'CEO.docx', { type: 'view' });
  });

  test('edit link is blocked on a read-only (app-only) mount', async () => {
    connectors.resolve.mockResolvedValue({ row: { name: 'SP', read_only: true }, adapter: SMB_ADAPTER, cfg: {} });
    const res = await request(app()).post('/api/connectors/c1/share').send({ path: 'CEO.docx', type: 'edit' });
    expect(res.status).toBe(403);
    expect(SMB_ADAPTER.share).not.toHaveBeenCalled();
  });

  test('requires a path', async () => {
    connectors.resolve.mockResolvedValue({ row: { name: 'SP', read_only: false }, adapter: SMB_ADAPTER, cfg: {} });
    const res = await request(app()).post('/api/connectors/c1/share').send({ type: 'view' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/connectors/:id/invite (share by email)', () => {
  beforeEach(() => {
    // Default: app-only SharePoint — adapter grants + returns a webUrl, route emails.
    SMB_ADAPTER.shareInvite.mockImplementation(async (_cfg, _path, opts) => (
      { invited: opts.emails, type: opts.type, native: false, url: 'https://sp/x' }
    ));
    email.sendMail.mockReset();
    email.sendMail.mockResolvedValue({ sent: true, via: 'graph' });
  });

  test('app-only: grants access and Depot emails each recipient individually', async () => {
    connectors.resolve.mockResolvedValue({ row: { name: 'SP', read_only: false }, adapter: SMB_ADAPTER, cfg: {} });
    const res = await request(app()).post('/api/connectors/c1/invite')
      .send({ path: 'f.docx', emails: ['a@x.com', 'b@x.com', 'c@x.com'], type: 'view' });
    expect(res.status).toBe(200);
    expect(res.body.emailed).toBe(3);
    expect(res.body.warning).toBeUndefined();
    expect(email.sendMail).toHaveBeenCalledTimes(3);
    // one message per recipient — addresses are not disclosed to each other
    expect(email.sendMail.mock.calls.map(c => c[0].to)).toEqual(['a@x.com', 'b@x.com', 'c@x.com']);
    expect(email.sendMail.mock.calls.every(c => c[0].actorEmail === 'dave@x.com')).toBe(true);
  });

  test('app-only: partial email failure is surfaced as a warning, not silent success', async () => {
    connectors.resolve.mockResolvedValue({ row: { name: 'SP', read_only: false }, adapter: SMB_ADAPTER, cfg: {} });
    email.sendMail
      .mockResolvedValueOnce({ sent: true })
      .mockResolvedValueOnce({ sent: false, reason: 'timeout' })
      .mockResolvedValueOnce({ sent: true });
    const res = await request(app()).post('/api/connectors/c1/invite')
      .send({ path: 'f.docx', emails: ['a@x.com', 'b@x.com', 'c@x.com'], type: 'view' });
    expect(res.status).toBe(200);
    expect(res.body.emailed).toBe(2);
    expect(res.body.warning).toMatch(/only 2 could be emailed/);
  });

  test('app-only: no share link available → access granted, warning that nothing was emailed', async () => {
    connectors.resolve.mockResolvedValue({ row: { name: 'SP', read_only: false }, adapter: SMB_ADAPTER, cfg: {} });
    SMB_ADAPTER.shareInvite.mockResolvedValueOnce({ invited: ['a@x.com'], type: 'view', native: false, url: null });
    const res = await request(app()).post('/api/connectors/c1/invite')
      .send({ path: 'f.docx', emails: ['a@x.com'], type: 'view' });
    expect(res.status).toBe(200);
    expect(res.body.emailed).toBe(0);
    expect(res.body.warning).toMatch(/no share link/);
    expect(email.sendMail).not.toHaveBeenCalled();
  });

  test('the adapter’s 400 guidance reaches the client (not swallowed as a 5xx)', async () => {
    connectors.resolve.mockResolvedValue({ row: { name: 'SP', read_only: false }, adapter: SMB_ADAPTER, cfg: {} });
    const err = new Error('Could not grant access to one of those people. App-only connections can share with existing users and guests, but cannot add a brand-new external guest — add them in SharePoint first, or use a delegated connection.');
    err.status = 400;
    SMB_ADAPTER.shareInvite.mockRejectedValueOnce(err);
    const res = await request(app()).post('/api/connectors/c1/invite')
      .send({ path: 'f.docx', emails: ['newguest@other.com'], type: 'view' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/brand-new external guest/);
  });

  test('delegated: SharePoint emails natively, Depot sends nothing', async () => {
    connectors.resolve.mockResolvedValue({ row: { name: 'SP', read_only: false }, adapter: SMB_ADAPTER, cfg: { delegated: true } });
    SMB_ADAPTER.shareInvite.mockResolvedValueOnce({ invited: ['a@x.com'], type: 'view', native: true, url: null });
    const res = await request(app()).post('/api/connectors/c1/invite')
      .send({ path: 'f.docx', emails: ['a@x.com'], type: 'view' });
    expect(res.status).toBe(200);
    expect(res.body.emailed).toBe(1);
    expect(email.sendMail).not.toHaveBeenCalled();
  });

  test('edit invite on a read-only app-only mount is blocked before any grant', async () => {
    connectors.resolve.mockResolvedValue({ row: { name: 'SP', read_only: true }, adapter: SMB_ADAPTER, cfg: {} });
    const res = await request(app()).post('/api/connectors/c1/invite')
      .send({ path: 'f.docx', emails: ['a@x.com'], type: 'edit' });
    expect(res.status).toBe(403);
    expect(SMB_ADAPTER.shareInvite).not.toHaveBeenCalled();
    expect(email.sendMail).not.toHaveBeenCalled();
  });

  test('requires at least a path', async () => {
    connectors.resolve.mockResolvedValue({ row: { name: 'SP', read_only: false }, adapter: SMB_ADAPTER, cfg: {} });
    const res = await request(app()).post('/api/connectors/c1/invite').send({ emails: ['a@x.com'], type: 'view' });
    expect(res.status).toBe(400);
  });
});

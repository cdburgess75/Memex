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

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/connectors', require('../../routes/connectors'));
  return a;
}

const SMB_ADAPTER = {
  label: 'SMB', caps: { write: true, remove: true, mkdir: true, range: true },
  list: jest.fn(async () => [{ name: 'a.txt', path: 'a.txt', type: 'file', size: 1, modified: null }]),
  read: jest.fn(), write: jest.fn(async () => {}), remove: jest.fn(), mkdir: jest.fn(),
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

  test('delegated mount: any signed-in user may browse — 365 decides — and their own token is injected', async () => {
    mockRole = 'viewer';
    connectors.resolve.mockResolvedValue({ row: { name: 'SP', read_only: true }, adapter: SMB_ADAPTER, cfg: { delegated: true } });
    const res = await request(app()).get('/api/connectors/c1/browse?path=');
    expect(res.status).toBe(200);
    expect(keycloakAdmin.getBrokerToken).toHaveBeenCalled();
    expect(SMB_ADAPTER.list).toHaveBeenCalledWith(expect.objectContaining({ delegatedToken: 'user-graph-token' }), '');
  });

  test('delegated mount: the Depot read-only flag does NOT block writes — SharePoint decides', async () => {
    mockRole = 'viewer';
    connectors.resolve.mockResolvedValue({ row: { name: 'SP', read_only: true }, adapter: SMB_ADAPTER, cfg: { delegated: true } });
    const res = await request(app()).put('/api/connectors/c1/file?path=a.txt').send('data');
    expect(res.status).toBe(200);
    expect(SMB_ADAPTER.write).toHaveBeenCalled();
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

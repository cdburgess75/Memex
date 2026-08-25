'use strict';
const request = require('supertest');
const express = require('express');

const MOCK_ENV_MAP = { anthropic_api_key: 'ANTHROPIC_API_KEY', tenant_id: 'TENANT_ID', brand_name: 'BRAND_NAME' };

jest.mock('../../lib/settings', () => ({
  ENV_MAP: MOCK_ENV_MAP,
  get: jest.fn().mockResolvedValue(null),
  getOrEnv: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../lib/email', () => ({ sendMail: jest.fn() }));
const settings = require('../../lib/settings');
const email = require('../../lib/email');

let mockUser = { id: 'u1', email: 'admin@test.com', role: 'admin' };
jest.mock('../../middleware/auth', () => (req, _res, next) => { req.user = mockUser; next(); });

const app = express();
app.use(express.json());
app.use('/api/setup', require('../../routes/setup'));

const completed = (k) => (k === 'setup_completed' ? 'true' : null);

beforeEach(() => {
  settings.get.mockResolvedValue(null);
  settings.getOrEnv.mockResolvedValue(null);
  settings.set.mockClear();
  email.sendMail.mockReset();
  mockUser = { id: 'u1', email: 'admin@test.com', role: 'admin' };
});

describe('setup route', () => {
  test('GET /status reports required when not yet completed', async () => {
    const r = await request(app).get('/api/setup/status');
    expect(r.status).toBe(200);
    expect(r.body.required).toBe(true);
    expect(r.body.completed).toBe(false);
    expect(r.body.adminEmail).toBe('admin@test.com');
  });

  test('GET /status reports not-required once completed', async () => {
    settings.get.mockImplementation(async (k) => completed(k));
    const r = await request(app).get('/api/setup/status');
    expect(r.body.required).toBe(false);
    expect(r.body.completed).toBe(true);
  });

  test('POST /complete flips the durable flag when incomplete', async () => {
    const r = await request(app).post('/api/setup/complete').send({});
    expect(r.status).toBe(200);
    expect(settings.set).toHaveBeenCalledWith('setup_completed', 'true', 'u1');
  });

  test('POST /complete is rejected (409) once already completed', async () => {
    settings.get.mockImplementation(async (k) => completed(k));
    const r = await request(app).post('/api/setup/complete').send({});
    expect(r.status).toBe(409);
  });

  test('POST /tenant saves identity fields when incomplete', async () => {
    const r = await request(app).post('/api/setup/tenant').send({ orgName: 'Acme', tenantId: 'acme', contactEmail: 'it@acme.com' });
    expect(r.status).toBe(200);
    expect(settings.set).toHaveBeenCalledWith('brand_name', 'Acme', 'u1');
    expect(settings.set).toHaveBeenCalledWith('tenant_id', 'acme', 'u1');
    expect(settings.set).toHaveBeenCalledWith('tenant_contact_email', 'it@acme.com', 'u1');
  });

  test('POST /tenant saves branding (accent + logo data URI)', async () => {
    await request(app).post('/api/setup/tenant').send({ orgName: 'Acme', accent: '#123456', logo: 'data:image/png;base64,AAA' });
    expect(settings.set).toHaveBeenCalledWith('brand_accent', '#123456', 'u1');
    expect(settings.set).toHaveBeenCalledWith('brand_logo', 'data:image/png;base64,AAA', 'u1');
  });

  test('POST /tenant with logo="" clears the logo; absent logo leaves it', async () => {
    await request(app).post('/api/setup/tenant').send({ orgName: 'Acme', logo: '' });
    expect(settings.set).toHaveBeenCalledWith('brand_logo', null, 'u1');
    settings.set.mockClear();
    await request(app).post('/api/setup/tenant').send({ orgName: 'Acme' }); // no logo field
    expect(settings.set).not.toHaveBeenCalledWith('brand_logo', expect.anything(), 'u1');
  });

  test('POST /tenant is rejected once completed (config goes through Settings then)', async () => {
    settings.get.mockImplementation(async (k) => completed(k));
    const r = await request(app).post('/api/setup/tenant').send({ orgName: 'X' });
    expect(r.status).toBe(409);
  });

  test('GET /export blanks secret values, keeps non-secrets', async () => {
    settings.get.mockImplementation(async (k) => ({ anthropic_api_key: 'sk-ant-secret', tenant_id: 'acme', brand_name: 'Acme' }[k] ?? null));
    const r = await request(app).get('/api/setup/export');
    expect(r.status).toBe(200);
    expect(r.body.settings.anthropic_api_key).toBe(''); // secret blanked
    expect(r.body.settings.tenant_id).toBe('acme');
    expect(r.body.settings.brand_name).toBe('Acme');
  });

  test('POST /test/email reports success from sendMail', async () => {
    email.sendMail.mockResolvedValue({ sent: true, via: 'smtp' });
    const r = await request(app).post('/api/setup/test/email').send({ to: 'x@y.com' });
    expect(r.body.ok).toBe(true);
    expect(r.body.via).toBe('smtp');
    expect(email.sendMail).toHaveBeenCalled();
  });

  test('POST /test/email surfaces not-configured cleanly', async () => {
    email.sendMail.mockResolvedValue({ sent: false, reason: 'not_configured' });
    const r = await request(app).post('/api/setup/test/email').send({});
    expect(r.body.ok).toBe(false);
    expect(r.body.error).toMatch(/not configured/i);
  });

  test('non-admin is forbidden from setup mutations', async () => {
    mockUser = { id: 'u2', email: 'v@test.com', role: 'viewer' };
    const r = await request(app).post('/api/setup/tenant').send({ orgName: 'X' });
    expect(r.status).toBe(403);
  });
});

describe('POST /integrations — Microsoft 365 (Graph) email credentials', () => {
  const post = (body) => request(app).post('/api/setup/integrations').send(body);

  test('client-secret path stores the secret and clears any certificate', async () => {
    const r = await post({
      emailProvider: 'graph', emailFrom: 'depot@acme.com',
      graphTenantId: 't-guid', graphClientId: 'c-guid',
      graphCredType: 'secret', graphClientSecret: 'shh',
    });
    expect(r.status).toBe(200);
    expect(settings.set).toHaveBeenCalledWith('email_provider', 'graph', 'u1');
    expect(settings.set).toHaveBeenCalledWith('graph_tenant_id', 't-guid', 'u1');
    expect(settings.set).toHaveBeenCalledWith('graph_client_id', 'c-guid', 'u1');
    expect(settings.set).toHaveBeenCalledWith('graph_client_secret', 'shh', 'u1');
    // Certificate fields cleared so a stale cert can't shadow the secret.
    expect(settings.set).toHaveBeenCalledWith('graph_cert_thumbprint', null, 'u1');
    expect(settings.set).toHaveBeenCalledWith('graph_cert_key', null, 'u1');
    expect(settings.set).toHaveBeenCalledWith('graph_cert_key_path', null, 'u1');
  });

  test('omitting graphCredType defaults to the client-secret path', async () => {
    await post({ emailProvider: 'graph', emailFrom: 'depot@acme.com', graphClientSecret: 'shh' });
    expect(settings.set).toHaveBeenCalledWith('graph_client_secret', 'shh', 'u1');
    expect(settings.set).not.toHaveBeenCalledWith('graph_cert_thumbprint', expect.anything(), 'u1');
  });

  test('a blank client secret keeps the current one (guarded), still clearing the cert', async () => {
    await post({ emailProvider: 'graph', graphCredType: 'secret', graphClientSecret: '' });
    expect(settings.set).not.toHaveBeenCalledWith('graph_client_secret', expect.anything(), 'u1');
    expect(settings.set).toHaveBeenCalledWith('graph_cert_key', null, 'u1');
  });

  test('certificate path — pasted PEM stores thumbprint + key, clears key-path and secret', async () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----';
    const r = await post({
      emailProvider: 'graph', emailFrom: 'depot@acme.com',
      graphTenantId: 't-guid', graphClientId: 'c-guid',
      graphCredType: 'cert', graphCertThumbprint: 'AABBCC', graphCertKey: pem,
    });
    expect(r.status).toBe(200);
    expect(settings.set).toHaveBeenCalledWith('graph_cert_thumbprint', 'AABBCC', 'u1');
    expect(settings.set).toHaveBeenCalledWith('graph_cert_key', pem, 'u1');
    expect(settings.set).toHaveBeenCalledWith('graph_cert_key_path', null, 'u1');
    expect(settings.set).toHaveBeenCalledWith('graph_client_secret', null, 'u1');
    // No real secret was written — only the null-clear above.
    expect(settings.set).not.toHaveBeenCalledWith('graph_client_secret', expect.anything(), 'u1');
  });

  test('certificate path — key file path stores thumbprint + path, clears pasted key and secret', async () => {
    const r = await post({
      emailProvider: 'graph', emailFrom: 'depot@acme.com',
      graphTenantId: 't-guid', graphClientId: 'c-guid',
      graphCredType: 'cert', graphCertThumbprint: 'AABBCC', graphCertKeyPath: '/secrets/graph.pem',
    });
    expect(r.status).toBe(200);
    expect(settings.set).toHaveBeenCalledWith('graph_cert_thumbprint', 'AABBCC', 'u1');
    expect(settings.set).toHaveBeenCalledWith('graph_cert_key_path', '/secrets/graph.pem', 'u1');
    expect(settings.set).toHaveBeenCalledWith('graph_cert_key', null, 'u1');
    expect(settings.set).toHaveBeenCalledWith('graph_client_secret', null, 'u1');
  });

  test('a pasted PEM wins over a path when both are sent (matches graphConfig precedence)', async () => {
    await post({
      emailProvider: 'graph', graphCredType: 'cert', graphCertThumbprint: 'AABBCC',
      graphCertKey: '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----',
      graphCertKeyPath: '/secrets/graph.pem',
    });
    expect(settings.set).toHaveBeenCalledWith('graph_cert_key', expect.stringContaining('PRIVATE KEY'), 'u1');
    expect(settings.set).toHaveBeenCalledWith('graph_cert_key_path', null, 'u1');
    // The path was not stored as a value.
    expect(settings.set).not.toHaveBeenCalledWith('graph_cert_key_path', '/secrets/graph.pem', 'u1');
  });
});

describe('POST /mfa — Keycloak required-action toggle', () => {
  // The admin REST route lives under /authentication/; the bare alias 404s.
  // This URL shipped broken for months because the call was unreachable (the
  // container never had admin creds) — pin it so it cannot silently rot again.
  const realFetch = global.fetch;
  beforeEach(() => {
    process.env.KEYCLOAK_INTERNAL_URL = 'http://keycloak:8080';
    process.env.KEYCLOAK_ADMIN_USER = 'admin';
    process.env.KEYCLOAK_ADMIN_PASSWORD = 'test-admin-pass';
  });
  afterEach(() => {
    global.fetch = realFetch;
    delete process.env.KEYCLOAK_INTERNAL_URL;
    delete process.env.KEYCLOAK_ADMIN_USER;
    delete process.env.KEYCLOAK_ADMIN_PASSWORD;
  });

  test('PUTs the /authentication/ required-actions route and records mfa_required', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'tok' }) })
      .mockResolvedValueOnce({ ok: true, status: 204 });
    const r = await request(app).post('/api/setup/mfa').send({ enable: true });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    const putUrl = global.fetch.mock.calls[1][0];
    expect(putUrl).toBe('http://keycloak:8080/admin/realms/memex/authentication/required-actions/CONFIGURE_TOTP');
    expect(global.fetch.mock.calls[1][1].method).toBe('PUT');
    expect(settings.set).toHaveBeenCalledWith('mfa_required', 'true', 'u1');
  });

  test('failure returns ok:false with the manual-console hint, and does not record the setting', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'tok' }) })
      .mockResolvedValueOnce({ ok: false, status: 404 });
    const r = await request(app).post('/api/setup/mfa').send({ enable: true });
    expect(r.body.ok).toBe(false);
    expect(r.body.error).toMatch(/404/);
    expect(r.body.hint).toMatch(/Required Actions/);
    expect(settings.set).not.toHaveBeenCalled();
  });
});

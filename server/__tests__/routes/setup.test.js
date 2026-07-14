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

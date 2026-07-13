'use strict';
const request = require('supertest');
const express = require('express');

const MASKED = '●●●●●●●●';

// Minimal ENV_MAP for the route to work with
const MOCK_ENV_MAP = {
  anthropic_api_key:    'ANTHROPIC_API_KEY',
  anthropic_model:      'ANTHROPIC_MODEL',
  storage_provider:     'STORAGE_PROVIDER',
  backup_destinations:  'BACKUP_DESTINATIONS',
};

jest.mock('../../lib/settings', () => ({
  ENV_MAP:    MOCK_ENV_MAP,
  getOrEnv:   jest.fn(),
  set:        jest.fn().mockResolvedValue(undefined),
  refresh:    jest.fn().mockResolvedValue(undefined),
  _reset:     jest.fn(),
}));
const settings = require('../../lib/settings');

let mockUser = { id: 'u1', email: 'admin@test.com', role: 'admin' };
jest.mock('../../middleware/auth', () => (req, _res, next) => {
  req.user = mockUser;
  next();
});

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/settings', require('../../routes/settings'));
  return app;
}

beforeEach(() => {
  settings.getOrEnv.mockResolvedValue(null);
});

describe('GET /api/admin/settings', () => {
  test('returns all settings with non-sensitive values', async () => {
    settings.getOrEnv.mockImplementation(key =>
      key === 'anthropic_model' ? Promise.resolve('claude-sonnet-4-6') : Promise.resolve(null)
    );
    const res = await request(makeApp()).get('/api/admin/settings');
    expect(res.status).toBe(200);
    expect(res.body.anthropic_model).toBe('claude-sonnet-4-6');
  });

  test('masks sensitive values when present', async () => {
    settings.getOrEnv.mockImplementation(key =>
      key === 'anthropic_api_key' ? Promise.resolve('sk-ant-real-key') : Promise.resolve(null)
    );
    const res = await request(makeApp()).get('/api/admin/settings');
    expect(res.status).toBe(200);
    expect(res.body.anthropic_api_key).toBe(MASKED);
  });

  test('returns empty string for unset values', async () => {
    const res = await request(makeApp()).get('/api/admin/settings');
    expect(res.status).toBe(200);
    expect(res.body.anthropic_model).toBe('');
  });

  test('returns 403 for non-admin users', async () => {
    mockUser = { id: 'u2', email: 'user@test.com', role: 'contributor' };
    const res = await request(makeApp()).get('/api/admin/settings');
    expect(res.status).toBe(403);
    mockUser = { id: 'u1', email: 'admin@test.com', role: 'admin' };
  });
});

describe('PUT /api/admin/settings', () => {
  test('saves non-sensitive values', async () => {
    const res = await request(makeApp())
      .put('/api/admin/settings')
      .send({ anthropic_model: 'claude-opus-4-8' });
    expect(res.status).toBe(200);
    expect(settings.set).toHaveBeenCalledWith('anthropic_model', 'claude-opus-4-8', 'u1');
  });

  test('does not overwrite sensitive value when masked sentinel is sent', async () => {
    const res = await request(makeApp())
      .put('/api/admin/settings')
      .send({ anthropic_api_key: MASKED });
    expect(res.status).toBe(200);
    expect(settings.set).not.toHaveBeenCalledWith('anthropic_api_key', MASKED, expect.anything());
  });

  test('saves sensitive value when a new real value is provided', async () => {
    const res = await request(makeApp())
      .put('/api/admin/settings')
      .send({ anthropic_api_key: 'sk-ant-new-key' });
    expect(res.status).toBe(200);
    expect(settings.set).toHaveBeenCalledWith('anthropic_api_key', 'sk-ant-new-key', 'u1');
  });

  test('ignores unknown keys', async () => {
    const res = await request(makeApp())
      .put('/api/admin/settings')
      .send({ unknown_key: 'value', anthropic_model: 'claude-haiku-4-5-20251001' });
    expect(res.status).toBe(200);
    expect(settings.set).not.toHaveBeenCalledWith('unknown_key', expect.anything(), expect.anything());
    expect(settings.set).toHaveBeenCalledWith('anthropic_model', 'claude-haiku-4-5-20251001', 'u1');
  });

  test('returns 403 for non-admin users', async () => {
    mockUser = { id: 'u2', email: 'user@test.com', role: 'contributor' };
    const res = await request(makeApp())
      .put('/api/admin/settings')
      .send({ anthropic_model: 'claude-opus-4-8' });
    expect(res.status).toBe(403);
    expect(settings.set).not.toHaveBeenCalled();
    mockUser = { id: 'u1', email: 'admin@test.com', role: 'admin' };
  });

  // A GET masks each backup destination's secret_access_key; a naive round-trip PUT
  // would then persist the mask and destroy the real S3 secret. The merge restores it.
  test('restores a masked backup secret from the stored destination (no clobber)', async () => {
    const stored = JSON.stringify([{ id: 'd1', bucket: 'b', secret_access_key: 'REAL-SECRET' }]);
    settings.getOrEnv.mockImplementation(key => Promise.resolve(key === 'backup_destinations' ? stored : null));
    const incoming = JSON.stringify([{ id: 'd1', bucket: 'b', secret_access_key: MASKED }]);
    const res = await request(makeApp()).put('/api/admin/settings').send({ backup_destinations: incoming });
    expect(res.status).toBe(200);
    const call = settings.set.mock.calls.find(c => c[0] === 'backup_destinations');
    expect(call).toBeTruthy();
    expect(JSON.parse(call[1])[0].secret_access_key).toBe('REAL-SECRET');
  });

  test('saves a newly provided backup secret verbatim', async () => {
    const incoming = JSON.stringify([{ id: 'd1', bucket: 'b', secret_access_key: 'NEW-SECRET' }]);
    const res = await request(makeApp()).put('/api/admin/settings').send({ backup_destinations: incoming });
    expect(res.status).toBe(200);
    const call = settings.set.mock.calls.find(c => c[0] === 'backup_destinations');
    expect(JSON.parse(call[1])[0].secret_access_key).toBe('NEW-SECRET');
  });
});

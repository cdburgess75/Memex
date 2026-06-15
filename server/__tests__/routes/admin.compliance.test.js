'use strict';
const request = require('supertest');
const express = require('express');

jest.mock('../../lib/db', () => ({
  query: jest.fn().mockResolvedValue([]),
}));

jest.mock('../../lib/settings', () => ({
  getOrEnv: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue(undefined),
  refresh: jest.fn().mockResolvedValue(undefined),
}));

let mockUser = { id: 'admin-1', email: 'admin@test.com', role: 'admin' };
jest.mock('../../middleware/auth', () => (req, _res, next) => {
  req.user = mockUser;
  next();
});

const settings = require('../../lib/settings');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', require('../../routes/admin'));
  return app;
}

beforeEach(() => {
  mockUser = { id: 'admin-1', email: 'admin@test.com', role: 'admin' };
  settings.getOrEnv.mockResolvedValue(null);
});

describe('admin compliance routes', () => {
  test('GET returns frameworks and update posture for admins', async () => {
    settings.getOrEnv.mockImplementation(key => Promise.resolve(key === 'compliance_soc2_enabled' ? 'true' : null));

    const res = await request(makeApp()).get('/api/admin/compliance');

    expect(res.status).toBe(200);
    expect(res.body.frameworks.some(f => f.id === 'soc2' && f.enabled === true)).toBe(true);
    expect(res.body.updates.app.version).toBeTruthy();
    expect(res.body.disclaimer).toMatch(/do not certify/i);
  });

  test('PUT saves known framework toggles only', async () => {
    const res = await request(makeApp())
      .put('/api/admin/compliance')
      .send({ enabled: { soc2: true, hipaa: false, unknown: true } });

    expect(res.status).toBe(200);
    expect(settings.set).toHaveBeenCalledWith('compliance_soc2_enabled', 'true', 'admin-1');
    expect(settings.set).toHaveBeenCalledWith('compliance_hipaa_enabled', 'false', 'admin-1');
    expect(settings.set).not.toHaveBeenCalledWith('unknown', expect.anything(), expect.anything());
  });

  test('returns 403 for non-admin users', async () => {
    mockUser = { id: 'user-1', email: 'user@test.com', role: 'contributor' };
    const res = await request(makeApp()).get('/api/admin/compliance');
    expect(res.status).toBe(403);
  });
});

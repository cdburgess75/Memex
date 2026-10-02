'use strict';
const request = require('supertest');
const express = require('express');

let mockRole = 'admin';
jest.mock('../../middleware/auth', () => (req, _res, next) => { req.user = { id: 'u1', email: 'a@test.com', role: mockRole }; next(); });
jest.mock('../../lib/editorStatus', () => ({
  status: jest.fn(), switchedOn: jest.fn(), setSwitch: jest.fn().mockResolvedValue(),
}));
jest.mock('../../lib/auditLog', () => ({ append: jest.fn().mockResolvedValue() }));

const editorStatus = require('../../lib/editorStatus');
const auditLog = require('../../lib/auditLog');
const app = express();
app.use(express.json());
app.use('/api/admin/editor', require('../../routes/editor'));

beforeEach(() => {
  mockRole = 'admin';
  editorStatus.status.mockResolvedValue({ enabled: true, running: false, state: 'starting' });
  editorStatus.switchedOn.mockResolvedValue(false);
});

describe('the in-browser editing switch', () => {
  test('an admin reads the state', async () => {
    const res = await request(app).get('/api/admin/editor');
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('starting');
  });

  test.each(['contributor', 'viewer'])('a %s can neither read nor change it', async (r) => {
    mockRole = r;
    expect((await request(app).get('/api/admin/editor')).status).toBe(403);
    expect((await request(app).put('/api/admin/editor').send({ enabled: true })).status).toBe(403);
    expect(editorStatus.setSwitch).not.toHaveBeenCalled();
  });

  test('switching on records the choice, audits it, and returns the new state', async () => {
    const res = await request(app).put('/api/admin/editor').send({ enabled: true });
    expect(res.status).toBe(200);
    expect(editorStatus.setSwitch).toHaveBeenCalledWith(true, 'u1');
    expect(auditLog.append).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'settings_changed', actorEmail: 'a@test.com', detail: 'in-browser editing switched on',
    }));
    expect(res.body.state).toBe('starting');
  });

  test('setting it to what it already is writes no audit line', async () => {
    editorStatus.switchedOn.mockResolvedValue(true);
    await request(app).put('/api/admin/editor').send({ enabled: true });
    expect(auditLog.append).not.toHaveBeenCalled();
  });

  test.each([[{}], [{ enabled: 'true' }], [{ enabled: 1 }]])('rejects a body that is not a plain true/false: %j', async (body) => {
    const res = await request(app).put('/api/admin/editor').send(body);
    expect(res.status).toBe(400);
    expect(editorStatus.setSwitch).not.toHaveBeenCalled();
  });
});

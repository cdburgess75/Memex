'use strict';
// /api/setup/session-length: administrators read and set how long a sign-in lasts, from
// a short list; Keycloak is the source of truth and the choice is noted for the audit trail.

const request = require('supertest');
const express = require('express');

jest.mock('../../lib/settings', () => ({
  ENV_MAP: {},
  get: jest.fn().mockResolvedValue(null),
  getOrEnv: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../lib/email', () => ({ sendMail: jest.fn() }));
jest.mock('../../lib/keycloakAdmin', () => ({
  getSessionLength: jest.fn().mockResolvedValue({ idleSeconds: 1209600, maxSeconds: 2592000 }),
  setSessionLength: jest.fn().mockResolvedValue({ idleSeconds: 36000, maxSeconds: 36000 }),
}));
const settings = require('../../lib/settings');
const kcAdmin = require('../../lib/keycloakAdmin');

let mockUser = { id: 'u1', email: 'admin@test.com', role: 'admin' };
jest.mock('../../middleware/auth', () => (req, _res, next) => { req.user = mockUser; next(); });

const app = express();
app.use(express.json());
app.use('/api/setup', require('../../routes/setup'));

beforeEach(() => { jest.clearAllMocks(); mockUser = { id: 'u1', email: 'admin@test.com', role: 'admin' }; });

test('GET answers in hours, with the choices the screen may offer', async () => {
  const r = await request(app).get('/api/setup/session-length').expect(200);
  expect(r.body).toEqual({ ok: true, hours: 720, idleHours: 336, choices: [10, 24, 168, 336, 720] });
});

test('POST sets Keycloak in seconds and notes the choice as a setting', async () => {
  const r = await request(app).post('/api/setup/session-length').send({ hours: 10 }).expect(200);
  expect(r.body).toEqual({ ok: true, hours: 10 });
  expect(kcAdmin.setSessionLength).toHaveBeenCalledWith(36000);
  expect(settings.set).toHaveBeenCalledWith('login_session_hours', '10', 'u1');
});

test('a length off the list is refused without touching Keycloak', async () => {
  const r = await request(app).post('/api/setup/session-length').send({ hours: 7 }).expect(200);
  expect(r.body.ok).toBe(false);
  expect(r.body.error).toMatch(/Choose one of: 10, 24, 168, 336, 720 hours/);
  expect(kcAdmin.setSessionLength).not.toHaveBeenCalled();
  expect(settings.set).not.toHaveBeenCalled();
});

test('a Keycloak failure comes back as a readable error', async () => {
  kcAdmin.setSessionLength.mockRejectedValueOnce(new Error('Keycloak session-length update failed (502).'));
  const r = await request(app).post('/api/setup/session-length').send({ hours: 24 }).expect(200);
  expect(r.body).toEqual({ ok: false, error: 'Keycloak session-length update failed (502).' });
  expect(settings.set).not.toHaveBeenCalled();
});

test('only administrators', async () => {
  mockUser = { id: 'u2', email: 'pat@test.com', role: 'contributor' };
  await request(app).get('/api/setup/session-length').expect(403);
  await request(app).post('/api/setup/session-length').send({ hours: 10 }).expect(403);
  expect(kcAdmin.setSessionLength).not.toHaveBeenCalled();
});

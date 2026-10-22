'use strict';
// GET /api/admin/health: administrators only; the window is 1 or 7 days; a failing summary is
// a logged 500 like any other.
jest.mock('../../lib/db', () => ({ query: jest.fn(), queryOne: jest.fn() }));
jest.mock('../../lib/settings', () => ({ getOrEnv: jest.fn(), set: jest.fn(), refresh: jest.fn() }));
jest.mock('../../lib/compliance', () => ({}));
jest.mock('../../lib/documentAccess', () => ({}));
jest.mock('../../lib/storage', () => ({}));
jest.mock('../../lib/health', () => ({ summary: jest.fn(), note: jest.fn() }));
let mockUser = { id: 'u1', email: 'admin@test.com', role: 'admin' };
jest.mock('../../middleware/auth', () => (req, _res, next) => { req.user = mockUser; next(); });

const request = require('supertest');
const express = require('express');
const health = require('../../lib/health');

const app = express();
app.use('/api/admin', require('../../routes/admin'));

beforeEach(() => { jest.clearAllMocks(); mockUser = { id: 'u1', email: 'admin@test.com', role: 'admin' }; });

test('answers the summary for the last day by default, or the last 7 days', async () => {
  health.summary.mockResolvedValue({ status: 'ok', reasons: [] });
  const r = await request(app).get('/api/admin/health').expect(200);
  expect(r.body).toEqual({ status: 'ok', reasons: [] });
  expect(health.summary).toHaveBeenLastCalledWith({ days: 1 });
  await request(app).get('/api/admin/health?days=7').expect(200);
  expect(health.summary).toHaveBeenLastCalledWith({ days: 7 });
  await request(app).get('/api/admin/health?days=30').expect(200);
  expect(health.summary).toHaveBeenLastCalledWith({ days: 1 });
});

test('a contributor is refused', async () => {
  mockUser = { id: 'u2', email: 'pat@test.com', role: 'contributor' };
  await request(app).get('/api/admin/health').expect(403);
  expect(health.summary).not.toHaveBeenCalled();
});

test('a failing summary is a plain 500, not a leak', async () => {
  health.summary.mockRejectedValue(new Error('relation "health_events" does not exist'));
  const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
  const r = await request(app).get('/api/admin/health').expect(500);
  expect(r.body).toEqual({ error: 'Internal error' });
  spy.mockRestore();
});

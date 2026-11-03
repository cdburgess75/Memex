'use strict';
// /api/v1/admin/compliance/reports for an integration holding a personal access token:
// admin scope, the same list, and a report by id as the HTML it was.
const request = require('supertest');
const express = require('express');

jest.mock('../../lib/db', () => ({ query: jest.fn().mockResolvedValue([]), queryOne: jest.fn().mockResolvedValue(null) }));
jest.mock('../../lib/settings', () => ({ getOrEnv: jest.fn().mockResolvedValue(null), get: jest.fn().mockResolvedValue(null), set: jest.fn(), refresh: jest.fn(), ENV_MAP: {} }));
jest.mock('../../lib/rateLimiters', () => ({ ...jest.requireActual('../../lib/rateLimiters'), makeRateLimiters: () => ({ tokenLimiter: (_req, _res, next) => next() }) }));
let mockToken = { id: 't1', name: 'ci', scope: 'admin' };
jest.mock('../../middleware/auth', () => (req, _res, next) => { req.user = { id: 'admin-1', email: 'admin@test.com', role: 'admin' }; req.apiToken = mockToken; next(); });

const db = require('../../lib/db');
const app = () => { const a = express(); a.use(express.json()); a.use('/api/v1', require('../../routes/v1')); return a; };

beforeEach(() => { mockToken = { id: 't1', name: 'ci', scope: 'admin' }; db.query.mockResolvedValue([]); db.queryOne.mockResolvedValue(null); });

test('the list, with the schedule', async () => {
  db.query.mockResolvedValue([{ id: 9, framework: 'hipaa', generated_at: new Date('2026-11-01T06:00:00Z'), generated_by: 'schedule', status: 'ready', ready: 1, total: 1 }]);
  const r = await request(app()).get('/api/v1/admin/compliance/reports');
  expect(r.status).toBe(200);
  expect(r.body.reports[0]).toMatchObject({ id: '9', framework: 'hipaa', file_name: 'depot-hipaa-report-2026-11-01.html' });
  expect(r.body.schedule.schedule).toBe('off');
});
test('one report, as the HTML it was', async () => {
  db.queryOne.mockResolvedValue({ id: 9, framework: 'hipaa', generated_at: new Date('2026-11-01T06:00:00Z'), generated_by: 'schedule', status: 'ready', ready: 1, total: 1, html: '<html>kept</html>' });
  const r = await request(app()).get('/api/v1/admin/compliance/reports/9');
  expect(r.status).toBe(200);
  expect(r.headers['content-type']).toMatch(/text\/html/);
  expect(r.text).toBe('<html>kept</html>');
  db.queryOne.mockResolvedValue(null);
  await request(app()).get('/api/v1/admin/compliance/reports/8').expect(404);
});
test('needs admin scope: a write token is refused', async () => {
  mockToken = { id: 't2', name: 'sync', scope: 'write' };
  const r = await request(app()).get('/api/v1/admin/compliance/reports');
  expect(r.status).toBe(403);
  expect(r.body.error).toMatch(/write scope; this needs admin/);
});
test('both are in the API description', () => {
  const { paths } = require('../../lib/openapi');
  expect(paths['/admin/compliance/reports'].get['x-scope']).toBe('admin');
  expect(paths['/admin/compliance/reports/{id}'].get['x-scope']).toBe('admin');
});

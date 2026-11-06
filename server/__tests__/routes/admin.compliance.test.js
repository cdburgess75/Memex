'use strict';
const request = require('supertest');
const express = require('express');

jest.mock('../../lib/db', () => ({
  query: jest.fn().mockResolvedValue([]),
  queryOne: jest.fn().mockResolvedValue(null),
}));

jest.mock('../../lib/settings', () => ({
  getOrEnv: jest.fn().mockResolvedValue(null),
  get: jest.fn().mockResolvedValue(null),
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

  test('GET /compliance/packet.html is a printable attachment named after the firm', async () => {
    // The packet refreshes the live probes first (HTTPS HEAD, npm audit, backup dir);
    // none of that belongs in a route test, and npm audit alone can take seconds.
    jest.spyOn(require('../../lib/compliance'), 'runProbes').mockResolvedValue({});
    settings.getOrEnv.mockImplementation(key => Promise.resolve(
      key === 'compliance_safeguards_enabled' ? 'true' : key === 'brand_name' ? 'Bayou Tax & Books, LLC' : null));
    const res = await request(makeApp()).get('/api/admin/compliance/packet.html');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="bayou-tax-books-llc-safeguards-packet-\d{4}-\d{2}-\d{2}\.html"$/);
    expect(res.text).toContain('Bayou Tax &amp; Books, LLC');
    expect(res.text).toContain('Safeguards Rule checklist');
    expect(res.text).not.toMatch(/<script/i);
  });

  test('GET /compliance/packet.html is admin-only', async () => {
    mockUser = { id: 'user-1', email: 'user@test.com', role: 'contributor' };
    const res = await request(makeApp()).get('/api/admin/compliance/packet.html');
    expect(res.status).toBe(403);
  });
});

// Reports on any basis: a report for any framework, the archive, and the schedule.
describe('compliance reports', () => {
  const db = require('../../lib/db');
  beforeEach(() => {
    jest.spyOn(require('../../lib/compliance'), 'runProbes').mockResolvedValue({});
    settings.getOrEnv.mockImplementation(key => Promise.resolve(
      key === 'compliance_hipaa_enabled' || key === 'compliance_safeguards_enabled' ? 'true' : key === 'brand_name' ? 'Bayou Tax & Books, LLC' : null));
    db.query.mockResolvedValue([]);
    db.queryOne.mockResolvedValue(null);
  });

  test('GET /compliance/report.html?framework=hipaa is an attachment named for the firm and framework', async () => {
    const res = await request(makeApp()).get('/api/admin/compliance/report.html?framework=hipaa');
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="bayou-tax-books-llc-hipaa-report-\d{4}-\d{2}-\d{2}\.html"$/);
    expect(res.text).toContain('Technical safeguards checklist');
    expect(res.text).not.toMatch(/<script/i);
    await request(makeApp()).get('/api/admin/compliance/report.html?framework=nope').expect(404);
  });

  test('POST /compliance/reports keeps one for the framework asked, or one per tracked framework', async () => {
    db.queryOne.mockImplementation(async (sql, params) => /INSERT INTO compliance_reports/.test(sql)
      ? { id: 9, framework: params[0], generated_at: new Date(params[1]), generated_by: params[2], status: params[3], ready: params[4], total: params[5] }
      : null);
    const one = await request(makeApp()).post('/api/admin/compliance/reports').send({ framework: 'hipaa' });
    expect(one.status).toBe(201);
    expect(one.body.reports).toHaveLength(1);
    expect(one.body.reports[0]).toMatchObject({ id: '9', framework: 'hipaa', generated_by: 'admin@test.com', file_name: expect.stringMatching(/^bayou-tax-books-llc-hipaa-report-/) });
    expect(one.body.reports[0].html).toBeUndefined();
    const all = await request(makeApp()).post('/api/admin/compliance/reports').send({});
    expect(all.body.reports.map(r => r.framework)).toEqual(['safeguards', 'hipaa']);
    await request(makeApp()).post('/api/admin/compliance/reports').send({ framework: 'nope' }).expect(404);
  });

  test('GET /compliance/reports lists them with the schedule; GET /:id.html downloads one', async () => {
    db.query.mockResolvedValue([{ id: 9, framework: 'hipaa', generated_at: new Date('2026-11-01T06:00:00Z'), generated_by: 'schedule', status: 'ready', ready: 1, total: 1 }]);
    const list = await request(makeApp()).get('/api/admin/compliance/reports');
    expect(list.status).toBe(200);
    expect(list.body.reports[0]).toMatchObject({ id: '9', generated_by: 'schedule', file_name: 'bayou-tax-books-llc-hipaa-report-2026-11-01.html' });
    expect(list.body.schedule).toMatchObject({ schedule: 'off', nextRun: null });
    db.queryOne.mockResolvedValue({ id: 9, framework: 'hipaa', generated_at: new Date('2026-11-01T06:00:00Z'), generated_by: 'schedule', status: 'ready', ready: 1, total: 1, html: '<html>kept</html>' });
    const one = await request(makeApp()).get('/api/admin/compliance/reports/9.html');
    expect(one.status).toBe(200);
    expect(one.headers['content-disposition']).toBe('attachment; filename="bayou-tax-books-llc-hipaa-report-2026-11-01.html"');
    expect(one.text).toBe('<html>kept</html>');
    db.queryOne.mockResolvedValue(null);
    await request(makeApp()).get('/api/admin/compliance/reports/8.html').expect(404);
  });

  test('GET /compliance carries the past reports and the schedule for the window', async () => {
    const res = await request(makeApp()).get('/api/admin/compliance');
    expect(res.body.reports).toEqual([]);
    expect(res.body.reportSchedule).toMatchObject({ schedule: 'off' });
  });

  test('PUT /compliance/reports/schedule saves both settings, tidies the addresses, and refuses a made-up cadence', async () => {
    const reports = require('../../lib/complianceReports');
    const arm = jest.spyOn(reports, 'reschedule').mockResolvedValue(null);
    const res = await request(makeApp()).put('/api/admin/compliance/reports/schedule').send({ schedule: 'quarterly', email: 'Owner@Firm.com; it@provider.com, junk' });
    expect(res.status).toBe(200);
    expect(settings.set).toHaveBeenCalledWith('compliance_report_schedule', 'quarterly', 'admin-1');
    expect(settings.set).toHaveBeenCalledWith('compliance_report_email', 'owner@firm.com, it@provider.com', 'admin-1');
    expect(arm).toHaveBeenCalled();
    await request(makeApp()).put('/api/admin/compliance/reports/schedule').send({ schedule: 'weekly' }).expect(400);
    arm.mockRestore();
  });

  test('all of it is admin-only', async () => {
    mockUser = { id: 'user-1', email: 'user@test.com', role: 'contributor' };
    for (const [m, p] of [['get', '/api/admin/compliance/report.html?framework=hipaa'], ['get', '/api/admin/compliance/reports'], ['post', '/api/admin/compliance/reports'], ['get', '/api/admin/compliance/reports/1.html'], ['put', '/api/admin/compliance/reports/schedule']]) {
      expect((await request(makeApp())[m](p)).status).toBe(403);
    }
  });
});

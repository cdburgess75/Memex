'use strict';
// GET /api/license adds the seat count to the evaluated status; POST /update-run
// stays inert unless the caller is an admin, the license entitles updates, and the
// operator configured a command.
const request = require('supertest');
const express = require('express');

jest.mock('../../middleware/auth', () => (req, _res, next) => { req.user = { id: 'u1', role: req.headers['x-role'] || 'admin' }; next(); });
jest.mock('../../lib/db', () => ({ query: jest.fn(), queryOne: jest.fn() }));
jest.mock('../../lib/license', () => ({ status: jest.fn() }));
jest.mock('../../lib/licenseEnforce', () => ({ prime: jest.fn(), enforcing: () => true, seatsUsed: async () => { try { const row = await require('../../lib/db').queryOne('SELECT COUNT(*)::int AS n FROM user_roles WHERE disabled_at IS NULL'); return row && Number.isInteger(row.n) ? row.n : null; } catch { return null; } } }));
const db = require('../../lib/db');
const license = require('../../lib/license');
const router = require('../../routes/license');

const app = express();
app.use(express.json());
app.use('/api/license', router);

const accepted = (over = {}) => ({ configured: true, present: true, valid: true, accepted: true, state: 'ok', updatesEntitled: true, reason: 'ok', seats: { licensed: 25, policy: 'soft', used: null }, ...over });

describe('GET /api/license', () => {
  test('fills in the seats used from the accounts that are not switched off', async () => {
    license.status.mockResolvedValue(accepted());
    db.queryOne.mockResolvedValue({ n: 12 });
    const r = await request(app).get('/api/license');
    expect(r.status).toBe(200);
    expect(r.body.seats).toEqual({ licensed: 25, policy: 'soft', used: 12, overCap: false });
    expect(db.queryOne.mock.calls[0][0]).toMatch(/FROM user_roles WHERE disabled_at IS NULL/);
  });

  test('flags an over-cap workspace without changing anything else', async () => {
    license.status.mockResolvedValue(accepted());
    db.queryOne.mockResolvedValue({ n: 30 });
    const r = await request(app).get('/api/license');
    expect(r.body.seats).toMatchObject({ used: 30, overCap: true });
    expect(r.body.state).toBe('ok');
  });

  test('an unlimited license is never over cap', async () => {
    license.status.mockResolvedValue(accepted({ seats: { licensed: null, policy: 'soft', used: null } }));
    db.queryOne.mockResolvedValue({ n: 300 });
    expect((await request(app).get('/api/license')).body.seats).toMatchObject({ licensed: null, used: 300, overCap: false });
  });

  test('a failed count leaves used null', async () => {
    license.status.mockResolvedValue(accepted());
    db.queryOne.mockRejectedValue(new Error('db down'));
    expect((await request(app).get('/api/license')).body.seats).toMatchObject({ used: null, overCap: false });
  });

  test('a status without seats (the error shape) passes through', async () => {
    license.status.mockResolvedValue({ configured: false, accepted: false, state: 'unlicensed', reason: 'error:boom' });
    const r = await request(app).get('/api/license');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ configured: false, accepted: false, state: 'unlicensed', reason: 'error:boom', enforcing: true });
    expect(db.queryOne).not.toHaveBeenCalled();
  });

  test('any signed-in person may read it', async () => {
    license.status.mockResolvedValue(accepted());
    db.queryOne.mockResolvedValue({ n: 1 });
    expect((await request(app).get('/api/license').set('x-role', 'viewer')).status).toBe(200);
  });
});

describe('POST /api/license/update-run', () => {
  const saved = process.env.MEMEX_UPDATE_COMMAND;
  beforeEach(() => { delete process.env.MEMEX_UPDATE_COMMAND; });
  afterAll(() => { if (saved === undefined) delete process.env.MEMEX_UPDATE_COMMAND; else process.env.MEMEX_UPDATE_COMMAND = saved; });

  test('needs an administrator', async () => {
    license.status.mockResolvedValue(accepted());
    expect((await request(app).post('/api/license/update-run').set('x-role', 'contributor')).status).toBe(403);
    expect(license.status).not.toHaveBeenCalled();
  });

  test('refuses when updates are not entitled, naming the reason', async () => {
    license.status.mockResolvedValue(accepted({ state: 'lapsed', updatesEntitled: false, reason: 'lapsed' }));
    const r = await request(app).post('/api/license/update-run');
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ ok: false, reason: 'lapsed' });
  });

  test('is inert without an operator-configured command', async () => {
    license.status.mockResolvedValue(accepted());
    const r = await request(app).post('/api/license/update-run');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: false, reason: 'no_updater_configured' });
  });
});

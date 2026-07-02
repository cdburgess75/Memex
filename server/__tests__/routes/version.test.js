'use strict';
const request = require('supertest');
const express = require('express');

jest.mock('../../middleware/auth', () => (req, _res, next) => { req.user = { id: 'u1', role: 'admin' }; next(); });

const version = require('../../routes/version');
const { parseV, cmpV, computeUpdate } = version;

describe('version parsing helpers', () => {
  test('parseV accepts vYYYY.MM.DD.NNN and the bare form', () => {
    expect(parseV('v2026.06.30.001')).toEqual([2026, 6, 30, 1]);
    expect(parseV('2026.06.30.001')).toEqual([2026, 6, 30, 1]);
    expect(parseV('  v2026.7.1.10  ')).toEqual([2026, 7, 1, 10]);
  });

  test('parseV rejects anything that is not a 4-part numeric version', () => {
    for (const bad of ['dev', '', 'v1.2.3', '2026-06-30', 'vX.Y.Z.W', null, undefined]) {
      expect(parseV(bad)).toBeNull();
    }
  });

  test('cmpV orders by each numeric segment, most significant first', () => {
    expect(cmpV([2026, 6, 30, 1], [2026, 6, 30, 1])).toBe(0);
    expect(cmpV([2026, 6, 30, 2], [2026, 6, 30, 1])).toBeGreaterThan(0);
    expect(cmpV([2026, 6, 29, 9], [2026, 6, 30, 1])).toBeLessThan(0);
    expect(cmpV([2027, 1, 1, 0], [2026, 12, 31, 9])).toBeGreaterThan(0);
  });
});

describe('computeUpdate', () => {
  const tags = [
    { name: 'v2026.06.30.001' },
    { name: 'v2026.07.01.001' },
    { name: 'v2026.06.15.002' },
    { name: 'not-a-version' }, // ignored
    { name: null },            // ignored
  ];

  test('latest is the newest parseable tag', () => {
    expect(computeUpdate('v2026.06.30.001', tags).latest).toBe('v2026.07.01.001');
  });

  test('behind counts only strictly-newer releases', () => {
    expect(computeUpdate('v2026.06.30.001', tags).behind).toBe(1); // only v2026.07.01.001 is newer
    expect(computeUpdate('v2026.06.15.002', tags).behind).toBe(2); // 06.30.001 and 07.01.001
  });

  test('an up-to-date version is 0 releases behind', () => {
    expect(computeUpdate('v2026.07.01.001', tags).behind).toBe(0);
  });

  test('an unparseable running version yields behind=null but still finds latest', () => {
    const r = computeUpdate('dev', tags);
    expect(r.behind).toBeNull();
    expect(r.latest).toBe('v2026.07.01.001');
  });

  test('degenerate inputs', () => {
    expect(computeUpdate('v2026.06.30.001', [])).toEqual({ latest: null, behind: 0 });
    expect(computeUpdate('dev', [])).toEqual({ latest: null, behind: null });
    expect(computeUpdate('v2026.06.30.001', 'not-an-array')).toEqual({ latest: null, behind: 0 });
  });
});

describe('GET /api/version/check', () => {
  const app = express();
  app.use('/api/version', version);
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  test('maps GitHub tags into current/latest/behind', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => [{ name: 'v9999.99.99.999' }] });
    const res = await request(app).get('/api/version/check');
    expect(res.status).toBe(200);
    expect(typeof res.body.current).toBe('string');
    expect(res.body.latest).toBe('v9999.99.99.999');
    expect(res.body).toHaveProperty('behind');
    expect(res.body).toHaveProperty('checkedAt');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

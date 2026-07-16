'use strict';
jest.mock('../../lib/db', () => ({ queryOne: jest.fn(), query: jest.fn() }));
jest.mock('../../lib/settings', () => ({ getOrEnv: jest.fn() }));

const db = require('../../lib/db');
const { CHECKS } = require('../../lib/compliance');

beforeEach(() => jest.clearAllMocks());

// Regression: access_control used to report ready:true unconditionally, overstating
// the compliance posture. It must now reflect real role configuration.
describe('access_control readiness', () => {
  test('ready when role assignments and at least one admin exist', async () => {
    db.queryOne.mockImplementation((sql) => {
      if (/role = 'admin'/.test(sql)) return Promise.resolve({ n: 1 });
      if (/FROM user_roles/.test(sql)) return Promise.resolve({ n: 3 });
      return Promise.resolve(null);
    });
    const r = await CHECKS.access_control();
    expect(r.ready).toBe(true);
    expect(r.evidence).toMatch(/3 role assignment/);
    expect(r.evidence).toMatch(/MFA\/SSO/); // gaps stated, not hidden
  });

  test('not ready when no roles are configured', async () => {
    db.queryOne.mockResolvedValue({ n: 0 });
    const r = await CHECKS.access_control();
    expect(r.ready).toBe(false);
  });

  test('not ready when roles exist but there is no admin', async () => {
    db.queryOne.mockImplementation((sql) =>
      /role = 'admin'/.test(sql) ? Promise.resolve({ n: 0 }) : Promise.resolve({ n: 2 }));
    const r = await CHECKS.access_control();
    expect(r.ready).toBe(false);
  });
});

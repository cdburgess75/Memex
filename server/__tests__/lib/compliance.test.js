'use strict';
jest.mock('../../lib/db', () => ({ queryOne: jest.fn(), query: jest.fn() }));
jest.mock('../../lib/settings', () => ({ getOrEnv: jest.fn(), get: jest.fn() }));

const db = require('../../lib/db');
const settings = require('../../lib/settings');
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

// audit_logging must reflect the tamper-evident hash chain, not the editable feed.
describe('audit_logging readiness', () => {
  test('ready only when the hash chain has entries', async () => {
    db.queryOne.mockImplementation((sql) =>
      /document_events/.test(sql) ? Promise.resolve({ n: 5 }) : Promise.resolve({ n: 9 }));
    const r = await CHECKS.audit_logging();
    expect(r.ready).toBe(true);
    expect(r.evidence).toMatch(/hash-chained/i);
  });

  test('not ready when only the plain activity feed has events', async () => {
    db.queryOne.mockImplementation((sql) =>
      /document_events/.test(sql) ? Promise.resolve({ n: 0 }) : Promise.resolve({ n: 9 }));
    const r = await CHECKS.audit_logging();
    expect(r.ready).toBe(false);
    expect(r.evidence).toMatch(/not evidenced as tamper-evident/i);
  });
});

// backup_restore must require an actual successful backup, not just a script on disk.
describe('backup_restore readiness', () => {
  test('ready only when a successful backup run is recorded', async () => {
    settings.get.mockImplementation((k) =>
      Promise.resolve(k === 'backup_last_status' ? JSON.stringify({ ok: true }) : '1700000000000'));
    const r = await CHECKS.backup_restore(); // scripts/ really contains backup scripts
    expect(r.ready).toBe(true);
  });

  test('not ready when scripts exist but no successful backup has run', async () => {
    settings.get.mockResolvedValue(null);
    const r = await CHECKS.backup_restore();
    expect(r.ready).toBe(false);
    expect(r.evidence).toMatch(/no successful backup run is recorded/i);
  });
});

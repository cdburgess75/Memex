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
    expect(r.evidence).toMatch(/3 people have a role/);
    expect(r.evidence).toMatch(/MFA/); // the gap is named, not hidden
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
    expect(r.evidence).toMatch(/5 entries in the hash-chained record/i);
  });

  test('not ready when only the plain activity feed has events', async () => {
    db.queryOne.mockImplementation((sql) =>
      /document_events/.test(sql) ? Promise.resolve({ n: 0 }) : Promise.resolve({ n: 9 }));
    const r = await CHECKS.audit_logging();
    expect(r.ready).toBe(false);
    expect(r.evidence).toMatch(/hash-chained record has none yet/i);
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
    expect(r.evidence).toMatch(/No backup has completed yet/i);
  });
});

// ---- FTC Safeguards Rule profile (the CPA / tax-firm profile) ----
const { FRAMEWORKS, CONTROL_CATALOG } = require('../../lib/compliance');

describe('safeguards framework', () => {
  test('exists, is listed first, and every control it names is in the catalog', () => {
    expect(FRAMEWORKS[0].id).toBe('safeguards');
    for (const id of FRAMEWORKS[0].controls) expect(CONTROL_CATALOG[id]).toBeDefined();
  });

  test('every catalog entry has the copy the simple view and the packet print', () => {
    for (const [id, c] of Object.entries(CONTROL_CATALOG)) {
      expect(typeof c.label).toBe('string');
      expect(typeof c.evidence).toBe('string');
      expect(typeof c.gap).toBe('string');
      // auto controls must have a check; manual ones must not
      if (c.manual) expect(require('../../lib/compliance').CHECKS[id]).toBeUndefined();
      else expect(typeof require('../../lib/compliance').CHECKS[id]).toBe('function');
    }
    // each Safeguards control names the clause it answers to
    for (const id of FRAMEWORKS[0].controls) expect(CONTROL_CATALOG[id].why).toMatch(/314\.4/);
  });
});

describe('mfa readiness', () => {
  test('ready when the setup switch recorded mfa_required', async () => {
    settings.get.mockResolvedValue('true');
    settings.getOrEnv.mockResolvedValue(null);
    const r = await CHECKS.mfa();
    expect(r.ready).toBe(true);
  });

  test('not ready without it; Microsoft-only sign-in says to confirm the tenant', async () => {
    settings.get.mockResolvedValue(null);
    settings.getOrEnv.mockImplementation(k => Promise.resolve(k === 'login_ms365_enabled' ? 'true' : null));
    const r = await CHECKS.mfa();
    expect(r.ready).toBe(false);
    expect(r.evidence).toMatch(/Microsoft tenant/);
    settings.getOrEnv.mockResolvedValue(null);
    expect((await CHECKS.mfa()).evidence).toMatch(/stolen password/);
  });
});

describe('link_governance readiness', () => {
  test('ready only with a cap set and no live link that never expires', async () => {
    settings.getOrEnv.mockImplementation(k => Promise.resolve(k === 'share_link_max_days' ? '30' : null));
    db.queryOne.mockResolvedValue({ n: 0 });
    expect((await CHECKS.link_governance()).ready).toBe(true);
    db.queryOne.mockResolvedValue({ n: 2 });
    const r = await CHECKS.link_governance();
    expect(r.ready).toBe(false);
    expect(r.evidence).toMatch(/2 live links never expire/);
  });

  test('not ready when no cap is set', async () => {
    settings.getOrEnv.mockResolvedValue(null);
    db.queryOne.mockResolvedValue({ n: 0 });
    const r = await CHECKS.link_governance();
    expect(r.ready).toBe(false);
    expect(r.evidence).toMatch(/No limit is set/);
  });
});

describe('retention readiness (disposal on a schedule)', () => {
  test('unset uses the sweeper default of 30 days and is ready', async () => {
    settings.getOrEnv.mockResolvedValue(null);
    expect((await CHECKS.retention()).ready).toBe(true);
  });
  test('0 (never purge) and over 90 days are not ready', async () => {
    settings.getOrEnv.mockResolvedValue('0');
    expect((await CHECKS.retention()).ready).toBe(false);
    settings.getOrEnv.mockResolvedValue('400');
    expect((await CHECKS.retention()).ready).toBe(false);
    settings.getOrEnv.mockResolvedValue('45');
    expect((await CHECKS.retention()).ready).toBe(true);
  });
});

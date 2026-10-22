'use strict';
// lib/health: the journal never fails a request, the verdict says what to act on in plain
// words, and the summary is one answer a daily watch can read.
jest.mock('../../lib/db', () => ({ query: jest.fn(), queryOne: jest.fn() }));
jest.mock('../../lib/storage', () => ({ isLocalProvider: jest.fn().mockResolvedValue(false), localBase: jest.fn() }));
jest.mock('../../lib/license', () => ({ status: jest.fn().mockResolvedValue({ state: 'ok', readOnly: false }) }));
jest.mock('../../lib/keycloakAdmin', () => ({ ensureLoginEvents: jest.fn().mockResolvedValue({ changed: false }), loginEvents: jest.fn().mockResolvedValue([]) }));
const db = require('../../lib/db');
const kcAdmin = require('../../lib/keycloakAdmin');
const health = require('../../lib/health');

const GiB = 2 ** 30;
const ENV = { ...process.env };
afterEach(() => { process.env = { ...ENV }; jest.clearAllMocks(); });

describe('note', () => {
  test('writes one journal row, trimmed, without the query string', async () => {
    db.query.mockResolvedValue([]);
    await health.note({ kind: 'error', status: 500, method: 'POST', path: '/api/files/upload-stream?replace=1', message: 'x'.repeat(600), actorEmail: 'pat@example.com' });
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO health_events/);
    expect(params).toEqual(['error', 500, 'POST', '/api/files/upload-stream', 'x'.repeat(500), 'pat@example.com']);
  });
  test('anything that is not a refusal is an error, and a failing journal is swallowed', async () => {
    db.query.mockRejectedValueOnce(new Error('no table'));
    await expect(health.note({ kind: 'weird', status: 502 })).resolves.toBeUndefined();
    db.query.mockResolvedValue([]);
    await health.note({ kind: 'refusal', status: 415, path: '/api/files/upload' });
    expect(db.query.mock.calls.at(-1)[1][0]).toBe('refusal');
  });
});

describe('verdict', () => {
  test('nothing wrong is ok with no reasons', () => {
    expect(health.verdict({})).toEqual({ status: 'ok', reasons: [] });
  });
  test('one failed request is worth a look; ten are a problem', () => {
    expect(health.verdict({ errors: 1 })).toEqual({ status: 'attention', reasons: ['1 request could not be finished.'] });
    expect(health.verdict({ errors: 10 }).status).toBe('problem');
  });
  test('disk: under 15% free is worth a look, under 5% or 2 GB is a problem', () => {
    expect(health.verdict({ disk: { free_bytes: 50 * GiB, total_bytes: 400 * GiB } })).toEqual({ status: 'attention', reasons: ['50 GB is free on the file store, 13% of it.'] });
    expect(health.verdict({ disk: { free_bytes: 1.5 * GiB, total_bytes: 400 * GiB } })).toEqual({ status: 'problem', reasons: ['Only 1.5 GB is free on the file store.'] });
    expect(health.verdict({ disk: { free_bytes: 200 * GiB, total_bytes: 400 * GiB } }).status).toBe('ok');
  });
  test('failed sign-ins: twenty are worth a look, and the worst address is named when it did ten', () => {
    expect(health.verdict({ signins: { failed: 19 } }).status).toBe('ok');
    expect(health.verdict({ signins: { failed: 24, worst_address: ['203.0.113.9', 15] } })).toEqual({ status: 'attention', reasons: ['24 failed sign-ins, 15 of them from 203.0.113.9.'] });
    expect(health.verdict({ signins: { unavailable: 'down' } }).status).toBe('ok');
  });
  test('the license: lapsed is a problem, expiring or missing is worth a look; the worst level wins', () => {
    expect(health.verdict({ license: { state: 'lapsed' } }).status).toBe('problem');
    expect(health.verdict({ license: { state: 'ok', read_only: true } }).reasons).toEqual(['The license has lapsed.']);
    expect(health.verdict({ license: { state: 'expiring' } }).status).toBe('attention');
    expect(health.verdict({ license: { state: 'unlicensed' } }).status).toBe('attention');
    const v = health.verdict({ errors: 2, refusals: 12, license: { state: 'lapsed' } });
    expect(v.status).toBe('problem');
    expect(v.reasons).toHaveLength(3);
  });
});

describe('summary', () => {
  const answers = () => {
    db.queryOne.mockImplementation(async (sql) => {
      if (/FROM health_events WHERE kind = 'error'/.test(sql)) return { n: 1 };
      if (/count\(DISTINCT actor_email\)/.test(sql)) return { n: 4 };
      if (/FROM documents/.test(sql)) return { n: 45, bytes: '199700000000' };
      if (/FROM user_roles/.test(sql)) return { n: 6, active: 5 };
      if (/pg_database_size/.test(sql)) return { bytes: '412000000' };
      return null;
    });
    db.query.mockImplementation(async (sql) => {
      if (/kind = 'refusal' AND at >= \$1 GROUP BY status/.test(sql)) return [{ status: 413, n: 2 }, { status: 429, n: 1 }];
      if (/kind = 'error' AND at >= \$1 ORDER BY/.test(sql)) return [{ at: '2026-10-21T10:00:00Z', status: 500, method: 'GET', path: '/api/files/search', message: 'timeout', actor_email: 'pat@example.com' }];
      if (/kind = 'refusal' AND at >= \$1 ORDER BY/.test(sql)) return [];
      if (/FROM document_events WHERE created_at >= \$1 GROUP BY event_type/.test(sql)) return [{ type: 'uploaded', n: 30 }, { type: 'downloaded', n: 20 }];
      return [];
    });
  };
  test('one answer: counts, recent rows, what people did, sizes, no disk when files are not local, no sign-ins without Keycloak credentials', async () => {
    answers();
    delete process.env.KEYCLOAK_ADMIN_PASSWORD;
    const s = await health.summary({ days: 1 });
    expect(s.status).toBe('attention');
    expect(s.reasons).toEqual(['1 request could not be finished.']);
    expect(s.period_days).toBe(1);
    expect(s.errors).toEqual({ count: 1, recent: [expect.objectContaining({ path: '/api/files/search' })] });
    expect(s.refusals).toEqual({ count: 3, by_status: { 413: 2, 429: 1 }, recent: [] });
    expect(s.activity).toEqual({ actions: 50, by_type: [{ type: 'uploaded', n: 30 }, { type: 'downloaded', n: 20 }], active_people: 4 });
    expect(s.stored).toEqual({ files: 45, bytes: 199700000000, people: 6, people_active: 5, database_bytes: 412000000 });
    expect(s.disk).toBeNull();
    expect(s.signins).toBeNull();
    expect(s.license).toEqual({ state: 'ok', read_only: false, reason: null });
    expect(typeof s.uptime_seconds).toBe('number');
    // The window is the parameter, passed as a time, and anything but 7 means 1.
    const since = db.queryOne.mock.calls[0][1][0];
    expect(Date.now() - new Date(since).getTime()).toBeGreaterThan(86000e3);
    expect((await health.summary({ days: 3 })).period_days).toBe(1);
  });
  test('with Keycloak credentials, sign-ins come from its records: counts, the worst address, the failures listed', async () => {
    answers();
    process.env.KEYCLOAK_ADMIN_PASSWORD = 'pw';
    const now = Date.now();
    kcAdmin.loginEvents.mockResolvedValue([
      { at: new Date(now - 1000).toISOString(), type: 'LOGIN_ERROR', username: 'sam', ip: '203.0.113.9', error: 'invalid_user_credentials' },
      { at: new Date(now - 2000).toISOString(), type: 'LOGIN_ERROR', username: 'sam', ip: '203.0.113.9', error: 'invalid_user_credentials' },
      { at: new Date(now - 3000).toISOString(), type: 'LOGIN', username: 'pat', ip: '198.51.100.4' },
      { at: new Date(now - 10 * 86400e3).toISOString(), type: 'LOGIN_ERROR', username: 'old', ip: '1.2.3.4' },   // outside the window
    ]);
    const s = await health.summary({ days: 1 });
    expect(kcAdmin.ensureLoginEvents).toHaveBeenCalled();
    expect(s.signins).toMatchObject({ signins: 1, failed: 2, worst_address: ['203.0.113.9', 2] });
    expect(s.signins.recent_failed).toHaveLength(2);
  });
  test('when Keycloak will not answer, the rest of the summary still comes, and says so', async () => {
    answers();
    process.env.KEYCLOAK_ADMIN_PASSWORD = 'pw';
    kcAdmin.loginEvents.mockRejectedValue(new Error('Keycloak events read failed (502).'));
    const s = await health.summary({ days: 7 });
    expect(s.signins).toEqual({ unavailable: 'Keycloak events read failed (502).' });
    expect(s.period_days).toBe(7);
    expect(s.errors.count).toBe(1);
  });
});

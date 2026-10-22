'use strict';
// Sign-in records in Keycloak: turned on only when needed, never narrowing a realm that
// records everything, and read back as plain rows.

jest.mock('../../lib/settings', () => ({ get: jest.fn(), set: jest.fn(), getOrEnv: jest.fn() }));
const kcAdmin = require('../../lib/keycloakAdmin');

const ENV = { ...process.env };
let calls;
function mockFetch(responses) {
  let i = 0;
  global.fetch = jest.fn(async (url, opts) => {
    calls.push({ url: String(url), method: opts?.method || 'GET', body: opts?.body });
    const r = responses[Math.min(i, responses.length - 1)]; i += 1;
    return { ok: r.status < 400, status: r.status, json: async () => r.json ?? {} };
  });
}
const tokenResponse = { status: 200, json: { access_token: 'admtok' } };

beforeEach(() => {
  calls = [];
  process.env.KEYCLOAK_INTERNAL_URL = 'http://keycloak:8080';
  process.env.KEYCLOAK_ADMIN_USER = 'admin';
  process.env.KEYCLOAK_ADMIN_PASSWORD = 'pw';
  delete process.env.KEYCLOAK_REALM;
});
afterAll(() => { process.env = ENV; });

describe('ensureLoginEvents', () => {
  test('a realm with events off is switched on for LOGIN and LOGIN_ERROR, kept 30 days', async () => {
    mockFetch([tokenResponse, { status: 200, json: { eventsEnabled: false, enabledEventTypes: [], eventsExpiration: 0, adminEventsEnabled: false } }, { status: 204 }]);
    await expect(kcAdmin.ensureLoginEvents()).resolves.toEqual({ changed: true });
    expect(calls[2]).toMatchObject({ method: 'PUT', url: 'http://keycloak:8080/admin/realms/memex/events/config' });
    expect(JSON.parse(calls[2].body)).toEqual({ eventsEnabled: true, enabledEventTypes: [], eventsExpiration: 2592000, adminEventsEnabled: false });
  });
  test('a realm that records some types keeps them and gains the two', async () => {
    mockFetch([tokenResponse, { status: 200, json: { eventsEnabled: true, enabledEventTypes: ['LOGOUT'], eventsExpiration: 5184000 } }, { status: 204 }]);
    await expect(kcAdmin.ensureLoginEvents()).resolves.toEqual({ changed: true });
    expect(JSON.parse(calls[2].body)).toEqual({ eventsEnabled: true, enabledEventTypes: ['LOGOUT', 'LOGIN', 'LOGIN_ERROR'], eventsExpiration: 5184000 });
  });
  test('a realm already recording everything long enough is left alone', async () => {
    mockFetch([tokenResponse, { status: 200, json: { eventsEnabled: true, enabledEventTypes: [], eventsExpiration: 2592000 } }]);
    await expect(kcAdmin.ensureLoginEvents()).resolves.toEqual({ changed: false });
    expect(calls).toHaveLength(2);
  });
});

describe('loginEvents', () => {
  test('asks for each type since the day, and answers plain rows newest first', async () => {
    const t = Date.UTC(2026, 9, 21, 9, 0, 0);
    mockFetch([tokenResponse,
      { status: 200, json: [{ time: t - 60000, type: 'LOGIN', ipAddress: '198.51.100.4', details: { username: 'pat@example.com', identity_provider: 'microsoft' } }] },
      { status: 200, json: [{ time: t, type: 'LOGIN_ERROR', error: 'invalid_user_credentials', ipAddress: '203.0.113.9', details: { username: 'sam' } }] },
    ]);
    const rows = await kcAdmin.loginEvents({ since: new Date(t - 86400e3) });
    expect(calls[1].url).toBe('http://keycloak:8080/admin/realms/memex/events?type=LOGIN&max=200&first=0&dateFrom=2026-10-20');
    expect(calls[2].url).toContain('type=LOGIN_ERROR');
    expect(rows).toEqual([
      { at: new Date(t).toISOString(), type: 'LOGIN_ERROR', username: 'sam', ip: '203.0.113.9', provider: null, error: 'invalid_user_credentials' },
      { at: new Date(t - 60000).toISOString(), type: 'LOGIN', username: 'pat@example.com', ip: '198.51.100.4', provider: 'microsoft', error: null },
    ]);
  });
  test('a refusal from Keycloak is an error with its status', async () => {
    mockFetch([tokenResponse, { status: 403 }]);
    await expect(kcAdmin.loginEvents()).rejects.toThrow(/events read failed \(403\)/);
  });
});

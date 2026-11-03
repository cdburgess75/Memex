'use strict';
// Second step at sign-in, per person: the four words, read the way setLocalTotpRequirement
// decides whom to stamp, and cached so the list, the packet and the check share one read.
jest.mock('../../lib/settings', () => ({ get: jest.fn(), set: jest.fn(), getOrEnv: jest.fn() }));
const kcAdmin = require('../../lib/keycloakAdmin');

const ENV = { ...process.env };
let calls;
// Answers by URL, so the order of Keycloak calls does not matter to the test.
function mockFetch(routes) {
  global.fetch = jest.fn(async (url, opts) => {
    const u = String(url);
    calls.push({ url: u, method: opts?.method || 'GET' });
    if (u.endsWith('/protocol/openid-connect/token')) return { ok: true, status: 200, json: async () => ({ access_token: 'admtok' }) };
    const hit = Object.entries(routes).find(([k]) => u.includes(k));
    if (!hit) return { ok: false, status: 404, json: async () => ({}) };
    const r = typeof hit[1] === 'function' ? hit[1]() : hit[1];
    return { ok: r.status < 400, status: r.status, json: async () => r.json ?? {} };
  });
}
const USERS = [
  { id: 'u-ad', username: 'pat', email: 'pat@acme.test', federationLink: 'ldap-component', requiredActions: ['CONFIGURE_TOTP'] },
  { id: 'u-ms', username: 'sam@acme.test', email: 'sam@acme.test', requiredActions: [] },
  { id: 'u-otp', username: 'kim', email: 'kim@acme.test', requiredActions: [] },
  { id: 'u-pend', username: 'lee', email: 'lee@acme.test', requiredActions: ['CONFIGURE_TOTP'] },
  { id: 'u-none', username: 'ali', email: 'ali@acme.test', requiredActions: [] },
];
const ROUTES = {
  '/users?max=100&first=0': { status: 200, json: USERS },
  '/users/u-ms/federated-identity': { status: 200, json: [{ identityProvider: 'microsoft', userId: 'x' }] },
  '/users/u-otp/federated-identity': { status: 200, json: [] },
  '/users/u-pend/federated-identity': { status: 200, json: [] },
  '/users/u-none/federated-identity': { status: 200, json: [] },
  '/users/u-otp/credentials': { status: 200, json: [{ type: 'password' }, { type: 'otp' }] },
  '/users/u-pend/credentials': { status: 200, json: [{ type: 'password' }] },
  '/users/u-none/credentials': { status: 200, json: [{ type: 'password' }] },
};

beforeEach(() => {
  calls = [];
  kcAdmin._resetMfaCache();
  process.env.KEYCLOAK_INTERNAL_URL = 'http://keycloak:8080';
  process.env.KEYCLOAK_ADMIN_USER = 'admin';
  process.env.KEYCLOAK_ADMIN_PASSWORD = 'pw';
  delete process.env.KEYCLOAK_REALM;
});
afterAll(() => { process.env = ENV; });

describe('mfaStatusByUser', () => {
  test('each person gets one of the four words, keyed by address in lower case', async () => {
    mockFetch(ROUTES);
    const r = await kcAdmin.mfaStatusByUser();
    expect(r.byEmail).toEqual({
      'pat@acme.test': { state: 'federated', provider: 'ldap' },
      'sam@acme.test': { state: 'federated', provider: 'microsoft' },
      'kim@acme.test': { state: 'enrolled', provider: null },
      'lee@acme.test': { state: 'pending', provider: null },
      'ali@acme.test': { state: 'none', provider: null },
    });
    expect(r.users.map(u => u.state)).toEqual(['federated', 'federated', 'enrolled', 'pending', 'none']);
    // a federated account is never asked about credentials: the second step is not Keycloak's
    expect(calls.some(c => c.url.includes('/users/u-ad/credentials') || c.url.includes('/users/u-ms/credentials'))).toBe(false);
    // an AD account carries federationLink, so it is not even asked about brokered identities
    expect(calls.some(c => c.url.includes('/users/u-ad/federated-identity'))).toBe(false);
  });
  test('an authenticator wins over a stale enrollment prompt', async () => {
    mockFetch({ ...ROUTES, '/users?max=100&first=0': { status: 200, json: [{ id: 'u-otp', email: 'kim@acme.test', requiredActions: ['CONFIGURE_TOTP'] }] } });
    expect((await kcAdmin.mfaStatusByUser()).byEmail['kim@acme.test'].state).toBe('enrolled');
  });
  test('the answer is kept ten minutes, and asked for fresh on request', async () => {
    mockFetch(ROUTES);
    await kcAdmin.mfaStatusByUser();
    const n = calls.length;
    await kcAdmin.mfaStatusByUser();
    expect(calls.length).toBe(n);
    await kcAdmin.mfaStatusByUser({ fresh: true });
    expect(calls.length).toBeGreaterThan(n);
  });
  test('Keycloak unreachable is an error, not an empty list', async () => {
    global.fetch = jest.fn(async () => { throw new Error('connect ECONNREFUSED'); });
    await expect(kcAdmin.mfaStatusByUser()).rejects.toThrow(/ECONNREFUSED/);
    mockFetch({ '/users?max=100&first=0': { status: 403 } });
    await expect(kcAdmin.mfaStatusByUser()).rejects.toThrow(/user list failed \(403\)/);
  });
  test('no admin credentials on this server is an error too', async () => {
    delete process.env.KEYCLOAK_ADMIN_PASSWORD;
    await expect(kcAdmin.mfaStatusByUser()).rejects.toThrow(/admin credentials/);
  });
});

describe('realmEvents', () => {
  test('pages each type until Keycloak runs out, oldest first, with the user id for a sign-out', async () => {
    const t = Date.UTC(2026, 10, 3, 9, 0, 0);
    mockFetch({
      '/events?type=LOGIN&max=2&first=0': { status: 200, json: [{ time: t, type: 'LOGIN', details: { username: 'pat@acme.test' }, ipAddress: '10.0.0.5' }, { time: t + 1000, type: 'LOGIN', details: { username: 'sam@acme.test', identity_provider: 'microsoft' } }] },
      '/events?type=LOGIN&max=2&first=2': { status: 200, json: [{ time: t + 2000, type: 'LOGIN', details: { username: 'kim' } }] },
      '/events?type=LOGIN_ERROR&max=2&first=0': { status: 200, json: [{ time: t - 5000, type: 'LOGIN_ERROR', error: 'invalid_user_credentials', ipAddress: '203.0.113.9', details: { username: 'sam' } }] },
      '/events?type=LOGOUT&max=2&first=0': { status: 200, json: [{ time: t + 3000, type: 'LOGOUT', userId: 'u-ms' }] },
    });
    const rows = await kcAdmin.realmEvents({ since: new Date(t - 86400e3), pageSize: 2 });
    expect(calls.filter(c => c.url.includes('/events?')).map(c => c.url.slice(c.url.indexOf('type=')))).toEqual([
      'type=LOGIN&max=2&first=0&dateFrom=2026-11-02', 'type=LOGIN&max=2&first=2&dateFrom=2026-11-02',
      'type=LOGIN_ERROR&max=2&first=0&dateFrom=2026-11-02', 'type=LOGOUT&max=2&first=0&dateFrom=2026-11-02']);
    expect(rows.map(r => [r.type, r.time - t, r.username, r.userId])).toEqual([
      ['LOGIN_ERROR', -5000, 'sam', null], ['LOGIN', 0, 'pat@acme.test', null], ['LOGIN', 1000, 'sam@acme.test', null], ['LOGIN', 2000, 'kim', null], ['LOGOUT', 3000, null, 'u-ms']]);
    expect(rows[2].provider).toBe('microsoft');
    expect(rows[0].error).toBe('invalid_user_credentials');
  });
  test('ensureLoginEvents keeps sign-outs too', async () => {
    mockFetch({ '/events/config': { status: 200, json: { eventsEnabled: true, enabledEventTypes: ['LOGIN', 'LOGIN_ERROR'], eventsExpiration: 2592000 } } });
    // a PUT lands on the same URL; the mock answers 200 to it as well
    await expect(kcAdmin.ensureLoginEvents()).resolves.toEqual({ changed: true });
    expect(kcAdmin.SIGNIN_EVENT_TYPES).toEqual(['LOGIN', 'LOGIN_ERROR', 'LOGOUT']);
  });
  test('userEmail answers the address, or null for an account that is gone', async () => {
    mockFetch({ '/users/u-ms': { status: 200, json: { id: 'u-ms', email: 'sam@acme.test' } } });
    expect(await kcAdmin.userEmail('u-ms')).toBe('sam@acme.test');
    expect(await kcAdmin.userEmail('gone')).toBeNull();
  });
});

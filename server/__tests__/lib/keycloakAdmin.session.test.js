'use strict';
// How long a sign-in lasts: read from the realm, written to the realm with idle and
// maximum the same, and never shorter than ten minutes.

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

test('getSessionLength reads the realm', async () => {
  mockFetch([tokenResponse, { status: 200, json: { realm: 'memex', ssoSessionIdleTimeout: 1209600, ssoSessionMaxLifespan: 2592000 } }]);
  await expect(kcAdmin.getSessionLength()).resolves.toEqual({ idleSeconds: 1209600, maxSeconds: 2592000 });
  expect(calls[1]).toMatchObject({ method: 'GET', url: 'http://keycloak:8080/admin/realms/memex' });
});

test('setSessionLength writes idle and maximum as one length, to the realm only', async () => {
  mockFetch([tokenResponse, { status: 204 }]);
  await expect(kcAdmin.setSessionLength(36000)).resolves.toEqual({ idleSeconds: 36000, maxSeconds: 36000 });
  expect(calls[1].method).toBe('PUT');
  expect(calls[1].url).toBe('http://keycloak:8080/admin/realms/memex');
  expect(JSON.parse(calls[1].body)).toEqual({ realm: 'memex', ssoSessionIdleTimeout: 36000, ssoSessionMaxLifespan: 36000 });
});

test('a length under ten minutes, or not a number, is refused before Keycloak is asked', async () => {
  mockFetch([tokenResponse]);
  await expect(kcAdmin.setSessionLength(300)).rejects.toThrow(/ten minutes/);
  await expect(kcAdmin.setSessionLength('soon')).rejects.toThrow(/ten minutes/);
  expect(calls).toHaveLength(0);
});

test('a Keycloak refusal is reported with its status', async () => {
  mockFetch([tokenResponse, { status: 403 }]);
  await expect(kcAdmin.setSessionLength(36000)).rejects.toThrow(/session-length update failed \(403\)/);
});

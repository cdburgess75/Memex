'use strict';
// The sign-in record poller: what Keycloak says becomes chained events with plain types,
// the cursor moves, nothing is copied twice across restarts, and when Keycloak keeps no
// events the poller says so instead of reporting a clean record.
const mockStore = new Map();
jest.mock('../../lib/settings', () => ({
  get: async (k) => (mockStore.has(k) ? mockStore.get(k) : null),
  getOrEnv: async (k) => (mockStore.has(k) ? mockStore.get(k) : null),
  set: async (k, v) => { if (v === null || v === undefined || v === '') mockStore.delete(k); else mockStore.set(k, String(v)); },
}));
jest.mock('../../lib/db', () => ({ query: jest.fn(), queryOne: jest.fn() }));
jest.mock('../../lib/auditLog', () => ({ append: jest.fn() }));
jest.mock('../../lib/keycloakAdmin', () => ({ eventsConfig: jest.fn(), realmEvents: jest.fn(), userEmail: jest.fn() }));

const db = require('../../lib/db');
const auditLog = require('../../lib/auditLog');
const kcAdmin = require('../../lib/keycloakAdmin');
const poller = require('../../lib/signInEvents');

const T = Date.UTC(2026, 10, 3, 9, 0, 0);
const iso = (ms) => new Date(ms).toISOString();
const EVENTS = [
  { time: T, type: 'LOGIN', username: 'pat@acme.test', ip: '10.0.0.5', provider: null, error: null, userId: 'u1' },
  { time: T + 1000, type: 'LOGIN_ERROR', username: 'sam', ip: '203.0.113.9', provider: null, error: 'invalid_user_credentials', userId: null },
  { time: T + 2000, type: 'LOGIN', username: 'sam@acme.test', ip: '10.0.0.6', provider: 'microsoft', error: null, userId: 'u2' },
  { time: T + 3000, type: 'LOGOUT', username: null, ip: '10.0.0.6', provider: null, error: null, userId: 'u2' },
];

beforeEach(() => {
  mockStore.clear();
  poller._reset();
  db.query.mockResolvedValue([]);
  auditLog.append.mockResolvedValue({ chain_seq: 1 });
  kcAdmin.eventsConfig.mockResolvedValue({ enabled: true, types: [], keepSeconds: 2592000 });
  kcAdmin.realmEvents.mockResolvedValue(EVENTS);
  kcAdmin.userEmail.mockResolvedValue('sam@acme.test');
});

test('each Keycloak event becomes one chained event with no document, a plain type, and the who/where/why in its detail', async () => {
  const r = await poller.poll({ now: T + 60000 });
  expect(r).toMatchObject({ ok: true, appended: 4, eventsEnabled: true, error: null });
  expect(auditLog.append.mock.calls.map(c => c[0])).toEqual([
    { documentId: null, eventType: 'signed_in', actorEmail: 'pat@acme.test', detail: `${iso(T)} · from 10.0.0.5` },
    { documentId: null, eventType: 'sign_in_failed', actorEmail: 'sam', detail: `${iso(T + 1000)} · from 203.0.113.9 · reason invalid user credentials` },
    { documentId: null, eventType: 'signed_in', actorEmail: 'sam@acme.test', detail: `${iso(T + 2000)} · from 10.0.0.6 · via microsoft` },
    { documentId: null, eventType: 'signed_out', actorEmail: 'sam@acme.test', detail: `${iso(T + 3000)} · from 10.0.0.6` },
  ]);
  // a sign-out carries no username, so the account is looked up once
  expect(kcAdmin.userEmail).toHaveBeenCalledTimes(1);
  expect(kcAdmin.userEmail).toHaveBeenCalledWith('u2');
  // the cursor is the newest event and what was seen at that millisecond
  expect(JSON.parse(mockStore.get('signin_events_cursor'))).toEqual({ time: T + 3000, seen: [`signed_out|${T + 3000}|sam@acme.test`] });
  expect(JSON.parse(mockStore.get('signin_events_last'))).toMatchObject({ ok: true, appended: 4 });
});

test('the first pass on a fresh install asks for yesterday, not all of history; later passes ask from the cursor', async () => {
  await poller.poll({ now: T + 60000 });
  expect(kcAdmin.realmEvents.mock.calls[0][0].since.getTime()).toBe(T + 60000 - 24 * 3600e3);
  kcAdmin.realmEvents.mockResolvedValue([]);
  await poller.poll({ now: T + 120000 });
  expect(kcAdmin.realmEvents.mock.calls[1][0].since.getTime()).toBe(T + 3000);
});

test('what the cursor already saw is not copied again, even when Keycloak repeats the day', async () => {
  await poller.poll({ now: T + 60000 });
  auditLog.append.mockClear();
  // next pass: the same four come back (Keycloak filters by day), plus one new sign-in
  kcAdmin.realmEvents.mockResolvedValue([...EVENTS, { time: T + 9000, type: 'LOGIN', username: 'kim@acme.test', ip: null, provider: null, error: null, userId: 'u3' }]);
  const r = await poller.poll({ now: T + 400000 });
  expect(r.appended).toBe(1);
  expect(auditLog.append.mock.calls[0][0]).toMatchObject({ eventType: 'signed_in', actorEmail: 'kim@acme.test', detail: iso(T + 9000) });
});

test('after a restart with no cursor, what is already in the chain is read back and skipped', async () => {
  // the chain already holds the first two (from a pass whose cursor write was lost)
  db.query.mockImplementation(async (sql) => /FROM document_events/.test(sql)
    ? [{ event_type: 'signed_in', actor_email: 'pat@acme.test', detail: `${iso(T)} · from 10.0.0.5` },
       { event_type: 'sign_in_failed', actor_email: 'sam', detail: `${iso(T + 1000)} · from 203.0.113.9 · reason invalid user credentials` }]
    : []);
  const r = await poller.poll({ now: T + 60000 });
  expect(r.appended).toBe(2);
  expect(auditLog.append.mock.calls.map(c => c[0].eventType)).toEqual(['signed_in', 'signed_out']);
});

test('two events at the same millisecond for different people are both kept', async () => {
  kcAdmin.realmEvents.mockResolvedValue([
    { time: T, type: 'LOGIN', username: 'a@acme.test', ip: null, provider: null, error: null, userId: null },
    { time: T, type: 'LOGIN', username: 'b@acme.test', ip: null, provider: null, error: null, userId: null },
  ]);
  expect((await poller.poll({ now: T + 1 })).appended).toBe(2);
  expect(JSON.parse(mockStore.get('signin_events_cursor')).seen).toEqual([`signed_in|${T}|a@acme.test`, `signed_in|${T}|b@acme.test`]);
});

test('when Keycloak keeps no events the pass says so and copies nothing', async () => {
  kcAdmin.eventsConfig.mockResolvedValue({ enabled: false, types: [], keepSeconds: 0 });
  const r = await poller.poll({ now: T });
  expect(r).toMatchObject({ ok: false, eventsEnabled: false });
  expect(r.error).toMatch(/not keeping sign-in records/);
  expect(auditLog.append).not.toHaveBeenCalled();
  expect((await poller.status()).last.eventsEnabled).toBe(false);
});

test('a realm that records only other types counts as off; Keycloak down is an error, not a throw', async () => {
  kcAdmin.eventsConfig.mockResolvedValue({ enabled: true, types: ['LOGOUT'], keepSeconds: 0 });
  expect((await poller.poll({ now: T })).eventsEnabled).toBe(false);
  kcAdmin.eventsConfig.mockRejectedValue(new Error('connect ECONNREFUSED'));
  const r = await poller.poll({ now: T });
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/ECONNREFUSED/);
});

test('the setting turns it off; it is on when the setting is absent', async () => {
  expect(await poller.enabled()).toBe(true);
  mockStore.set('signin_events_enabled', 'false');
  expect(await poller.enabled()).toBe(false);
  const r = await poller.poll({ now: T });
  expect(r.error).toBe('off');
  expect(kcAdmin.realmEvents).not.toHaveBeenCalled();
  expect((await poller.status()).enabled).toBe(false);
});

test('status after a restart comes from what the last pass wrote down', async () => {
  mockStore.set('signin_events_last', JSON.stringify({ at: iso(T), ok: true, appended: 3, eventsEnabled: true, error: null }));
  expect(await poller.status()).toEqual({ enabled: true, last: { at: iso(T), ok: true, appended: 3, eventsEnabled: true, error: null } });
});

test('the types and their plain labels', () => {
  expect(poller.TYPES).toEqual({ LOGIN: 'signed_in', LOGIN_ERROR: 'sign_in_failed', LOGOUT: 'signed_out' });
  expect(poller.LABELS).toEqual({ signed_in: 'Signed in', sign_in_failed: 'Sign-in failed', signed_out: 'Signed out' });
  // the CSV download and the admin feed use the same words
  const { LABELS } = require('../../lib/activityLabels');
  for (const [k, v] of Object.entries(poller.LABELS)) expect(LABELS[k]).toBe(v);
  expect(LABELS.access_reviewed).toBe('Access list reviewed');
});

test('start arms a timer only when this server holds Keycloak admin credentials', () => {
  const ENV = process.env.KEYCLOAK_ADMIN_PASSWORD;
  delete process.env.KEYCLOAK_ADMIN_PASSWORD;
  expect(poller.start()).toBe(false);
  process.env.KEYCLOAK_ADMIN_PASSWORD = 'pw';
  expect(poller.start()).toBe(true);
  poller.stop();
  if (ENV === undefined) delete process.env.KEYCLOAK_ADMIN_PASSWORD; else process.env.KEYCLOAK_ADMIN_PASSWORD = ENV;
});

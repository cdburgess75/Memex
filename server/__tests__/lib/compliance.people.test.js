'use strict';
// The people controls: a second step per person (mfa), proof the access list was reviewed
// (access_review), and sign-ins in the record (signin_events). Appended to the catalog;
// the frameworks list them in the sibling catalog change.
jest.mock('../../lib/db', () => ({ queryOne: jest.fn(), query: jest.fn() }));
jest.mock('../../lib/settings', () => ({ getOrEnv: jest.fn(), get: jest.fn() }));
jest.mock('../../lib/keycloakAdmin', () => ({ mfaStatusByUser: jest.fn() }));
jest.mock('../../lib/signInEvents', () => ({ status: jest.fn(), EVENT_TYPES: ['signed_in', 'sign_in_failed', 'signed_out'] }));

const db = require('../../lib/db');
const settings = require('../../lib/settings');
const kcAdmin = require('../../lib/keycloakAdmin');
const poller = require('../../lib/signInEvents');
const { CHECKS, CONTROL_CATALOG } = require('../../lib/compliance');

const person = (state, provider = null) => ({ state, provider });
beforeEach(() => {
  jest.clearAllMocks();
  settings.get.mockResolvedValue(null);
  settings.getOrEnv.mockResolvedValue(null);
  db.query.mockResolvedValue([]);
  db.queryOne.mockResolvedValue(null);
});

describe('the catalog', () => {
  test('the two new controls are the last entries, with the clauses they answer to and a row action', () => {
    const ids = Object.keys(CONTROL_CATALOG);
    expect(ids.slice(-4, -2)).toEqual(['access_review', 'signin_events']);   // retention_policy and legal_hold follow
    expect(CONTROL_CATALOG.access_review.why).toMatch(/314\.4\(c\)\(1\).*164\.308\(a\)\(4\).*CC6\.2/);
    expect(CONTROL_CATALOG.access_review.action).toEqual({ label: 'Record that this list was reviewed', api: '/admin/access-review/signoff' });
    expect(CONTROL_CATALOG.signin_events.why).toMatch(/164\.312\(b\).*CC7\.2/);
    expect(Object.keys(CHECKS).slice(-4, -2)).toEqual(['access_review', 'signin_events']);
  });
});

describe('mfa, per person', () => {
  const users = (...states) => kcAdmin.mfaStatusByUser.mockResolvedValue({ users: states.map(s => (Array.isArray(s) ? person(...s) : person(s))) });
  test('required and everyone enrolled or federated: green, with the counts', async () => {
    settings.get.mockResolvedValue('true');
    users('enrolled', 'enrolled', ['federated', 'microsoft'], ['federated', 'ldap']);
    const r = await CHECKS.mfa();
    expect(r.ready).toBe(true);
    expect(r.evidence).toContain('2 of 4 people enrolled, 0 pending, 1 through Microsoft 365, 1 through Active Directory.');
  });
  test('required but someone local has none or is still pending: not green, and it says how many', async () => {
    settings.get.mockResolvedValue('true');
    users('enrolled', 'pending', ['federated', 'microsoft']);
    let r = await CHECKS.mfa();
    expect(r.ready).toBe(false);
    expect(r.evidence).toMatch(/1 person has not set one up yet\. 1 of 3 people enrolled, 1 pending, 1 through Microsoft 365\./);
    users('none', 'pending');
    r = await CHECKS.mfa();
    expect(r.ready).toBe(false);
    expect(r.evidence).toMatch(/2 people have not set one up yet/);
  });
  test('not required: never green, even when everyone happens to be enrolled', async () => {
    users('enrolled');
    const r = await CHECKS.mfa();
    expect(r.ready).toBe(false);
    expect(r.evidence).toMatch(/stolen password/);
    expect(r.evidence).toContain('1 of 1 person enrolled');
  });
  test('everyone through Microsoft 365 and nothing local: the tenant is asked to be confirmed', async () => {
    users(['federated', 'microsoft'], ['federated', 'microsoft']);
    const r = await CHECKS.mfa();
    expect(r.ready).toBe(false);
    expect(r.evidence).toMatch(/Sign-in is through Microsoft 365.*confirm it below/);
  });
  test('Keycloak unreachable: the switch alone decides, and the evidence says the count is missing', async () => {
    kcAdmin.mfaStatusByUser.mockRejectedValue(new Error('down'));
    settings.get.mockResolvedValue('true');
    let r = await CHECKS.mfa();
    expect(r.ready).toBe(true);
    expect(r.evidence).toMatch(/could not be counted/);
    settings.get.mockResolvedValue(null);
    r = await CHECKS.mfa();
    expect(r.ready).toBe(false);
  });
});

describe('access_review', () => {
  const day = 86400e3;
  test('no sign-off yet: a gap', async () => {
    const r = await CHECKS.access_review();
    expect(r).toEqual({ ready: false, evidence: 'No review has been recorded yet.' });
  });
  test('a sign-off within 92 days: green, naming the date, the reviewer and the note', async () => {
    db.queryOne.mockResolvedValue({ reviewed_at: new Date(Date.now() - 40 * day).toISOString(), reviewed_by_email: 'dave@x.com', user_count: 6, note: 'Removed a leaver' });
    const r = await CHECKS.access_review();
    expect(r.ready).toBe(true);
    expect(r.evidence).toMatch(/^Last reviewed \w+ \d+, \d{4} by dave@x\.com \(6 people on the list\) · Removed a leaver\.$/);
  });
  test('older than a quarter: not green, and it says how old', async () => {
    db.queryOne.mockResolvedValue({ reviewed_at: new Date(Date.now() - 100 * day).toISOString(), reviewed_by_email: 'dave@x.com', user_count: 1, note: null });
    const r = await CHECKS.access_review();
    expect(r.ready).toBe(false);
    expect(r.evidence).toMatch(/Last reviewed .* by dave@x\.com \(1 person on the list\)\. That is 100 days ago — more than a quarter\./);
  });
  test('the table missing on an old database is a gap, not a crash', async () => {
    db.queryOne.mockRejectedValue(new Error('relation "access_reviews" does not exist'));
    expect((await CHECKS.access_review()).ready).toBe(false);
  });
});

describe('signin_events', () => {
  const counts = () => db.query.mockResolvedValue([{ event_type: 'signed_in', n: 40 }, { event_type: 'sign_in_failed', n: 3 }]);
  test('on and copying: green, with the last 30 days counted', async () => {
    counts();
    poller.status.mockResolvedValue({ enabled: true, last: { at: '2026-11-03T10:00:00.000Z', ok: true, appended: 2, eventsEnabled: true, error: null } });
    const r = await CHECKS.signin_events();
    expect(r.ready).toBe(true);
    expect(r.evidence).toMatch(/every five minutes; last read .*\. In the last 30 days: 40 sign-ins, 3 failed, 0 sign-outs\.$/);
  });
  test('switched off: a gap that names the setting', async () => {
    poller.status.mockResolvedValue({ enabled: false, last: null });
    const r = await CHECKS.signin_events();
    expect(r.ready).toBe(false);
    expect(r.evidence).toMatch(/signin_events_enabled/);
  });
  test('Keycloak keeping no events: a gap that says where to turn them on, not a clean record', async () => {
    counts();
    poller.status.mockResolvedValue({ enabled: true, last: { at: 'x', ok: false, appended: 0, eventsEnabled: false, error: 'off' } });
    const r = await CHECKS.signin_events();
    expect(r.ready).toBe(false);
    expect(r.evidence).toMatch(/Keycloak is not keeping sign-in records.*Realm settings › Events/);
  });
  test('not read yet after start, or the last read failed: not green, with the reason', async () => {
    poller.status.mockResolvedValue({ enabled: true, last: null });
    expect((await CHECKS.signin_events()).evidence).toMatch(/not been read from Keycloak yet/);
    poller.status.mockResolvedValue({ enabled: true, last: { at: 'x', ok: false, eventsEnabled: true, error: 'connect ECONNREFUSED' } });
    const r = await CHECKS.signin_events();
    expect(r.ready).toBe(false);
    expect(r.evidence).toMatch(/last read from Keycloak failed: connect ECONNREFUSED/);
  });
});

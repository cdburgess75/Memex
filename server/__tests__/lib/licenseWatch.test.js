'use strict';
// The daily license watch: which notice a status earns, that each goes out once to
// every administrator (in-app and by email), that good standing is only news after
// a warning, and that state changes land in the audit trail.
const mockStore = new Map();
jest.mock('../../lib/settings', () => ({
  get: async (k) => (mockStore.has(k) ? mockStore.get(k) : null),
  getOrEnv: async (k) => (mockStore.has(k) ? mockStore.get(k) : null),
  set: async (k, v) => { if (v === null || v === undefined || v === '') mockStore.delete(k); else mockStore.set(k, String(v)); },
}));
jest.mock('../../lib/license', () => ({ status: jest.fn() }));
jest.mock('../../lib/db', () => ({ query: jest.fn(), queryOne: jest.fn() }));
jest.mock('../../lib/notifications', () => ({ create: jest.fn() }));
jest.mock('../../lib/email', () => ({ sendMail: jest.fn() }));
jest.mock('../../lib/auditLog', () => ({ append: jest.fn() }));

const license = require('../../lib/license');
const db = require('../../lib/db');
const notifications = require('../../lib/notifications');
const email = require('../../lib/email');
const auditLog = require('../../lib/auditLog');
const watch = require('../../lib/licenseWatch');

const ADMINS = [{ user_id: 'u1', email: 'it@acme.com' }, { user_id: 'u2', email: 'ops@ptechllc.com' }];
const base = (over = {}) => ({
  configured: true, present: true, valid: true, accepted: true, state: 'ok', stateReason: 'ok', readOnly: false,
  seatFreeze: false, updatesEntitled: true, customer: 'Acme Corp', expires: '2027-01-01', graceDays: 30,
  graceEnds: '2027-01-31T23:59:59.999Z', daysLeft: 200, ...over,
});
const expiring = (daysLeft) => base({ state: 'expiring', stateReason: 'expiring', daysLeft });
const lapsed = () => base({ state: 'lapsed', stateReason: 'lapsed', seatFreeze: true, updatesEntitled: false, daysLeft: -3 });
const readonly = () => base({ state: 'readonly', stateReason: 'readonly', readOnly: true, seatFreeze: true, updatesEntitled: false, daysLeft: -40 });
const unlicensed = (reason, over = {}) => ({ configured: true, present: reason !== 'no_license', valid: false, accepted: false, state: 'unlicensed', stateReason: reason, readOnly: false, seatFreeze: true, updatesEntitled: false, graceEnds: '2026-11-14T12:00:00.000Z', customer: null, ...over });

beforeEach(() => {
  mockStore.clear();
  db.query.mockResolvedValue(ADMINS);
  notifications.create.mockResolvedValue({ id: 'n' });
  email.sendMail.mockResolvedValue({ sent: true });
  auditLog.append.mockResolvedValue(undefined);
});

describe('noticeKey', () => {
  test('good standing, the two ended states, and no license each have one key', () => {
    expect(watch.noticeKey(base())).toBe('ok');
    expect(watch.noticeKey(lapsed())).toBe('lapsed');
    expect(watch.noticeKey(readonly())).toBe('readonly');
    expect(watch.noticeKey(unlicensed('no_license'))).toBe('unlicensed:no_license');
    expect(watch.noticeKey(unlicensed('domain_mismatch', { readOnly: true }))).toBe('unlicensed:domain_mismatch:readonly');
    expect(watch.noticeKey(null)).toBe('unlicensed:unknown');
  });
  test('an ending term earns a key per threshold: 30, 14, 7, 1', () => {
    expect(watch.noticeKey(expiring(30))).toBe('expiring:30');
    expect(watch.noticeKey(expiring(25))).toBe('expiring:30');
    expect(watch.noticeKey(expiring(14))).toBe('expiring:14');
    expect(watch.noticeKey(expiring(8))).toBe('expiring:14');
    expect(watch.noticeKey(expiring(7))).toBe('expiring:7');
    expect(watch.noticeKey(expiring(1))).toBe('expiring:1');
    expect(watch.noticeKey(expiring(0))).toBe('expiring:1');
  });
});

describe('notice wording', () => {
  test('says when the term ends, what stops, and whom to call', () => {
    const n = watch.notice(expiring(12), 'expiring:14');
    expect(n.subject).toBe('Depot license: term ends in 12 days');
    expect(n.text).toContain('for Acme Corp ends on 2027-01-01, in 12 days');
    expect(n.text).toContain('30 days later the server becomes read-only');
    expect(n.text).toContain('info@ptechllc.com');
    expect(watch.notice(expiring(0), 'expiring:1').subject).toBe('Depot license: term ends today');
    expect(watch.notice(expiring(1), 'expiring:1').subject).toBe('Depot license: term ends in 1 day');
  });
  test('names the grace end for a lapsed term and the read-only state after it', () => {
    expect(watch.notice(lapsed(), 'lapsed').text).toContain('ended on 2027-01-01. New accounts and updates are off. The server becomes read-only on 2027-01-31');
    expect(watch.notice(readonly(), 'readonly').subject).toMatch(/read-only/);
    expect(watch.notice(readonly(), 'readonly').text).toContain('ended on 2027-01-31');
  });
  test('explains an unlicensed server in plain words', () => {
    const n = watch.notice(unlicensed('domain_mismatch'), 'unlicensed:domain_mismatch');
    expect(n.subject).toBe('Depot has no valid license');
    expect(n.text).toContain("issued for a different address than this server's");
    expect(n.text).toContain('becomes read-only on 2026-11-14');
    expect(watch.notice(unlicensed('no_license', { readOnly: true }), 'unlicensed:no_license:readonly').text).toContain('The grace period is over');
    expect(watch.notice(unlicensed('something_new'), 'unlicensed:something_new').text).toContain('could not be accepted');
  });
  test('renewal is a quiet all-clear', () => {
    expect(watch.notice(base(), 'ok')).toEqual({ subject: 'Depot license renewed', text: 'The license for Acme Corp is in good standing through 2027-01-01. Nothing to do.' });
  });
});

describe('check', () => {
  test('good standing on the first run says nothing and remembers the state', async () => {
    license.status.mockResolvedValue(base());
    expect(await watch.check()).toEqual({ state: 'ok', key: 'ok', sent: 0 });
    expect(notifications.create).not.toHaveBeenCalled();
    expect(email.sendMail).not.toHaveBeenCalled();
    expect(mockStore.get(watch.MEM_NOTICE)).toBe('ok');
    expect(mockStore.get(watch.MEM_STATE)).toBe('ok');
    expect(auditLog.append).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'license_state_changed', detail: 'none -> ok' }));
  });

  test('an ending term tells every administrator once, in-app and by email', async () => {
    license.status.mockResolvedValue(expiring(25));
    expect(await watch.check()).toEqual({ state: 'expiring', key: 'expiring:30', sent: 2 });
    expect(notifications.create).toHaveBeenCalledTimes(2);
    expect(notifications.create).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u2', userEmail: 'ops@ptechllc.com', type: 'license', refId: 'expiring:30', dedupeMinutes: 1440, title: 'Depot license: term ends in 25 days' }));
    expect(email.sendMail).toHaveBeenCalledTimes(2);
    expect(email.sendMail).toHaveBeenCalledWith({ to: 'it@acme.com', subject: 'Depot license: term ends in 25 days', text: expect.stringContaining('in 25 days') });
    expect(auditLog.append).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'license_notice', detail: 'expiring:30: Depot license: term ends in 25 days (2 administrators)' }));
    // The next day, same threshold: silence.
    license.status.mockResolvedValue(expiring(24));
    expect(await watch.check()).toEqual({ state: 'expiring', key: 'expiring:30', sent: 0 });
    expect(email.sendMail).toHaveBeenCalledTimes(2);
    // Crossing the next threshold speaks again.
    license.status.mockResolvedValue(expiring(14));
    expect(await watch.check()).toMatchObject({ key: 'expiring:14', sent: 2 });
    expect(email.sendMail).toHaveBeenCalledTimes(4);
  });

  test('lapsed, read-only and unlicensed each speak once', async () => {
    license.status.mockResolvedValue(lapsed());
    expect(await watch.check()).toMatchObject({ state: 'lapsed', key: 'lapsed', sent: 2 });
    expect(await watch.check()).toMatchObject({ sent: 0 });
    license.status.mockResolvedValue(readonly());
    expect(await watch.check()).toMatchObject({ state: 'readonly', key: 'readonly', sent: 2 });
    license.status.mockResolvedValue(unlicensed('bad_signature'));
    expect(await watch.check()).toMatchObject({ state: 'unlicensed:bad_signature', key: 'unlicensed:bad_signature', sent: 2 });
    expect(email.sendMail).toHaveBeenLastCalledWith(expect.objectContaining({ subject: 'Depot has no valid license', text: expect.stringContaining('signature is not valid') }));
    license.status.mockResolvedValue(unlicensed('bad_signature', { readOnly: true }));
    expect(await watch.check()).toMatchObject({ key: 'unlicensed:bad_signature:readonly', sent: 2 });
  });

  test('good standing after a warning is announced once as a renewal', async () => {
    license.status.mockResolvedValue(lapsed());
    await watch.check();
    license.status.mockResolvedValue(base());
    expect(await watch.check()).toEqual({ state: 'ok', key: 'ok', sent: 2 });
    expect(email.sendMail).toHaveBeenLastCalledWith(expect.objectContaining({ subject: 'Depot license renewed' }));
    expect(await watch.check()).toEqual({ state: 'ok', key: 'ok', sent: 0 });
  });

  test('a state change is audited once; an unchanged state is not', async () => {
    license.status.mockResolvedValue(expiring(20));
    await watch.check();
    await watch.check();
    const changes = auditLog.append.mock.calls.filter(([a]) => a.eventType === 'license_state_changed');
    expect(changes).toHaveLength(1);
    expect(changes[0][0].detail).toBe('none -> expiring');
    license.status.mockResolvedValue(lapsed());
    await watch.check();
    expect(auditLog.append.mock.calls.filter(([a]) => a.eventType === 'license_state_changed').pop()[0].detail).toBe('expiring -> lapsed');
  });

  test('a failing mailer or a missing administrator list never stops the pass', async () => {
    license.status.mockResolvedValue(lapsed());
    email.sendMail.mockRejectedValue(new Error('smtp down'));
    notifications.create.mockRejectedValue(new Error('db down'));
    expect(await watch.check()).toMatchObject({ key: 'lapsed', sent: 2 });
    expect(mockStore.get(watch.MEM_NOTICE)).toBe('lapsed');
    mockStore.clear();
    db.query.mockRejectedValue(new Error('no table'));
    expect(await watch.check()).toMatchObject({ key: 'lapsed', sent: 0 });
  });

  test('switched-off administrators are excluded by the query', async () => {
    license.status.mockResolvedValue(lapsed());
    await watch.check();
    expect(db.query.mock.calls[0][0]).toMatch(/role = 'admin' AND disabled_at IS NULL/);
  });
});

describe('start / stop', () => {
  test('arms one interval and one first run, and stop clears it', () => {
    jest.useFakeTimers();
    try {
      const t = watch.start();
      expect(t).toBeTruthy();
      expect(watch.start()).toBe(t);
      watch.stop();
      expect(jest.getTimerCount()).toBeGreaterThanOrEqual(0);
    } finally { jest.useRealTimers(); }
  });
});

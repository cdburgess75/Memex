'use strict';
// What the license means for what the server allows (lib/licenseEnforce): the cached
// answer, read-only, features, and whether one more account may be made.
jest.mock('../../lib/license', () => ({ status: jest.fn() }));
jest.mock('../../lib/db', () => ({ query: jest.fn(), queryOne: jest.fn() }));
jest.mock('../../lib/notifications', () => ({ create: jest.fn() }));
jest.mock('../../lib/auditLog', () => ({ append: jest.fn() }));

const license = require('../../lib/license');
const db = require('../../lib/db');
const notifications = require('../../lib/notifications');
const auditLog = require('../../lib/auditLog');
const enforce = require('../../lib/licenseEnforce');

const ok = (over = {}) => ({ configured: true, present: true, valid: true, accepted: true, state: 'ok', readOnly: false, seatFreeze: false, features: ['updates', 'editor', 'api'], seats: { licensed: null, policy: 'soft', used: null }, storageGb: null, ...over });
const ADMINS = [{ user_id: 'a1', email: 'it@acme.com' }];

beforeEach(() => {
  enforce.invalidate();
  delete process.env.LICENSE_ENFORCE;
  license.status.mockResolvedValue(ok());
  db.query.mockResolvedValue(ADMINS);
  db.queryOne.mockResolvedValue({ n: 3 });
  notifications.create.mockResolvedValue({});
  auditLog.append.mockResolvedValue({});
});

describe('current', () => {
  test('evaluates once and answers from the cache for a minute', async () => {
    await enforce.current(); await enforce.current(); await enforce.readOnly(); await enforce.feature('api');
    expect(license.status).toHaveBeenCalledTimes(1);
    enforce.invalidate();
    await enforce.current();
    expect(license.status).toHaveBeenCalledTimes(2);
  });
  test('prime hands over a fresh answer without an evaluation', async () => {
    enforce.prime(ok({ readOnly: true, state: 'readonly' }));
    expect(await enforce.readOnly()).toBe(true);
    expect(license.status).not.toHaveBeenCalled();
  });
  test('one evaluation at a time', async () => {
    let resolve; license.status.mockReturnValue(new Promise((r) => { resolve = r; }));
    const a = enforce.current(); const b = enforce.current();
    resolve(ok());
    expect(await a).toBe(await b);
    expect(license.status).toHaveBeenCalledTimes(1);
  });
});

describe('readOnly and features', () => {
  test('follow the evaluated license', async () => {
    expect(await enforce.readOnly()).toBe(false);
    expect(await enforce.feature('editor')).toBe(true);
    expect(await enforce.feature('drive')).toBe(false);
    enforce.prime(ok({ readOnly: true, state: 'readonly' }));
    expect(await enforce.readOnly()).toBe(true);
  });
  test('no feature list, or a license that was not accepted, includes everything', async () => {
    enforce.prime(ok({ features: null }));
    expect(await enforce.feature('anything')).toBe(true);
    enforce.prime(ok({ accepted: false, state: 'unlicensed', features: ['updates'] }));
    expect(await enforce.feature('editor')).toBe(true);
  });
  test('LICENSE_ENFORCE=off switches it all off, and the license is not even asked', async () => {
    process.env.LICENSE_ENFORCE = 'off';
    license.status.mockResolvedValue(ok({ readOnly: true, state: 'readonly', features: [] }));
    expect(enforce.enforcing()).toBe(false);
    expect(await enforce.readOnly()).toBe(false);
    expect(await enforce.feature('editor')).toBe(true);
    expect(await enforce.admitNewAccount()).toEqual({ ok: true });
    expect(license.status).not.toHaveBeenCalled();
  });
  test('an evaluation that throws is never a refusal', async () => {
    license.status.mockRejectedValue(new Error('boom'));
    expect(await enforce.readOnly()).toBe(false);
    expect(await enforce.feature('editor')).toBe(true);
    expect(await enforce.admitNewAccount()).toEqual({ ok: true });
  });
  test('refuse and refuseFeature answer 403 with a code and plain words', () => {
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    enforce.refuse(res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ code: 'LICENSE_READONLY', error: enforce.READONLY_MESSAGE });
    enforce.refuseFeature(res, 'The API');
    expect(res.json).toHaveBeenLastCalledWith({ code: 'LICENSE_FEATURE', error: "The API is not included in this server's license." });
  });
});

describe('admitNewAccount', () => {
  test('unlimited seats in good standing: admitted', async () => {
    expect(await enforce.admitNewAccount()).toEqual({ ok: true });
    expect(db.queryOne).not.toHaveBeenCalled();
  });
  test('a lapsed term refuses with LICENSE_SEAT_FREEZE', async () => {
    enforce.prime(ok({ state: 'lapsed', seatFreeze: true }));
    expect(await enforce.admitNewAccount()).toEqual({ ok: false, code: 'LICENSE_SEAT_FREEZE', error: "No new accounts can be made until this server's license is renewed. Ask an administrator." });
  });
  test('a file that is present but not accepted refuses too, in its own words', async () => {
    enforce.prime(ok({ accepted: false, present: true, state: 'unlicensed', seatFreeze: true }));
    expect(await enforce.admitNewAccount()).toMatchObject({ ok: false, code: 'LICENSE_SEAT_FREEZE', error: expect.stringContaining('until a valid license is installed') });
  });
  test('no file at all still admits during the grace period, and refuses once read-only', async () => {
    enforce.prime(ok({ accepted: false, present: false, state: 'unlicensed', seatFreeze: true, readOnly: false, seats: null }));
    expect(await enforce.admitNewAccount()).toEqual({ ok: true });
    enforce.prime(ok({ accepted: false, present: false, state: 'unlicensed', seatFreeze: true, readOnly: true, seats: null }));
    expect(await enforce.admitNewAccount()).toMatchObject({ ok: false, code: 'LICENSE_SEAT_FREEZE' });
  });
  test('under the cap: admitted, nobody told', async () => {
    enforce.prime(ok({ seats: { licensed: 5, policy: 'soft', used: null } }));
    db.queryOne.mockResolvedValue({ n: 4 });
    expect(await enforce.admitNewAccount()).toEqual({ ok: true });
    expect(notifications.create).not.toHaveBeenCalled();
  });
  test('at a soft cap: admitted, administrators told once a day, audited', async () => {
    enforce.prime(ok({ seats: { licensed: 5, policy: 'soft', used: null } }));
    db.queryOne.mockResolvedValue({ n: 5 });
    expect(await enforce.admitNewAccount()).toEqual({ ok: true, overCap: true });
    await new Promise((r) => setImmediate(r));
    expect(notifications.create).toHaveBeenCalledWith(expect.objectContaining({ userEmail: 'it@acme.com', type: 'license', refId: 'seats', dedupeMinutes: 1440, title: 'Depot seats: 6 accounts on a 5-seat license' }));
    expect(auditLog.append).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'license_seats_exceeded', detail: '6 of 5 seats' }));
  });
  test('at a hard cap: refused with SEAT_LIMIT', async () => {
    enforce.prime(ok({ seats: { licensed: 5, policy: 'hard', used: null } }));
    db.queryOne.mockResolvedValue({ n: 5 });
    expect(await enforce.admitNewAccount()).toEqual({ ok: false, code: 'SEAT_LIMIT', error: 'This server has used all 5 of its licensed seats. Ask an administrator.' });
  });
  test('an unreadable seat count never refuses', async () => {
    enforce.prime(ok({ seats: { licensed: 5, policy: 'hard', used: null } }));
    db.queryOne.mockRejectedValue(new Error('db down'));
    expect(await enforce.admitNewAccount()).toEqual({ ok: true });
  });
  test('the seat count leaves out accounts that are switched off', async () => {
    enforce.prime(ok({ seats: { licensed: 5, policy: 'hard', used: null } }));
    await enforce.admitNewAccount();
    expect(db.queryOne.mock.calls[0][0]).toMatch(/FROM user_roles WHERE disabled_at IS NULL/);
  });
});

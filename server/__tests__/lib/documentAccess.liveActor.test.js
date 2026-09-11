'use strict';
// resolveActor and readersAmong: the live identity used by everything that acts on
// someone's behalf, and the per-address "can they still read it" check for notices.
jest.mock('../../lib/db', () => ({ query: jest.fn(), queryOne: jest.fn() }));
const db = require('../../lib/db');
const { resolveActor, readersAmong, userParams } = require('../../lib/documentAccess');

beforeEach(() => { db.query.mockReset(); db.queryOne.mockReset(); });

describe('resolveActor', () => {
  test('no id, an unknown account, or a lookup failure is no one', async () => {
    expect(await resolveActor(null)).toBeNull();
    db.queryOne.mockResolvedValueOnce(null);
    expect(await resolveActor('u1')).toBeNull();
    db.queryOne.mockRejectedValueOnce(new Error('db down'));
    expect(await resolveActor('u1')).toBeNull();
  });
  test('a verified account matches by its verified address', async () => {
    db.queryOne.mockResolvedValueOnce({ user_id: 'u1', role: 'contributor', email: 'old@x.com', verified_email: 'tim@x.com' });
    const a = await resolveActor('u1');
    expect(a).toEqual({ id: 'u1', role: 'contributor', email: 'tim@x.com', emailVerified: true });
    expect(userParams(a)[3]).toBe('tim@x.com');
  });
  test('an unverified account keeps only what its id holds -- no address-keyed grants', async () => {
    db.queryOne.mockResolvedValueOnce({ user_id: 'u1', role: 'contributor', email: 'tim@x.com', verified_email: null });
    const a = await resolveActor('u1');
    expect(a.emailVerified).toBe(false);
    expect(userParams(a)[3]).toBe('');
    expect(userParams(a).slice(1, 3)).toEqual(['u1', 'u1']);
  });
});

describe('readersAmong', () => {
  test('each address is judged through every account that uses it', async () => {
    db.query
      .mockResolvedValueOnce([{ user_id: 'a1', role: 'viewer', email: 'p@x.com', verified_email: 'p@x.com' }, { user_id: 'a2', role: 'contributor', email: 'p@x.com', verified_email: null }])
      .mockResolvedValueOnce([{ id: 'd1' }])     // a1 can read d1
      .mockResolvedValueOnce([{ id: 'd2' }]);    // a2 can read d2
    const r = await readersAmong(['d1', 'd2', 'd3'], ['P@x.com']);
    expect([...r.get('p@x.com')].sort()).toEqual(['d1', 'd2']);
    const [, q1, q2] = db.query.mock.calls;
    expect(q1[1][2]).toBe('a1'); expect(q1[1][4]).toBe('p@x.com');   // verified: address counts
    expect(q2[1][2]).toBe('a2'); expect(q2[1][4]).toBe('');          // unverified: it doesn't
  });
  test('an address with no account is judged as an anonymous holder of that address', async () => {
    db.query.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 'd1' }]);
    const r = await readersAmong(['d1'], ['outside@y.com']);
    expect(r.get('outside@y.com').has('d1')).toBe(true);
    const q = db.query.mock.calls[1];
    expect(q[1].slice(1, 5)).toEqual(['', null, '', 'outside@y.com']);
  });
  test('anything going wrong counts as "cannot read"', async () => {
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    db.query.mockRejectedValueOnce(new Error('boom'));
    const r = await readersAmong(['d1'], ['p@x.com']);
    expect(r.get('p@x.com').size).toBe(0);
    err.mockRestore();
  });
  test('nothing to check asks the database nothing', async () => {
    expect((await readersAmong([], ['p@x.com'])).get('p@x.com').size).toBe(0);
    expect((await readersAmong(['d1'], [])).size).toBe(0);
    expect(db.query).not.toHaveBeenCalled();
  });
  test('only live documents count', async () => {
    db.query.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    await readersAmong(['d1'], ['p@x.com']);
    expect(db.query.mock.calls[1][0]).toMatch(/d\.deleted_at IS NULL/);
  });
});

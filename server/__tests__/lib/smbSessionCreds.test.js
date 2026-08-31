'use strict';
// The per-user SMB credential store holds real domain passwords in memory, so its
// isolation (one user can never read another's, one connector never another's) is a
// security property worth pinning.
const store = require('../../lib/smbSessionCreds');

afterEach(() => store._clear());

describe('smbSessionCreds — per-user, per-connector, in-memory', () => {
  test('set/get round-trips a credential', () => {
    store.set('u1', 'c1', { domain: 'CORP', username: 'a', password: 'p' });
    expect(store.get('u1', 'c1')).toEqual({ domain: 'CORP', username: 'a', password: 'p' });
  });

  test('credentials are scoped: a different user or connector sees nothing', () => {
    store.set('u1', 'c1', { domain: '', username: 'a', password: 'p' });
    expect(store.get('u2', 'c1')).toBeNull();   // another user
    expect(store.get('u1', 'c2')).toBeNull();   // another connector
  });

  test('forget clears one; forgetUser clears all of a user', () => {
    store.set('u1', 'c1', { username: 'a', password: 'p' });
    store.set('u1', 'c2', { username: 'b', password: 'q' });
    store.set('u2', 'c1', { username: 'c', password: 'r' });
    store.forget('u1', 'c1');
    expect(store.get('u1', 'c1')).toBeNull();
    expect(store.get('u1', 'c2')).not.toBeNull();
    store.forgetUser('u1');
    expect(store.get('u1', 'c2')).toBeNull();
    expect(store.get('u2', 'c1')).not.toBeNull();   // other users untouched
  });

  test('has() reflects presence', () => {
    expect(store.has('u1', 'c1')).toBe(false);
    store.set('u1', 'c1', { username: 'a', password: 'p' });
    expect(store.has('u1', 'c1')).toBe(true);
  });
});

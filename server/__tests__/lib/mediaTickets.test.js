'use strict';
const mt = require('../../lib/mediaTickets');

beforeEach(() => mt._tickets.clear());

test('issue returns an opaque ticket + ttl; resolve returns the captured user', () => {
  const { ticket, ttl } = mt.issue({ id: 'u1', email: 'A@X.com', role: 'admin' });
  expect(typeof ticket).toBe('string');
  expect(ticket.length).toBeGreaterThan(20);
  expect(ttl).toBe(3600);
  expect(mt.resolve(ticket)).toEqual({ id: 'u1', email: 'A@X.com', role: 'admin' });
});

test('resolve rejects unknown, empty, and non-string tokens', () => {
  expect(mt.resolve('nope')).toBeNull();
  expect(mt.resolve('')).toBeNull();
  expect(mt.resolve(undefined)).toBeNull();
  expect(mt.resolve(123)).toBeNull();
});

test('an expired ticket resolves to null and is evicted', () => {
  const { ticket } = mt.issue({ id: 'u2', email: 'b@x', role: 'contributor' });
  mt._tickets.get(ticket).expires = Date.now() - 1;
  expect(mt.resolve(ticket)).toBeNull();
  expect(mt._tickets.has(ticket)).toBe(false);
});

test('two issues produce distinct tickets', () => {
  const a = mt.issue({ id: 'u1', email: 'a', role: 'admin' }).ticket;
  const b = mt.issue({ id: 'u1', email: 'a', role: 'admin' }).ticket;
  expect(a).not.toBe(b);
});

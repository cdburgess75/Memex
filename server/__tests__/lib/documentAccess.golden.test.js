'use strict';
// The access rule is written once, in named parts (documentAccess.conditionWith), so the
// "who has access, and why" lists can evaluate the very same rule for every account and
// name the row behind each way in. Splitting it must not change a single byte of what
// every document query in Depot sends: the text below was captured from condition()
// before the split (v2026.09.11.004). Change the rule on purpose, then re-capture.
jest.mock('../../lib/db', () => ({ query: jest.fn(), queryOne: jest.fn() }));
const da = require('../../lib/documentAccess');
const golden = require('./documentAccess.golden.json').condition;

test.each(Object.keys(golden))('condition(%s) is byte-for-byte what it was', (key) => {
  const [alias, start] = key.split(',');
  expect(da.condition(alias, Number(start))).toBe(golden[key]);
});

test('condition() is conditionWith() over the request parameters', () => {
  for (const [a, s] of [['d', 1], ['x', 7]]) expect(da.conditionWith(a, da.refsAt(s))).toBe(da.condition(a, s));
});

test('the rule references only its five parameters', () => {
  const sql = da.condition('d', 4);
  const used = [...new Set([...sql.matchAll(/\$(\d+)/g)].map(m => Number(m[1])))].sort((x, y) => x - y);
  expect(used).toEqual([4, 5, 6, 7, 8]);
});

test('userParams still supplies exactly those five, in order', () => {
  const p = da.userParams({ id: 'u1', role: 'contributor', email: 'A@x.com', emailVerified: true }, 'write');
  expect(p).toEqual(['contributor', 'u1', 'u1', 'a@x.com', ['write', 'admin']]);
});

test('over a stored account the rule uses its columns, and its verified address only', () => {
  const sql = da.conditionWith('d', da.acctRefs('u', '$3'));
  expect(sql).not.toMatch(/\$[124-9]/);
  expect(sql).toMatch(/lower\(coalesce\(u\.verified_email,''\)\)/);
  expect(sql).toMatch(/pv_ur\.user_id = u\.user_id/);
  expect(sql).not.toMatch(/u\.email\b/);
});

'use strict';
jest.mock('../../lib/db', () => ({ query: jest.fn(), queryOne: jest.fn() }));
const db = require('../../lib/db');
const t = require('../../lib/apiTokens');

beforeEach(() => jest.clearAllMocks());

test('a token is depot_ plus 43 random characters, kept only as a hash', () => {
  const tok = t.generate();
  expect(tok).toMatch(/^depot_[A-Za-z0-9_-]{43}$/);
  expect(t.looksLikeToken(tok)).toBe(true);
  expect(t.looksLikeToken('eyJhbGciOi.jwt.like')).toBe(false);
  expect(t.hash(tok)).toMatch(/^[0-9a-f]{64}$/);
  expect(t.hash(tok)).not.toContain(tok.slice(6, 20));
});

test('an ordinary sign-in has the most its role allows; a token has what it was given', () => {
  expect(t.effectiveScope({ role: 'admin' }, null)).toBe('admin');
  expect(t.effectiveScope({ role: 'contributor' }, null)).toBe('write');
  expect(t.effectiveScope({ role: 'viewer' }, null)).toBe('read');
  expect(t.effectiveScope({ role: 'admin' }, { scope: 'read' })).toBe('read');
  expect(t.scopeCovers('write', 'read')).toBe(true);
  expect(t.scopeCovers('read', 'write')).toBe(false);
  expect(t.scopeCovers('admin', 'admin')).toBe(true);
});

describe('create', () => {
  const admin = { id: 'u1', email: 'a@x.test', role: 'admin' }, contributor = { id: 'u2', email: 'c@x.test', role: 'contributor' };
  beforeEach(() => { db.queryOne.mockImplementation(async (sql) => sql.includes('count(*)') ? { n: 0 } : { id: 't1', user_id: 'u2', name: 'Importer', token_prefix: 'depot_abcdef', scope: 'write', created_at: 'now', expires_at: null, last_used_at: null, revoked_at: null }); });
  test('stores the hash and the prefix, returns the token once', async () => {
    const out = await t.create({ user: contributor, name: '  Importer  ', scope: 'write', expiresAt: null });
    expect(out.token).toMatch(/^depot_/);
    const [sql, params] = db.queryOne.mock.calls.find(([q]) => q.includes('INSERT INTO api_tokens'));
    expect(sql).toContain('INSERT INTO api_tokens');
    expect(params[1]).toBe('Importer');
    expect(params[2]).toBe(t.hash(out.token));
    expect(params[3]).toBe(out.token.slice(0, 12));
    expect(out.record.scope).toBe('write');
  });
  test.each([
    ['a viewer', { id: 'v', role: 'viewer' }, 'Importer', 'read', 403],
    ['no name', contributor, '   ', 'read', 400],
    ['a name that is too long', contributor, 'x'.repeat(81), 'read', 400],
    ['a made-up scope', contributor, 'n', 'root', 400],
    ['admin scope for a contributor', contributor, 'n', 'admin', 403],
    ['an expiry in the past', admin, 'n', 'admin', 400, '2020-01-01'],
    ['an expiry that is not a date', admin, 'n', 'read', 400, 'soon'],
  ])('refuses %s', async (_l, user, name, scope, status, expiresAt = null) => {
    await expect(t.create({ user, name, scope, expiresAt })).rejects.toMatchObject({ status });
  });
  test('refuses a fifty-first token', async () => {
    db.queryOne.mockImplementationOnce(async () => ({ n: 50 }));
    await expect(t.create({ user: contributor, name: 'n', scope: 'read', expiresAt: null })).rejects.toMatchObject({ status: 400 });
  });
});

test('authenticate asks by hash and only for live, unexpired tokens', async () => {
  db.queryOne.mockResolvedValue(null);
  expect(await t.authenticate('nope')).toBeNull();
  expect(db.queryOne).not.toHaveBeenCalled();
  const tok = t.generate();
  await t.authenticate(tok);
  const [sql, params] = db.queryOne.mock.calls[0];
  expect(sql).toMatch(/revoked_at IS NULL AND \(expires_at IS NULL OR expires_at > NOW\(\)\)/);
  expect(params).toEqual([t.hash(tok)]);
});

test('revoke: your own, or anyone\'s for an administrator', async () => {
  db.queryOne.mockResolvedValue(null);
  await t.revoke('11111111-1111-4111-8111-111111111111', { byUser: { id: 'u2' } });
  expect(db.queryOne.mock.calls[0][0]).toContain('AND user_id = $2');
  await t.revoke('11111111-1111-4111-8111-111111111111', { byUser: { id: 'u1' }, anyUser: true });
  expect(db.queryOne.mock.calls[1][0]).not.toContain('AND user_id = $2');
  expect(await t.revoke('not-an-id', { byUser: { id: 'u2' } })).toBeNull();
});

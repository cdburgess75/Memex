'use strict';
// A personal access token in the Authorization header (middleware/auth): accepted for the
// public API only, as the person who made it, within their account's state.
jest.mock('../../lib/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn() }));
jest.mock('jsonwebtoken');
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('../../lib/licenseEnforce', () => ({ admitNewAccount: jest.fn(async () => ({ ok: true })), feature: jest.fn(async () => true), refuseFeature: jest.fn((res, what) => res.status(403).json({ code: 'LICENSE_FEATURE', error: `${what} is not included in this server's license.` })) }));
const db = require('../../lib/db');
const apiTokens = require('../../lib/apiTokens');
const auth = require('../../middleware/auth');
const requestContext = require('../../lib/requestContext');

const tok = apiTokens.generate();
const req = (over = {}) => ({ headers: { authorization: `Bearer ${tok}` }, originalUrl: '/api/v1/me', ...over });
const res = () => { const r = { statusCode: 200, body: null }; r.status = (c) => { r.statusCode = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
const tokenRow = { id: 't1', user_id: 'u1', name: 'Importer', scope: 'write', expires_at: null };
const roleRow = { email: 'Dave@x.test', role: 'contributor', verified_email: 'dave@x.test', disabled_at: null };

beforeEach(() => { jest.clearAllMocks(); db.queryOne.mockImplementation(async (sql) => sql.includes('FROM api_tokens') ? tokenRow : sql.includes('FROM user_roles') ? roleRow : null); });

test('acts as the person, within the token context', async () => {
  const r = req(); const s = res(); let seen = null;
  await auth(r, s, () => { seen = requestContext.current(); });
  expect(r.user).toMatchObject({ id: 'u1', email: 'dave@x.test', role: 'contributor', verifiedEmail: 'dave@x.test' });
  expect(r.apiToken).toMatchObject({ id: 't1', name: 'Importer', scope: 'write' });
  expect(seen).toEqual({ apiToken: r.apiToken });
  expect(requestContext.tokenSuffix()).toBe('');            // outside the request, nothing
});

test('unknown, revoked or expired: 401', async () => {
  db.queryOne.mockResolvedValue(null);
  const s = res(); await auth(req(), s, () => { throw new Error('must not continue'); });
  expect(s.statusCode).toBe(401);
});

test('a switched-off account: 403, before anything else', async () => {
  db.queryOne.mockImplementation(async (sql) => sql.includes('FROM api_tokens') ? tokenRow : { ...roleRow, disabled_at: 'yesterday' });
  const s = res(); await auth(req(), s, () => { throw new Error('must not continue'); });
  expect(s.statusCode).toBe(403); expect(s.body.code).toBe('ACCOUNT_DISABLED');
});

test('the app\'s own routes refuse a token, unless the public API handed the request on', async () => {
  let s = res(); await auth(req({ originalUrl: '/api/files' }), s, () => { throw new Error('must not continue'); });
  expect(s.statusCode).toBe(403);
  s = res(); let went = false;
  await auth(req({ originalUrl: '/api/files/upload-stream', _v1Forward: true }), s, () => { went = true; });
  expect(went).toBe(true);
});

test('a request already authenticated by the public API passes straight through', async () => {
  let went = false;
  await auth({ headers: {}, originalUrl: '/api/files', _v1Forward: true, user: { id: 'u1' } }, res(), () => { went = true; });
  expect(went).toBe(true);
  expect(db.queryOne).not.toHaveBeenCalled();
});

test('"last used" is written, and a JWT-looking token still takes the sign-in path', async () => {
  await auth(req(), res(), () => {});
  expect(db.query.mock.calls.some(([sql]) => sql.includes('SET last_used_at = NOW()'))).toBe(true);
  const jwt = require('jsonwebtoken'); jwt.decode.mockReturnValue(null);
  const s = res(); await auth({ headers: { authorization: 'Bearer eyJ.not.a-token' }, originalUrl: '/api/v1/me' }, s, () => {});
  expect(s.statusCode).toBe(401);                            // the JWT path refused it, not the token path
});

test('a token is refused when the license leaves out the api feature', async () => {
  const enforce = require('../../lib/licenseEnforce');
  enforce.feature.mockResolvedValueOnce(false);
  const r = req(); const s = res(); const next = jest.fn();
  await auth(r, s, next);
  expect(s.statusCode).toBe(403);
  expect(s.body).toEqual({ code: 'LICENSE_FEATURE', error: "The API is not included in this server's license." });
  expect(enforce.feature).toHaveBeenCalledWith('api');
  expect(next).not.toHaveBeenCalled();
});

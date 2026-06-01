'use strict';

jest.mock('jsonwebtoken');
jest.mock('jwks-rsa');
jest.mock('../../lib/db');

const jwt        = require('jsonwebtoken');
const JwksClient = require('jwks-rsa');
const db         = require('../../lib/db');

// Set up the JWKS mock before auth.js loads so the singleton uses it
const mockGetPublicKey  = jest.fn().mockReturnValue('mock-public-key');
const mockGetSigningKey = jest.fn().mockResolvedValue({ getPublicKey: mockGetPublicKey });
JwksClient.mockImplementation(() => ({ getSigningKeyAsync: mockGetSigningKey }));

// Require auth after mocks are registered
const auth = require('../../middleware/auth');

beforeEach(() => {
  jwt.decode.mockReturnValue({ header: { kid: 'key-1' } });
  jwt.verify.mockReturnValue({ sub: 'user-abc', email: 'user@test.com', name: 'Test User' });
  db.queryOne.mockResolvedValue({ role: 'contributor' });
  delete process.env.ADMIN_EMAILS;
});

function makeReq(token) {
  return { headers: { authorization: token ? `Bearer ${token}` : undefined } };
}
function makeRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn() };
}

test('returns 401 when Authorization header is absent', async () => {
  const res = makeRes();
  await auth({ headers: {} }, res, jest.fn());
  expect(res.status).toHaveBeenCalledWith(401);
});

test('returns 401 when token decode fails (no kid)', async () => {
  jwt.decode.mockReturnValue(null);
  const res = makeRes();
  await auth(makeReq('bad.token'), res, jest.fn());
  expect(res.status).toHaveBeenCalledWith(401);
});

test('returns 401 when token has no kid in header', async () => {
  jwt.decode.mockReturnValue({ header: {} });
  const res = makeRes();
  await auth(makeReq('token'), res, jest.fn());
  expect(res.status).toHaveBeenCalledWith(401);
});

test('returns 401 when jwt.verify throws', async () => {
  jwt.verify.mockImplementation(() => { throw new Error('expired'); });
  const res = makeRes();
  await auth(makeReq('token'), res, jest.fn());
  expect(res.status).toHaveBeenCalledWith(401);
});

test('attaches user to req and calls next on valid token', async () => {
  const req = makeReq('valid.token');
  const next = jest.fn();
  await auth(req, makeRes(), next);
  expect(next).toHaveBeenCalledTimes(1);
  expect(req.user).toMatchObject({ id: 'user-abc', email: 'user@test.com', role: 'contributor' });
});

test('auto-assigns contributor role for new user not in ADMIN_EMAILS', async () => {
  db.queryOne
    .mockResolvedValueOnce(null)                    // no existing role row
    .mockResolvedValueOnce({ role: 'contributor' }); // after INSERT
  const req = makeReq('token');
  await auth(req, makeRes(), jest.fn());
  expect(req.user.role).toBe('contributor');
});

test('auto-assigns admin role when email matches ADMIN_EMAILS', async () => {
  process.env.ADMIN_EMAILS = 'user@test.com';
  db.queryOne
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce({ role: 'admin' });
  const req = makeReq('token');
  await auth(req, makeRes(), jest.fn());
  expect(req.user.role).toBe('admin');
});

test('uses existing DB role without inserting again', async () => {
  db.queryOne.mockResolvedValueOnce({ role: 'admin' });
  const req = makeReq('token');
  await auth(req, makeRes(), jest.fn());
  expect(req.user.role).toBe('admin');
  expect(db.queryOne).toHaveBeenCalledTimes(1);
});

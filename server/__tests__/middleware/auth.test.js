'use strict';

jest.mock('jsonwebtoken');
jest.mock('jwks-rsa');
jest.mock('../../lib/db');

const jwt              = require('jsonwebtoken');
const { JwksClient }   = require('jwks-rsa');  // named export in jwks-rsa v3
const db               = require('../../lib/db');

// Set up the JWKS mock before auth.js loads so the singleton uses it
const mockGetPublicKey  = jest.fn().mockReturnValue('mock-public-key');
const mockGetSigningKey = jest.fn().mockResolvedValue({ getPublicKey: mockGetPublicKey });
JwksClient.mockImplementation(() => ({ getSigningKey: mockGetSigningKey }));

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

// Whether the identity provider vouches for the address. Shares are about to match by
// address, so only a verified one may count, and ADMIN_EMAILS may only bootstrap one.
describe('verified email', () => {
  const token = (extra) => jwt.verify.mockReturnValue({ sub: 'user-abc', email: 'User@Test.com', name: 'Test User', ...extra });
  const updates = () => db.query.mock.calls.filter(([sql]) => /UPDATE user_roles SET verified_email/.test(sql));
  beforeEach(() => { db.query.mockReset(); db.query.mockResolvedValue([]); db.queryOne.mockReset(); });

  test('a verified address is recorded lower-cased, and the request says so', async () => {
    token({ email_verified: true });
    db.queryOne.mockResolvedValueOnce({ role: 'contributor', verified_email: null });
    const req = makeReq('t');
    await auth(req, makeRes(), jest.fn());
    expect(req.user).toMatchObject({ email: 'user@test.com', emailVerified: true, verifiedEmail: 'user@test.com' });
    expect(updates()).toHaveLength(1);
    expect(updates()[0][1]).toEqual(['user-abc', 'user@test.com']);
  });

  test('nothing is written when the stored value already matches', async () => {
    token({ email_verified: true });
    db.queryOne.mockResolvedValueOnce({ role: 'contributor', verified_email: 'user@test.com' });
    await auth(makeReq('t'), makeRes(), jest.fn());
    expect(updates()).toHaveLength(0);
  });

  test('an address the provider says is NOT verified is cleared, and never matched', async () => {
    token({ email_verified: false });
    db.queryOne.mockResolvedValueOnce({ role: 'contributor', verified_email: 'user@test.com' });
    const req = makeReq('t');
    await auth(req, makeRes(), jest.fn());
    expect(req.user).toMatchObject({ emailVerified: false, verifiedEmail: null });
    expect(updates()[0][1]).toEqual(['user-abc', null]);
  });

  test('a token that says nothing counts as unverified for shares, and is logged once', async () => {
    // its own account id: the warning is once per account per process, and earlier
    // tests in this file have already signed in as user-abc without the claim
    token({ sub: 'user-says-nothing' });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    db.queryOne.mockResolvedValue({ role: 'contributor', verified_email: null });
    const req = makeReq('t');
    await auth(req, makeRes(), jest.fn());
    await auth(makeReq('t'), makeRes(), jest.fn());
    expect(req.user).toMatchObject({ emailVerified: null, verifiedEmail: null });
    expect(updates()).toHaveLength(0);
    expect(warn.mock.calls.filter(([m]) => /no email_verified claim/.test(m))).toHaveLength(1);
    warn.mockRestore();
  });

  test.each([['yes'], [1], ['true'], [null]])('a non-boolean claim (%p) is treated as not said', async (claim) => {
    token({ email_verified: claim });
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    db.queryOne.mockResolvedValueOnce({ role: 'contributor', verified_email: null });
    const req = makeReq('t');
    await auth(req, makeRes(), jest.fn());
    expect(req.user.verifiedEmail).toBeNull();
    console.warn.mockRestore();
  });

  const inserted = () => db.queryOne.mock.calls.find(([sql]) => /INSERT INTO user_roles/.test(sql));
  test('ADMIN_EMAILS makes a first sign-in an admin only when the address is verified', async () => {
    process.env.ADMIN_EMAILS = 'user@test.com';
    token({ email_verified: true });
    db.queryOne.mockResolvedValueOnce(null).mockResolvedValueOnce({ role: 'admin', verified_email: 'user@test.com' });
    await auth(makeReq('t'), makeRes(), jest.fn());
    expect(inserted()[1]).toEqual(['user-abc', 'user@test.com', 'admin', 'user@test.com']);
  });

  test.each([[false], [undefined]])('with email_verified %p, an ADMIN_EMAILS address is provisioned as a contributor', async (claim) => {
    process.env.ADMIN_EMAILS = 'user@test.com';
    token(claim === undefined ? {} : { email_verified: claim });
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    db.queryOne.mockResolvedValueOnce(null).mockResolvedValueOnce({ role: 'contributor', verified_email: null });
    const req = makeReq('t');
    await auth(req, makeRes(), jest.fn());
    expect(inserted()[1]).toEqual(['user-abc', 'user@test.com', 'contributor', null]);
    expect(req.user.role).toBe('contributor');
    console.warn.mockRestore();
  });
});

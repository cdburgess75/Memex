'use strict';
// Recording an access review: the list as it stands is kept with who signed and when, the
// chained event access_reviewed is appended, the history reads back newest first, and
// none of it is open to anyone but an administrator.
const request = require('supertest');
const express = require('express');

jest.mock('../../lib/db', () => ({ query: jest.fn(), queryOne: jest.fn() }));
jest.mock('../../lib/settings', () => ({ getOrEnv: jest.fn().mockResolvedValue(null), get: jest.fn().mockResolvedValue(null), set: jest.fn(), refresh: jest.fn() }));
jest.mock('../../lib/compliance', () => ({}));
jest.mock('../../lib/documentAccess', () => ({}));
jest.mock('../../lib/auditLog', () => ({ append: jest.fn().mockResolvedValue({ chain_seq: 9 }) }));
jest.mock('../../lib/keycloakAdmin', () => ({ mfaStatusByUser: jest.fn().mockResolvedValue({ byEmail: { 'ann@x.com': { state: 'enrolled', provider: null } } }) }));
let mockUser = { id: 'admin-1', email: 'admin@x.com', role: 'admin' };
jest.mock('../../middleware/auth', () => (req, _res, next) => { req.user = mockUser; next(); });

const db = require('../../lib/db');
const auditLog = require('../../lib/auditLog');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', require('../../routes/admin'));
  return app;
}
const ROW = { id: 7, reviewed_at: '2026-11-03T10:00:00.000Z', reviewed_by_email: 'admin@x.com', user_count: 1, note: 'Removed a leaver' };

beforeEach(() => {
  mockUser = { id: 'admin-1', email: 'admin@x.com', role: 'admin' };
  db.query.mockImplementation(async (sql) => {
    if (/FROM user_roles/.test(sql)) return [{ user_id: 'u2', email: 'ann@x.com', role: 'contributor', verified_email: 'ann@x.com' }];
    if (/FROM access_reviews/.test(sql)) return [ROW];
    return [];
  });
  db.queryOne.mockImplementation(async (sql) => (/INSERT INTO access_reviews/.test(sql) ? ROW : null));
});

test('POST signoff keeps the list as a snapshot, with who and when, and chains the event', async () => {
  const res = await request(makeApp()).post('/api/admin/access-review/signoff').send({ note: 'Removed a leaver' });
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
  expect(res.body.review).toEqual(ROW);
  expect(res.body.history).toEqual([ROW]);
  const ins = db.queryOne.mock.calls.find(c => /INSERT INTO access_reviews/.test(c[0]));
  expect(ins[1].slice(0, 4)).toEqual(['admin@x.com', 'admin-1', 1, 'Removed a leaver']);
  const snap = JSON.parse(ins[1][4]);
  expect(snap.users).toEqual([expect.objectContaining({ email: 'ann@x.com', role: 'contributor', mfa: 'enrolled' })]);
  expect(auditLog.append).toHaveBeenCalledWith({ documentId: null, eventType: 'access_reviewed', actorId: 'admin-1', actorEmail: 'admin@x.com', detail: '1 person on the list · Removed a leaver' });
});

test('a note is optional and is cut to a sane length', async () => {
  await request(makeApp()).post('/api/admin/access-review/signoff').send({});
  expect(db.queryOne.mock.calls.find(c => /INSERT INTO access_reviews/.test(c[0]))[1][3]).toBeNull();
  await request(makeApp()).post('/api/admin/access-review/signoff').send({ note: 'x'.repeat(2000) });
  expect(db.queryOne.mock.calls.filter(c => /INSERT INTO access_reviews/.test(c[0])).at(-1)[1][3]).toHaveLength(1000);
});

test('GET history lists past sign-offs without their snapshots', async () => {
  const res = await request(makeApp()).get('/api/admin/access-review/history');
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ reviews: [ROW] });
  const q = db.query.mock.calls.find(c => /FROM access_reviews/.test(c[0]));
  expect(q[0]).not.toMatch(/snapshot/);
  expect(q[0]).toMatch(/ORDER BY reviewed_at DESC/);
});

test('both are for administrators only', async () => {
  mockUser = { id: 'u-2', email: 'ann@x.com', role: 'contributor' };
  expect((await request(makeApp()).post('/api/admin/access-review/signoff').send({})).status).toBe(403);
  expect((await request(makeApp()).get('/api/admin/access-review/history')).status).toBe(403);
  expect(auditLog.append).not.toHaveBeenCalled();
});

test('the users list carries the second step per person, and says when Keycloak would not answer', async () => {
  let res = await request(makeApp()).get('/api/admin/access-review');
  expect(res.body.users[0].mfa).toBe('enrolled');
  expect(res.body.mfaError).toBeUndefined();
  require('../../lib/keycloakAdmin').mfaStatusByUser.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
  res = await request(makeApp()).get('/api/admin/access-review');
  expect(res.status).toBe(200);
  expect(res.body.users[0].mfa).toBe('unknown');
  expect(res.body.mfaError).toMatch(/ECONNREFUSED/);
});

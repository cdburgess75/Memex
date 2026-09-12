'use strict';
// Giving an ownerless library an owner, and letting somebody hand their own files to it.
//
// Depot creates one library at install with nobody's name on it. It cannot be shared (a
// share belongs to an owner), and once the old open rule goes it cannot be added to
// either -- so every install needs a way to fill that in. And the files already in it are
// personal to whoever uploaded them, which is right for a parked file and wrong for the
// company's shared folder: their uploader, and only their uploader, can hand them over.
const request = require('supertest');
const express = require('express');

const LIB = 'aaaaaaaa-0000-4000-8000-000000000001';
const ADMIN = { id: '11111111-1111-4111-8111-111111111111', email: 'admin@x.com', role: 'admin' };
const DAVE = { id: '22222222-2222-4222-8222-222222222222', email: 'dave@x.com', role: 'contributor' };

const mockState = { user: ADMIN, library: null, account: null, updated: null, adopted: [], others: 0, visible: null };
const seen = [];
jest.mock('../../lib/db', () => ({
  query: jest.fn(async (sql, params) => {
    seen.push({ sql, params });
    if (/UPDATE documents d SET library_scoped = true/.test(sql)) return mockState.adopted;
    return [];
  }),
  queryOne: jest.fn(async (sql, params) => {
    seen.push({ sql, params });
    if (/SELECT id, name, owner_id FROM libraries/.test(sql)) return mockState.library;
    if (/FROM user_roles WHERE lower\(email\)/.test(sql)) return mockState.account;
    if (/UPDATE libraries SET owner_id/.test(sql)) return mockState.updated;
    if (/count\(\*\)::int AS n FROM documents/.test(sql)) return { n: mockState.others };
    return null;
  }),
  withTransaction: jest.fn(async (fn) => fn({ query: async () => ({ rows: [] }) })),
}));
jest.mock('../../lib/libraries', () => ({
  ...jest.requireActual('../../lib/libraries'),
  visibleLibrary: jest.fn(async () => mockState.visible),
}));
jest.mock('../../lib/auditLog', () => ({ append: jest.fn(async () => ({})) }));
jest.mock('../../lib/notifications', () => ({ create: jest.fn(async () => ({})) }));
jest.mock('../../lib/emailEvents', () => ({ send: jest.fn(async () => ({})) }));
jest.mock('../../middleware/auth', () => (req, res, next) => {
  if (!mockState.user) return res.status(401).json({ error: 'Unauthorized' });
  req.user = { ...mockState.user };
  next();
});

const auditLog = require('../../lib/auditLog');
const app = () => { const a = express(); a.use(express.json()); a.use('/api/libraries', require('../../routes/libraries')); return a; };
const setOwner = (body) => request(app()).post(`/api/libraries/${LIB}/owner`).send(body);
const adopt = (body) => request(app()).post(`/api/libraries/${LIB}/adopt`).send(body || {});

beforeEach(() => {
  seen.length = 0;
  jest.clearAllMocks();
  Object.assign(mockState, {
    user: ADMIN,
    library: { id: LIB, name: 'Ptech Workspace', owner_id: null },
    account: { user_id: DAVE.id, email: 'Dave@X.com', role: 'contributor' },
    updated: { id: LIB, name: 'Ptech Workspace', owner_id: DAVE.id, owner_email: 'dave@x.com' },
    adopted: [], others: 0,
    visible: { id: LIB, name: 'Ptech Workspace', can_manage: true },
  });
});

describe('giving an ownerless library an owner', () => {
  test('an admin can, and the address is stored lower-cased', async () => {
    const res = await setOwner({ owner_email: '  Dave@X.com ' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ owner_id: DAVE.id, owner_email: 'dave@x.com' });
    const upd = seen.find(x => /UPDATE libraries SET owner_id/.test(x.sql));
    // only ever fills in a MISSING owner, even under a race
    expect(upd.sql).toMatch(/AND owner_id IS NULL/);
    expect(auditLog.append).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'library_created' }));
  });

  test('a library that already has one is refused, not quietly reassigned', async () => {
    mockState.library = { id: LIB, name: 'testing', owner_id: 'somebody' };
    const res = await setOwner({ owner_email: 'dave@x.com' });
    expect([res.status, res.body.code]).toEqual([409, 'ALREADY_OWNED']);
    expect(res.body.error).toMatch(/separate job/);
    expect(seen.some(x => /UPDATE libraries/.test(x.sql))).toBe(false);
  });

  test('only an admin may, and only for somebody who has signed in', async () => {
    mockState.user = DAVE;
    expect((await setOwner({ owner_email: 'dave@x.com' })).status).toBe(403);
    mockState.user = ADMIN;
    mockState.account = null;
    expect((await setOwner({ owner_email: 'nobody@x.com' })).status).toBe(404);
  });

  test('somebody who can only look at files cannot own one', async () => {
    mockState.account = { user_id: DAVE.id, email: 'dave@x.com', role: 'viewer' };
    const res = await setOwner({ owner_email: 'dave@x.com' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/only look at files/);
  });

  test('an owner is matched by account, so it works before any address is verified', async () => {
    // the account lookup accepts the signed-in address as well as a verified one
    await setOwner({ owner_email: 'dave@x.com' });
    const look = seen.find(x => /FROM user_roles WHERE lower\(email\)/.test(x.sql));
    expect(look.sql).toMatch(/OR verified_email = \$1/);
  });
});

describe('handing your own files to the library', () => {
  test('only the caller\'s own files move, and nobody else\'s are touched', async () => {
    mockState.user = DAVE;
    mockState.adopted = [{ id: 'd1' }, { id: 'd2' }];
    const res = await adopt();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, count: 2 });     // a non-admin is told nothing about others
    const upd = seen.find(x => /UPDATE documents d SET library_scoped = true/.test(x.sql));
    expect(upd.sql).toMatch(/AND d\.uploaded_by = \$2/);
    expect(upd.sql).toMatch(/AND NOT d\.library_scoped/);
    expect(upd.sql).toMatch(/d\.deleted_at IS NULL/);
    expect(upd.params).toEqual([LIB, DAVE.id]);
  });

  test('an admin is told how many were left with their owners, never given them', async () => {
    mockState.adopted = [{ id: 'd1' }];
    mockState.others = 4;
    const res = await adopt();
    expect(res.body).toEqual({ ok: true, count: 1, left_with_their_owners: 4 });
    expect(seen.find(x => /UPDATE documents d SET library_scoped = true/.test(x.sql)).sql).toMatch(/d\.uploaded_by = \$2/);
  });

  test('it can be limited to one folder', async () => {
    mockState.adopted = [{ id: 'd1' }];
    await adopt({ path: 'Clients/Acme' });
    const upd = seen.find(x => /UPDATE documents d SET library_scoped = true/.test(x.sql));
    expect(upd.sql).toMatch(/starts_with\(d\.name, \$3 \|\| '\/'\)/);
    expect(upd.params[2]).toBe('Clients/Acme');
  });

  test('a bad folder path is refused, and a library you do not manage is not yours to fill', async () => {
    expect((await adopt({ path: '../x' })).status).toBe(400);
    mockState.visible = { id: LIB, name: 'x', can_manage: false };
    expect((await adopt()).status).toBe(403);
    mockState.visible = null;
    expect((await adopt()).status).toBe(404);
  });

  test('nothing to adopt is a plain answer, and is not written down as if something happened', async () => {
    mockState.adopted = [];
    const res = await adopt();
    expect(res.body).toMatchObject({ ok: true, count: 0 });
    expect(auditLog.append).not.toHaveBeenCalled();
  });
});

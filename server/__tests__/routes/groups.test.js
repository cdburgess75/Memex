'use strict';
// Groups route tests.
//
// These run the REAL lib/groups.js — its ownership rule, visibility rule, name
// cleaning and email validation — against a small in-memory database that answers the
// exact queries lib/groups.js issues. Nothing about who may do what is mocked, so a
// wrong permission check fails here. (The older route suites mock the access layer
// away entirely; that is how an authorization regression reaches production green.)
const request = require('supertest');
const express = require('express');
const crypto = require('crypto');

const store = { groups: [], members: [], users: [], profiles: [] };
const lc = s => String(s || '').toLowerCase();
const dup = () => Object.assign(new Error('duplicate key'), { code: '23505' });

function mockFakeQuery(sql, p = []) {
  const s = sql.replace(/\s+/g, ' ');
  if (/FROM groups g WHERE \$1/.test(s)) {
    const [isAdmin, email, uid] = p;
    return store.groups
      .filter(g => isAdmin || String(g.owner_id) === String(uid) || store.members.some(m => m.group_id === g.id && lc(m.member_email) === lc(email)))
      .map(g => ({ ...g, member_count: store.members.filter(m => m.group_id === g.id).length,
        is_member: store.members.some(m => m.group_id === g.id && lc(m.member_email) === lc(email)) }));
  }
  if (/^SELECT .* FROM groups WHERE id = \$1/.test(s.trim())) return store.groups.filter(g => g.id === p[0]);
  if (/SELECT 1 FROM group_members WHERE group_id = \$1 AND lower\(member_email\)/.test(s))
    return store.members.filter(m => m.group_id === p[0] && lc(m.member_email) === lc(p[1])).map(() => ({ '?column?': 1 }));
  if (/^INSERT INTO groups/.test(s.trim())) {
    if (store.groups.some(g => lc(g.name) === lc(p[0]))) throw dup();
    const g = { id: crypto.randomUUID(), name: p[0], owner_id: p[1], owner_email: p[2], created_by: p[1], created_by_email: p[2], created_at: new Date() };
    store.groups.push(g); return [g];
  }
  if (/^UPDATE groups SET name/.test(s.trim())) {
    if (store.groups.some(g => lc(g.name) === lc(p[1]) && g.id !== p[0])) throw dup();
    const g = store.groups.find(x => x.id === p[0]); if (!g) return []; g.name = p[1]; return [g];
  }
  if (/^UPDATE groups SET owner_id/.test(s.trim())) {
    const g = store.groups.find(x => x.id === p[0]); if (!g) return []; g.owner_id = p[1]; g.owner_email = p[2]; return [g];
  }
  if (/^DELETE FROM groups/.test(s.trim())) {
    const i = store.groups.findIndex(g => g.id === p[0]); if (i < 0) return [];
    const [g] = store.groups.splice(i, 1); store.members = store.members.filter(m => m.group_id !== g.id); return [g];
  }
  if (/FROM group_members m LEFT JOIN user_profiles p/.test(s))
    return store.members.filter(m => m.group_id === p[0]).map(m => ({ ...m,
      display_name: (store.profiles.find(x => lc(x.email) === lc(m.member_email)) || {}).display_name || null,
      has_signed_in: store.users.some(u => lc(u.email) === lc(m.member_email)) }));
  if (/^INSERT INTO group_members/.test(s.trim())) {
    if (store.members.some(m => m.group_id === p[0] && lc(m.member_email) === lc(p[1]))) return [];
    const m = { id: crypto.randomUUID(), group_id: p[0], member_email: p[1], added_by_email: p[3], created_at: new Date() };
    store.members.push(m); return [m];
  }
  if (/FROM group_members WHERE group_id = \$1 AND lower\(member_email\) = lower\(\$2\)/.test(s))
    return store.members.filter(m => m.group_id === p[0] && lc(m.member_email) === lc(p[1]));
  if (/^DELETE FROM group_members/.test(s.trim())) {
    const i = store.members.findIndex(m => m.id === p[0] && m.group_id === p[1]); if (i < 0) return [];
    return store.members.splice(i, 1);
  }
  if (/FROM user_roles WHERE lower\(email\)/.test(s)) return store.users.filter(u => lc(u.email) === lc(p[0]));
  throw new Error('fake db: unhandled query: ' + s.slice(0, 90));
}

jest.mock('../../lib/db', () => ({
  query: jest.fn(async (sql, p) => mockFakeQuery(sql, p)),
  queryOne: jest.fn(async (sql, p) => mockFakeQuery(sql, p)[0] || null),
}));
const mockAppend = jest.fn().mockResolvedValue({});
jest.mock('../../lib/auditLog', () => ({ append: (...a) => mockAppend(...a) }));

let mockUser;
jest.mock('../../middleware/auth', () => (req, _res, next) => { req.user = mockUser; next(); });

const RICHARD = { id: '11111111-1111-4111-8111-111111111111', email: 'richard@ptechllc.com', role: 'contributor' };
const DAVE    = { id: '22222222-2222-4222-8222-222222222222', email: 'dave@ptechllc.com', role: 'admin' };
const TAMMY   = { id: '33333333-3333-4333-8333-333333333333', email: 'tammy@ptechllc.com', role: 'contributor' };
const JACKSON = { id: '44444444-4444-4444-8444-444444444444', email: 'jackson@ptechllc.com', role: 'contributor' };
const VIEWER  = { id: '55555555-5555-4555-8555-555555555555', email: 'viewer@ptechllc.com', role: 'viewer' };

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/groups', require('../../routes/groups'));
  return a;
}
const as = (user) => { mockUser = user; return request(app()); };

// Richard (not an admin) owns "Acctg", with Tammy and an outside accountant in it —
// the ParaTech shape that forced owner-managed groups.
async function seedAcctg() {
  const g = (await as(RICHARD).post('/api/groups').send({ name: 'Acctg' })).body;
  await as(RICHARD).post(`/api/groups/${g.id}/members`).send({ email: 'tammy@ptechllc.com' });
  await as(RICHARD).post(`/api/groups/${g.id}/members`).send({ email: 'tim.baudier@dts-tax.com' });
  return g;
}

beforeEach(() => {
  store.groups = []; store.members = [];
  store.users = [RICHARD, DAVE, TAMMY, JACKSON].map(u => ({ user_id: u.id, email: u.email }));
  store.profiles = [{ email: 'tammy@ptechllc.com', display_name: 'Tammy Richard' }];
  mockAppend.mockClear(); mockAppend.mockResolvedValue({});
});

describe('creating a group', () => {
  test('a contributor who is not an admin can create one, and owns it', async () => {
    const res = await as(RICHARD).post('/api/groups').send({ name: 'Acctg' });
    expect(res.status).toBe(201);
    expect(res.body.owner_email).toBe('richard@ptechllc.com');
    expect(res.body.can_manage).toBe(true);
  });

  test('a viewer cannot create a group', async () => {
    expect((await as(VIEWER).post('/api/groups').send({ name: 'Nope' })).status).toBe(403);
  });

  test('names are unique regardless of case, so two "All Staff" groups cannot exist', async () => {
    await as(RICHARD).post('/api/groups').send({ name: 'All Staff' });
    const res = await as(TAMMY).post('/api/groups').send({ name: 'all staff' });
    expect(res.status).toBe(409);
  });

  test('a blank or oversized name is refused', async () => {
    expect((await as(RICHARD).post('/api/groups').send({ name: '   ' })).status).toBe(400);
    expect((await as(RICHARD).post('/api/groups').send({ name: 'x'.repeat(81) })).status).toBe(400);
  });

  test('creation is chained in the audit log', async () => {
    await as(RICHARD).post('/api/groups').send({ name: 'Acctg' });
    expect(mockAppend).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'group_created', actorEmail: 'richard@ptechllc.com' }));
  });
});

describe('who can see a group', () => {
  test('an owner, a member and an admin see it; a stranger does not', async () => {
    const g = await seedAcctg();
    expect((await as(RICHARD).get(`/api/groups/${g.id}`)).status).toBe(200);
    expect((await as(TAMMY).get(`/api/groups/${g.id}`)).status).toBe(200);
    expect((await as(DAVE).get(`/api/groups/${g.id}`)).status).toBe(200);
    expect((await as(JACKSON).get(`/api/groups/${g.id}`)).status).toBe(404);
  });

  test('a stranger gets 404, not 403, so the group\'s existence does not leak', async () => {
    const g = await seedAcctg();
    for (const call of [
      () => as(JACKSON).get(`/api/groups/${g.id}/members`),
      () => as(JACKSON).put(`/api/groups/${g.id}`).send({ name: 'x' }),
      () => as(JACKSON).delete(`/api/groups/${g.id}`),
    ]) expect((await call()).status).toBe(404);
  });

  test('the list shows each caller only their own groups, and admins all of them', async () => {
    await seedAcctg();
    await as(JACKSON).post('/api/groups').send({ name: 'IT' });
    const names = async (u) => (await as(u).get('/api/groups')).body.map(g => g.name).sort();
    expect(await names(RICHARD)).toEqual(['Acctg']);
    expect(await names(TAMMY)).toEqual(['Acctg']);
    expect(await names(JACKSON)).toEqual(['IT']);
    expect(await names(DAVE)).toEqual(['Acctg', 'IT']);
  });

  test('a malformed id is a clean 404, not a database error', async () => {
    expect((await as(DAVE).get('/api/groups/not-a-uuid')).status).toBe(404);
  });
});

describe('who can change a group', () => {
  test('a member can see the group but cannot change it', async () => {
    const g = await seedAcctg();
    expect((await as(TAMMY).put(`/api/groups/${g.id}`).send({ name: 'Mine' })).status).toBe(403);
    expect((await as(TAMMY).post(`/api/groups/${g.id}/members`).send({ email: 'x@y.com' })).status).toBe(403);
    expect((await as(TAMMY).delete(`/api/groups/${g.id}`)).status).toBe(403);
  });

  test('the owner can rename it without being an admin', async () => {
    const g = await seedAcctg();
    const res = await as(RICHARD).put(`/api/groups/${g.id}`).send({ name: 'Accounting' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Accounting');
  });

  test('an admin can change a group they do not own', async () => {
    const g = await seedAcctg();
    expect((await as(DAVE).put(`/api/groups/${g.id}`).send({ name: 'Finance' })).status).toBe(200);
  });

  test('renaming onto an existing name is refused', async () => {
    const g = await seedAcctg();
    await as(RICHARD).post('/api/groups').send({ name: 'GTS' });
    expect((await as(RICHARD).put(`/api/groups/${g.id}`).send({ name: 'gts' })).status).toBe(409);
  });

  test('deleting a group removes it and chains the deletion', async () => {
    const g = await seedAcctg();
    expect((await as(RICHARD).delete(`/api/groups/${g.id}`)).status).toBe(200);
    expect(store.groups.some(x => x.id === g.id)).toBe(false);
    expect(mockAppend).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'group_deleted' }));
  });

  // Members are removed by ON DELETE CASCADE in the schema, not by the route. A fake
  // database that simulated the cascade would keep passing even if the cascade were
  // deleted from the real migration — so assert on the migration itself instead.
  test('the schema cascades group deletion to its members', () => {
    const sql = require('fs').readFileSync(require('path').join(__dirname, '../../migrations/0006_groups.sql'), 'utf8');
    expect(sql).toMatch(/group_id\s+UUID\s+NOT NULL REFERENCES groups\(id\) ON DELETE CASCADE/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS groups_name_lower_uniq ON groups \(lower\(name\)\)/);
  });
});

describe('membership', () => {
  test('someone outside the organisation can be added', async () => {
    const g = (await as(RICHARD).post('/api/groups').send({ name: 'VNA' })).body;
    const res = await as(RICHARD).post(`/api/groups/${g.id}/members`).send({ email: 'John.Johnson@VNATexas.org' });
    expect(res.status).toBe(201);
    expect(res.body.member_email).toBe('john.johnson@vnatexas.org');
  });

  test('adding someone twice is harmless and does not duplicate them', async () => {
    const g = await seedAcctg();
    const res = await as(RICHARD).post(`/api/groups/${g.id}/members`).send({ email: 'TAMMY@ptechllc.com' });
    expect(res.status).toBe(200);
    expect(res.body.already_member).toBe(true);
    expect(store.members.filter(m => m.group_id === g.id)).toHaveLength(2);
  });

  test('a malformed address is refused', async () => {
    const g = await seedAcctg();
    for (const email of ['nope', 'a@b', '"x"@y.com', '<a@b.com>', 'a b@c.com'])
      expect((await as(RICHARD).post(`/api/groups/${g.id}/members`).send({ email })).status).toBe(400);
  });

  test('removing a member is chained, and removing someone not there is a 404', async () => {
    const g = await seedAcctg();
    const tim = store.members.find(m => m.member_email === 'tim.baudier@dts-tax.com');
    expect((await as(RICHARD).delete(`/api/groups/${g.id}/members/${tim.id}`)).status).toBe(200);
    expect(mockAppend).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'group_member_removed' }));
    expect((await as(RICHARD).delete(`/api/groups/${g.id}/members/${tim.id}`)).status).toBe(404);
  });

  test('a member cannot be removed through a different group\'s URL', async () => {
    const acctg = await seedAcctg();
    const other = (await as(RICHARD).post('/api/groups').send({ name: 'GTS' })).body;
    const tim = store.members.find(m => m.group_id === acctg.id && m.member_email === 'tim.baudier@dts-tax.com');
    expect((await as(RICHARD).delete(`/api/groups/${other.id}/members/${tim.id}`)).status).toBe(404);
    expect(store.members.some(m => m.id === tim.id)).toBe(true);
  });
});

describe('member names', () => {
  test('a member who has signed in shows their name; an outside contact who has not is flagged', async () => {
    const g = await seedAcctg();
    const rows = (await as(RICHARD).get(`/api/groups/${g.id}/members`)).body;
    const tammy = rows.find(r => r.member_email === 'tammy@ptechllc.com');
    const tim = rows.find(r => r.member_email === 'tim.baudier@dts-tax.com');
    expect(tammy.display_name).toBe('Tammy Richard');
    expect(tammy.has_signed_in).toBe(true);
    expect(tim.display_name).toBeNull();
    expect(tim.has_signed_in).toBe(false);
  });
});

describe('handing a group over', () => {
  test('the owner can give it to someone who has signed in', async () => {
    const g = await seedAcctg();
    const res = await as(RICHARD).put(`/api/groups/${g.id}/owner`).send({ email: 'tammy@ptechllc.com' });
    expect(res.status).toBe(200);
    expect(res.body.owner_email).toBe('tammy@ptechllc.com');
    // and Richard, no longer the owner or an admin, loses the right to manage it
    expect(res.body.can_manage).toBe(false);
  });

  test('it cannot go to someone who has never signed in', async () => {
    const g = await seedAcctg();
    expect((await as(RICHARD).put(`/api/groups/${g.id}/owner`).send({ email: 'tim.baudier@dts-tax.com' })).status).toBe(400);
  });
});

describe('audit resilience', () => {
  test('a failing audit write is logged but does not fail the change that succeeded', async () => {
    mockAppend.mockRejectedValue(new Error('chain locked'));
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await as(RICHARD).post('/api/groups').send({ name: 'Acctg' });
    expect(res.status).toBe(201);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('audit group_created failed'), 'chain locked');
    spy.mockRestore();
  });
});

'use strict';
// Groups route tests.
//
// These run the REAL lib/groups.js and routes/groups.js — the ownership rule, the
// visibility rule, name cleaning, email validation, every status code and audit entry —
// against a small in-memory database. Nothing about who may do what is mocked.
//
// The fake answers ONLY the twelve statements lib/groups.js is known to send, matched on
// their exact text. That makes it a change detector rather than a second copy of the
// rules: the rules that live in SQL WHERE clauses — who is listed, that a removal stays
// inside one group, that a write touches one row and only if the group is unchanged —
// cannot be quietly broken here, because any edit to a statement fails every test that
// reaches it until the table below is updated. Update the table only after re-running
// __tests__/integration/groups.pg.test.js against a real Postgres, which checks what the
// statements actually do. (CI has no Postgres; that suite skips without MEMEX_TEST_PG_URL.)
const request = require('supertest');
const express = require('express');
const crypto = require('crypto');

const store = { groups: [], members: [], users: [], profiles: [], grants: [] };
const lc = s => String(s || '').toLowerCase();
const pgErr = (code, msg = code) => Object.assign(new Error(msg), { code });
// Postgres's uuid input takes upper case, braces and missing hyphens, and refuses
// anything else with 22P02 — which a route would surface as a 500.
const PG_UUID = /^\{?[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}\}?$/i;
const uuidIn = (...vals) => { for (const v of vals) if (v != null && !PG_UUID.test(String(v))) throw pgErr('22P02', `invalid input syntax for type uuid: "${v}"`); };
const uuidEq = (a, b) => a != null && b != null && lc(String(a).replace(/[{}-]/g, '')) === lc(String(b).replace(/[{}-]/g, ''));
// Rows are always copies: a live store object handed to the route would change under it
// when a later UPDATE ran, and hide a stale "from" value in the audit.
const pick = (r, keys) => Object.fromEntries(keys.map(k => [k, r[k]]));
const isMember = (gid, email) => store.members.some(m => uuidEq(m.group_id, gid) && lc(m.member_email) === lc(email));
const RET = ['id', 'name', 'owner_id', 'owner_email', 'created_at'];
const MEMBER_RET = ['id', 'member_email', 'added_by_email', 'created_at'];
const ARROW = '\u2192';

const SQL = {
  // libraryShares.countForGroup: the library/folder shares a group carries
  'SELECT count(*)::int AS n FROM library_grants WHERE group_id = $1':
    ([gid]) => { uuidIn(gid); return [{ n: store.grants.filter(x => uuidEq(x.group_id, gid)).length }]; },
  // listGroups
  'SELECT g.id, g.name, g.owner_id, g.owner_email, g.created_at, (SELECT count(*) FROM group_members m WHERE m.group_id = g.id)::int AS member_count, EXISTS (SELECT 1 FROM group_members m WHERE m.group_id = g.id AND lower(m.member_email) = lower($2)) AS is_member FROM groups g WHERE $1 OR g.owner_id = $3 OR EXISTS (SELECT 1 FROM group_members m WHERE m.group_id = g.id AND lower(m.member_email) = lower($2)) ORDER BY lower(g.name)':
    ([isAdmin, email, uid]) => {
      uuidIn(uid);
      return store.groups
        .filter(g => isAdmin || uuidEq(g.owner_id, uid) || isMember(g.id, email))
        .sort((a, b) => lc(a.name).localeCompare(lc(b.name)))
        .map(g => ({ ...pick(g, RET), member_count: store.members.filter(m => uuidEq(m.group_id, g.id)).length, is_member: isMember(g.id, email) }));
    },
  // getGroup
  'SELECT id, name, owner_id, owner_email, created_by, created_by_email, created_at, updated_at FROM groups WHERE id = $1':
    ([id]) => { uuidIn(id); return store.groups.filter(g => uuidEq(g.id, id)).map(g => pick(g, ['id', 'name', 'owner_id', 'owner_email', 'created_by', 'created_by_email', 'created_at', 'updated_at'])); },
  // canView's membership check
  'SELECT 1 FROM group_members WHERE group_id = $1 AND lower(member_email) = lower($2)':
    ([gid, email]) => { uuidIn(gid); return isMember(gid, email) ? [{ '?column?': 1 }] : []; },
  // createGroup — groups_name_lower_uniq
  'INSERT INTO groups (name, owner_id, owner_email, created_by, created_by_email) VALUES ($1, $2, $3, $2, $3) RETURNING id, name, owner_id, owner_email, created_at':
    ([name, ownerId, ownerEmail]) => {
      uuidIn(ownerId);
      if (store.groups.some(g => lc(g.name) === lc(name))) throw pgErr('23505', 'duplicate key value violates unique constraint "groups_name_lower_uniq"');
      const now = new Date();
      const g = { id: crypto.randomUUID(), name, owner_id: ownerId, owner_email: ownerEmail, created_by: ownerId, created_by_email: ownerEmail, created_at: now, updated_at: now };
      store.groups.push(g);
      return [pick(g, RET)];
    },
  // renameGroup — conditional on the name the caller was authorised against
  'UPDATE groups SET name = $2, updated_at = NOW() WHERE id = $1 AND name = $3 RETURNING id, name, owner_id, owner_email, created_at':
    ([id, name, expected]) => {
      uuidIn(id);
      const g = store.groups.find(x => uuidEq(x.id, id) && x.name === expected);
      if (!g) return [];
      if (store.groups.some(x => x !== g && lc(x.name) === lc(name))) throw pgErr('23505', 'duplicate key value violates unique constraint "groups_name_lower_uniq"');
      g.name = name; g.updated_at = new Date();
      return [pick(g, RET)];
    },
  // deleteGroup — members go by ON DELETE CASCADE (asserted on the migration below)
  'DELETE FROM groups WHERE id = $1 RETURNING id, name':
    ([id]) => {
      uuidIn(id);
      const i = store.groups.findIndex(g => uuidEq(g.id, id));
      if (i < 0) return [];
      const [g] = store.groups.splice(i, 1);
      store.members = store.members.filter(m => !uuidEq(m.group_id, g.id));
      return [pick(g, ['id', 'name'])];
    },
  // listMembers — newest non-empty profile name; signed in = has a user_roles row
  "SELECT m.id, m.member_email, m.added_by_email, m.created_at, (SELECT p.display_name FROM user_profiles p WHERE lower(p.email) = lower(m.member_email) AND coalesce(p.display_name, '') <> '' ORDER BY p.updated_at DESC LIMIT 1) AS display_name, EXISTS (SELECT 1 FROM user_roles r WHERE lower(r.email) = lower(m.member_email)) AS has_signed_in FROM group_members m WHERE m.group_id = $1 ORDER BY lower(m.member_email)":
    ([gid]) => {
      uuidIn(gid);
      return store.members.filter(m => uuidEq(m.group_id, gid))
        .sort((a, b) => lc(a.member_email).localeCompare(lc(b.member_email)))
        .map(m => {
          const prof = store.profiles.filter(p => lc(p.email) === lc(m.member_email) && (p.display_name || '') !== '')
            .sort((a, b) => b.updated_at - a.updated_at)[0];
          return { ...pick(m, MEMBER_RET), display_name: prof ? prof.display_name : null, has_signed_in: store.users.some(u => lc(u.email) === lc(m.member_email)) };
        });
    },
  // addMember — FK to groups(id); ON CONFLICT on group_members_uniq (group_id, lower(member_email))
  'INSERT INTO group_members (group_id, member_email, added_by, added_by_email) VALUES ($1, $2, $3, $4) ON CONFLICT (group_id, lower(member_email)) DO NOTHING RETURNING id, member_email, added_by_email, created_at':
    ([gid, email, addedBy, addedByEmail]) => {
      uuidIn(gid, addedBy);
      if (!store.groups.some(g => uuidEq(g.id, gid))) throw pgErr('23503', 'insert or update on table "group_members" violates foreign key constraint');
      if (isMember(gid, email)) return [];
      const m = { id: crypto.randomUUID(), group_id: gid, member_email: email, added_by: addedBy, added_by_email: addedByEmail, created_at: new Date() };
      store.members.push(m);
      return [pick(m, MEMBER_RET)];
    },
  // addMember's follow-up after a conflict
  'SELECT id, member_email, added_by_email, created_at FROM group_members WHERE group_id = $1 AND lower(member_email) = lower($2)':
    ([gid, email]) => { uuidIn(gid); return store.members.filter(m => uuidEq(m.group_id, gid) && lc(m.member_email) === lc(email)).map(m => pick(m, MEMBER_RET)); },
  // removeMember — scoped to the group in the URL
  'DELETE FROM group_members WHERE id = $1 AND group_id = $2 RETURNING id, member_email':
    ([mid, gid]) => {
      uuidIn(mid, gid);
      const i = store.members.findIndex(m => uuidEq(m.id, mid) && uuidEq(m.group_id, gid));
      return i < 0 ? [] : store.members.splice(i, 1).map(m => pick(m, ['id', 'member_email']));
    },
  // resolveOwnerCandidate — every account using the address
  'SELECT user_id, email, role, disabled_at FROM user_roles WHERE lower(email) = lower($1)':
    ([email]) => store.users.filter(u => lc(u.email) === lc(email)).map(u => ({ ...u })),
  // transferOwner — conditional on the owner the caller was authorised against
  'UPDATE groups SET owner_id = $2, owner_email = $3, updated_at = NOW() WHERE id = $1 AND owner_id IS NOT DISTINCT FROM $4 RETURNING id, name, owner_id, owner_email, created_at':
    ([id, ownerId, ownerEmail, expected]) => {
      uuidIn(id, ownerId, expected);
      const g = store.groups.find(x => uuidEq(x.id, id) && (expected == null ? x.owner_id == null : uuidEq(x.owner_id, expected)));
      if (!g) return [];
      g.owner_id = ownerId; g.owner_email = ownerEmail; g.updated_at = new Date();
      return [pick(g, RET)];
    },
};

// Hooks let a test slip another request's effect in just before a statement runs — the
// way a concurrent request would. Each runs `times` times, then drops out.
let mockHooks = [];
function mockFakeQuery(sql, p = []) {
  const s = sql.replace(/\s+/g, ' ').trim();
  for (const h of mockHooks.filter(x => x.re.test(s))) {
    if (--h.times <= 0) mockHooks = mockHooks.filter(x => x !== h);
    h.fn(p);
  }
  const handler = SQL[s];
  if (!handler) throw new Error('fake db: statement not in the allow-list; verify it against Postgres (integration/groups.pg.test.js), then add it: ' + s.slice(0, 140));
  return handler(p);
}
const interleave = (re, fn, times = 1) => mockHooks.push({ re, fn, times });

jest.mock('../../lib/db', () => ({
  query: jest.fn(async (sql, p) => mockFakeQuery(sql, p)),
  queryOne: jest.fn(async (sql, p) => mockFakeQuery(sql, p)[0] || null),
}));
const mockAppend = jest.fn().mockResolvedValue({});
jest.mock('../../lib/auditLog', () => ({ append: (...a) => mockAppend(...a) }));

let mockUser;
jest.mock('../../middleware/auth', () => (req, _res, next) => { req.user = mockUser; next(); });

// Signed in with addresses Keycloak has verified (membership matches only those).
const RICHARD = { id: '11111111-1111-4111-8111-111111111111', email: 'richard@ptechllc.com', verifiedEmail: 'richard@ptechllc.com', role: 'contributor' };
const DAVE    = { id: '22222222-2222-4222-8222-222222222222', email: 'dave@ptechllc.com', verifiedEmail: 'dave@ptechllc.com', role: 'admin' };
const TAMMY   = { id: '33333333-3333-4333-8333-333333333333', email: 'tammy@ptechllc.com', verifiedEmail: 'tammy@ptechllc.com', role: 'contributor' };
const JACKSON = { id: '44444444-4444-4444-8444-444444444444', email: 'jackson@ptechllc.com', verifiedEmail: 'jackson@ptechllc.com', role: 'contributor' };
const VIEWER  = { id: '55555555-5555-4555-8555-555555555555', email: 'viewer@ptechllc.com', verifiedEmail: 'viewer@ptechllc.com', role: 'viewer' };
// Richard after an admin demoted him — same account, same id.
const RICHARD_DEMOTED = { ...RICHARD, role: 'viewer' };
// A different account that happens to use Richard's address (a recreated sign-in).
const RICHARD_TWIN = { id: '66666666-6666-4666-8666-666666666666', email: RICHARD.email, role: 'contributor' };

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/groups', require('../../routes/groups'));
  return a;
}
const as = (user) => { mockUser = user; return request(app()); };
const snapshot = () => JSON.stringify({ g: store.groups, m: store.members });
const groupRow = (id) => store.groups.find(x => x.id === id);
const events = (type) => mockAppend.mock.calls.map(c => c[0]).filter(e => !type || e.eventType === type);

// Richard (not an admin) owns "Acctg", with Tammy and an outside accountant in it —
// the ParaTech shape that forced owner-managed groups.
async function seedAcctg() {
  const g = (await as(RICHARD).post('/api/groups').send({ name: 'Acctg' })).body;
  await as(RICHARD).post(`/api/groups/${g.id}/members`).send({ email: 'tammy@ptechllc.com' });
  await as(RICHARD).post(`/api/groups/${g.id}/members`).send({ email: 'tim.baudier@dts-tax.com' });
  return g;
}

beforeEach(() => {
  store.groups = []; store.members = []; store.grants = []; mockHooks = [];
  store.users = [RICHARD, DAVE, TAMMY, JACKSON, VIEWER].map(u => ({ user_id: u.id, email: u.email, role: u.role }));
  store.profiles = [
    { email: 'tammy@ptechllc.com', display_name: 'Old Tammy', updated_at: new Date(2026, 0, 1) },
    { email: 'tammy@ptechllc.com', display_name: 'Tammy Richard', updated_at: new Date(2026, 5, 1) },
    { email: 'tammy@ptechllc.com', display_name: '', updated_at: new Date(2026, 8, 1) },
  ];
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
    expect(store.groups).toHaveLength(0);
  });

  test('names are unique regardless of case, so two "All Staff" groups cannot exist', async () => {
    await as(RICHARD).post('/api/groups').send({ name: 'All Staff' });
    expect((await as(TAMMY).post('/api/groups').send({ name: 'all staff' })).status).toBe(409);
  });

  test('a name that only differs by invisible or look-alike characters is the same name', async () => {
    await as(RICHARD).post('/api/groups').send({ name: 'All Staff' });
    for (const lookalike of [
      'All Staff\u200B',       // zero-width space
      'All\u00AD Staff',       // soft hyphen
      '\u202EAll Staff',       // right-to-left override
      'All\tStaff',              // a pasted tab
      '\uFF21ll Staff',        // full-width A
      'All Staff\u034F',       // combining grapheme joiner: invisible, but not \p{C}
      'All Staff\uFE0F',       // variation selector
      'All Staff\u3164',       // Hangul filler
      'All Staff\u{E0100}',      // supplementary variation selector
      'All Staff\u17B4',       // Khmer inherent vowel
      'All\u2800Staff',        // braille blank, which renders as a space
      'All \u200B Staff',      // stripping leaves two spaces, collapsed again
    ]) expect((await as(JACKSON).post('/api/groups').send({ name: lookalike })).status).toBe(409);
    // Stripping must be followed by normalising again: ZWSP + combining acute leaves
    // "Cafe" + U+0301, which renders exactly like the one-code-point "Caf\u00E9".
    await as(RICHARD).post('/api/groups').send({ name: 'Caf\u00E9' });
    expect((await as(JACKSON).post('/api/groups').send({ name: 'Cafe\u200B\u0301' })).status).toBe(409);
    expect(store.groups).toHaveLength(2);
  });

  test('a blank or oversized name is refused', async () => {
    expect((await as(RICHARD).post('/api/groups').send({ name: '   ' })).status).toBe(400);
    expect((await as(RICHARD).post('/api/groups').send({ name: '\u200B\uFE0F' })).status).toBe(400);
    expect((await as(RICHARD).post('/api/groups').send({ name: 'x'.repeat(81) })).status).toBe(400);
    expect((await as(RICHARD).post('/api/groups').send({ name: { a: 1 } })).status).toBe(400);
  });

  test('creation is chained in the audit log', async () => {
    const g = (await as(RICHARD).post('/api/groups').send({ name: 'Acctg' })).body;
    expect(events('group_created')).toEqual([expect.objectContaining({ actorEmail: 'richard@ptechllc.com', detail: `group ${g.id} "Acctg"` })]);
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

  test('the list shows each caller only their own groups, and admins all of them', async () => {
    await seedAcctg();
    await as(JACKSON).post('/api/groups').send({ name: 'IT' });
    const names = async (u) => (await as(u).get('/api/groups')).body.map(g => g.name).sort();
    expect(await names(RICHARD)).toEqual(['Acctg']);
    expect(await names(TAMMY)).toEqual(['Acctg']);
    expect(await names(JACKSON)).toEqual(['IT']);
    expect(await names(DAVE)).toEqual(['Acctg', 'IT']);
    expect(await names(RICHARD_TWIN)).toEqual([]);
  });

  test('every group in the list opens, and every group that opens is in the list', async () => {
    await seedAcctg();
    await as(JACKSON).post('/api/groups').send({ name: 'IT' });
    for (const u of [RICHARD, RICHARD_DEMOTED, RICHARD_TWIN, TAMMY, JACKSON, VIEWER, DAVE]) {
      const listed = (await as(u).get('/api/groups')).body.map(g => g.id).sort();
      const opens = [];
      for (const g of store.groups) if ((await as(u).get(`/api/groups/${g.id}`)).status === 200) opens.push(g.id);
      expect(opens.sort()).toEqual(listed);
    }
  });

  test('a malformed id is a clean 404, never a database error', async () => {
    // The fake refuses non-uuid input the way Postgres does (22P02), so without the
    // shape check in lib/groups.js these would be 500s.
    const g = await seedAcctg();
    for (const bad of ['not-a-uuid', `{${g.id}}`, g.id.replace(/-/g, ''), '1 OR 1=1']) {
      expect((await as(DAVE).get(`/api/groups/${encodeURIComponent(bad)}`)).status).toBe(404);
      expect((await as(DAVE).delete(`/api/groups/${g.id}/members/${encodeURIComponent(bad)}`)).status).toBe(404);
    }
  });
});

// Every mutating route calls the manage check itself, so every route is its own rule.
// Each cell reseeds, and a refused cell must leave the database and the audit log alone.
describe('the manage rule, route by route', () => {
  const ROUTES = {
    'rename':        (g) => ['put', `/api/groups/${g.id}`, { name: 'Renamed' }, 200],
    'delete':        (g) => ['delete', `/api/groups/${g.id}`, null, 200],
    'add member':    (g) => ['post', `/api/groups/${g.id}/members`, { email: 'new@example.com' }, 201],
    'remove member': (g, tim) => ['delete', `/api/groups/${g.id}/members/${tim.id}`, null, 200],
    'handover':      (g) => ['put', `/api/groups/${g.id}/owner`, { email: 'tammy@ptechllc.com' }, 200],
  };
  const CALLERS = [
    ['a member (the takeover case)', TAMMY, 403],
    ['a viewer who is a member', VIEWER, 403],
    ['the owner, demoted to viewer', RICHARD_DEMOTED, 403],
    ['a stranger', JACKSON, 404],
    ["another account using the owner's address", RICHARD_TWIN, 404],
    ['an admin who does not own it', DAVE, 'ok'],
    ['the owner', RICHARD, 'ok'],
  ];
  for (const [route, build] of Object.entries(ROUTES)) {
    for (const [who, user, want] of CALLERS) {
      test(`${route} by ${who}: ${want === 'ok' ? 'allowed' : want}`, async () => {
        const g = await seedAcctg();
        await as(RICHARD).post(`/api/groups/${g.id}/members`).send({ email: VIEWER.email });
        const tim = store.members.find(m => m.member_email === 'tim.baudier@dts-tax.com');
        const [method, url, body, okStatus] = build(g, tim);
        const before = snapshot();
        mockAppend.mockClear();
        const req = as(user)[method](url);
        const res = await (body ? req.send(body) : req);
        if (want === 'ok') {
          expect(res.status).toBe(okStatus);
          expect(mockAppend).toHaveBeenCalledTimes(1);
        } else {
          expect(res.status).toBe(want);
          expect(snapshot()).toBe(before);
          expect(mockAppend).not.toHaveBeenCalled();
        }
      });
    }
  }

  test('a refused caller sees the same answer whatever the request body', async () => {
    const g = await seedAcctg();
    // a body that would be a 400 or 409 for the owner is still just a 404 to a stranger
    expect((await as(JACKSON).put(`/api/groups/${g.id}`).send({ name: '' })).status).toBe(404);
    expect((await as(JACKSON).post(`/api/groups/${g.id}/members`).send({ email: 'nope' })).status).toBe(404);
    expect((await as(TAMMY).put(`/api/groups/${g.id}/owner`).send({ email: 'viewer@ptechllc.com' })).status).toBe(403);
  });
});

describe('who owns a group', () => {
  // Handing a group to somebody who has gone is how it ends up with nobody able to
  // manage it -- the same rule libraries follow.
  test('a group cannot be handed to an account that has been switched off', async () => {
    const g = await seedAcctg();
    store.users.push({ user_id: '77777777-7777-4777-8777-777777777777', email: 'gone@ptechllc.com', role: 'contributor', disabled_at: new Date().toISOString() });
    const res = await as(DAVE).put(`/api/groups/${g.id}/owner`).send({ email: 'gone@ptechllc.com' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/switched off/);
    // an owner who is not an admin is told it cannot be done, not why -- the existing
    // rule, so a group owner cannot use a handover to probe for accounts
    const quiet = await as(RICHARD).put(`/api/groups/${g.id}/owner`).send({ email: 'gone@ptechllc.com' });
    expect([quiet.status, quiet.body.error]).toEqual([400, "gone@ptechllc.com can't own this group. Ask an admin for help."]);
    expect((await as(RICHARD).get(`/api/groups/${g.id}`)).body.owner_email).toBe(RICHARD.email);
  });


  test('an owner demoted to viewer still sees the group, and the list agrees, but loses the controls', async () => {
    const g = await seedAcctg();
    const list = (await as(RICHARD_DEMOTED).get('/api/groups')).body;
    expect(list.map(x => [x.name, x.can_manage])).toEqual([['Acctg', false]]);
    const one = await as(RICHARD_DEMOTED).get(`/api/groups/${g.id}`);
    expect(one.status).toBe(200);
    expect(one.body.can_manage).toBe(false);
  });

  test('a group with no owner is managed by admins only', async () => {
    const id = '77777777-7777-4777-8777-777777777777';
    const now = new Date();
    store.groups.push({ id, name: 'Legacy', owner_id: null, owner_email: null, created_by: null, created_by_email: null, created_at: now, updated_at: now });
    store.members.push({ id: crypto.randomUUID(), group_id: id, member_email: 'tammy@ptechllc.com', added_by_email: null, created_at: now });
    expect((await as(TAMMY).put(`/api/groups/${id}`).send({ name: 'Mine' })).status).toBe(403);
    expect((await as(DAVE).put(`/api/groups/${id}`).send({ name: 'Legacy 2' })).status).toBe(200);
    // and an admin can give it an owner
    expect((await as(DAVE).put(`/api/groups/${id}/owner`).send({ email: 'tammy@ptechllc.com' })).status).toBe(200);
    expect(groupRow(id).owner_id).toBe(TAMMY.id);
  });

  test('an owner id that arrives in upper case is still the owner', async () => {
    // an id with letters in it, so upper-casing actually changes it
    const ABBY = { id: 'abcdef12-3456-4abc-8def-abcdef123456', email: 'abby@ptechllc.com', role: 'contributor' };
    store.users.push({ user_id: ABBY.id, email: ABBY.email, role: ABBY.role });
    const g = (await as(ABBY).post('/api/groups').send({ name: 'Front desk' })).body;
    const shouting = { ...ABBY, id: ABBY.id.toUpperCase() };
    expect(shouting.id).not.toBe(ABBY.id);
    expect((await as(shouting).put(`/api/groups/${g.id}`).send({ name: 'Reception' })).status).toBe(200);
  });

  test('renaming onto an existing name is refused', async () => {
    const g = await seedAcctg();
    await as(RICHARD).post('/api/groups').send({ name: 'GTS' });
    expect((await as(RICHARD).put(`/api/groups/${g.id}`).send({ name: 'gts' })).status).toBe(409);
  });

  test('renaming a group to a different case of its own name is allowed', async () => {
    const g = await seedAcctg();
    expect((await as(RICHARD).put(`/api/groups/${g.id}`).send({ name: 'ACCTG' })).body.name).toBe('ACCTG');
  });

  // Members are removed by ON DELETE CASCADE in the schema, not by the route, and the
  // member upsert needs the (group_id, lower(member_email)) index to exist. A fake that
  // simulated either would keep passing if the migration lost it — so assert on the
  // migration itself (and integration/groups.pg.test.js runs it for real).
  test('the schema cascades group deletion and backs the member upsert with the right index', () => {
    const sql = require('fs').readFileSync(require('path').join(__dirname, '../../migrations/0006_groups.sql'), 'utf8');
    expect(sql).toMatch(/group_id\s+UUID\s+NOT NULL REFERENCES groups\(id\) ON DELETE CASCADE/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS groups_name_lower_uniq ON groups \(lower\(name\)\)/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS group_members_uniq ON group_members \(group_id, lower\(member_email\)\)/);
  });
});

describe('membership', () => {
  test('someone outside the organisation can be added', async () => {
    const g = (await as(RICHARD).post('/api/groups').send({ name: 'VNA' })).body;
    const res = await as(RICHARD).post(`/api/groups/${g.id}/members`).send({ email: 'John.Johnson@VNATexas.org' });
    expect(res.status).toBe(201);
    expect(res.body.member_email).toBe('john.johnson@vnatexas.org');
  });

  test('adding someone twice is harmless, does not duplicate them, and records nothing', async () => {
    const g = await seedAcctg();
    mockAppend.mockClear();
    const res = await as(RICHARD).post(`/api/groups/${g.id}/members`).send({ email: 'TAMMY@ptechllc.com' });
    expect(res.status).toBe(200);
    expect(res.body.already_member).toBe(true);
    expect(store.members.filter(m => m.group_id === g.id)).toHaveLength(2);
    expect(mockAppend).not.toHaveBeenCalled();
  });

  test('a malformed address is refused', async () => {
    const g = await seedAcctg();
    for (const email of ['nope', 'a@b', '"x"@y.com', '<a@b.com>', 'a b@c.com'])
      expect((await as(RICHARD).post(`/api/groups/${g.id}/members`).send({ email })).status).toBe(400);
  });

  test('control, invisible and bidi characters in an address are refused, not a 500', async () => {
    const g = await seedAcctg();
    for (const email of ['a\u0000b@c.com', 'tim\u200B@x.com', '\u202Etim@x.com', 'tim\u034F@x.com', 't\uFE0Fim@x.com', 'tim\u3164@x.com', 'a'.repeat(250) + '@x.com'])
      expect((await as(RICHARD).post(`/api/groups/${g.id}/members`).send({ email })).status).toBe(400);
  });

  test('removing a member is chained once; removing them again is a 404 that records nothing', async () => {
    const g = await seedAcctg();
    const tim = store.members.find(m => m.member_email === 'tim.baudier@dts-tax.com');
    mockAppend.mockClear();
    expect((await as(RICHARD).delete(`/api/groups/${g.id}/members/${tim.id}`)).status).toBe(200);
    expect((await as(RICHARD).delete(`/api/groups/${g.id}/members/${tim.id}`)).status).toBe(404);
    expect(events('group_member_removed').map(e => e.detail)).toEqual([`group ${g.id} "Acctg" - "tim.baudier@dts-tax.com"`]);
  });

  test("a member cannot be removed through a different group's URL", async () => {
    const acctg = await seedAcctg();
    const other = (await as(RICHARD).post('/api/groups').send({ name: 'GTS' })).body;
    const tim = store.members.find(m => m.group_id === acctg.id && m.member_email === 'tim.baudier@dts-tax.com');
    expect((await as(RICHARD).delete(`/api/groups/${other.id}/members/${tim.id}`)).status).toBe(404);
    expect(store.members.some(m => m.id === tim.id)).toBe(true);
  });

  test('deleting a group removes it and chains the deletion once', async () => {
    const g = await seedAcctg();
    mockAppend.mockClear();
    expect((await as(RICHARD).delete(`/api/groups/${g.id}`)).status).toBe(200);
    expect((await as(DAVE).delete(`/api/groups/${g.id}`)).status).toBe(404);
    expect(groupRow(g.id)).toBeUndefined();
    expect(events('group_deleted').map(e => e.detail)).toEqual([`group ${g.id} "Acctg", 2 member(s), 0 share(s) removed`]);
  });

  test('deleting a group records the shares that went with it, and managers see the count first', async () => {
    const g = await seedAcctg();
    store.grants.push({ group_id: g.id }, { group_id: g.id });
    expect((await as(RICHARD).get(`/api/groups/${g.id}`)).body.share_count).toBe(2);
    expect((await as(TAMMY).get(`/api/groups/${g.id}`)).body.share_count).toBeUndefined(); // members don't see it
    mockAppend.mockClear();
    expect((await as(RICHARD).delete(`/api/groups/${g.id}`)).status).toBe(200);
    expect(events('group_deleted')[0].detail).toMatch(/, 2 member\(s\), 2 share\(s\) removed$/);
  });
});

// A group now carries access, so belonging is by VERIFIED address: an account that
// merely claims a member's address sees nothing of the group.
describe('membership by verified address', () => {
  test("an account claiming a member's address, unverified, neither lists nor opens the group", async () => {
    const g = await seedAcctg();
    const CLAIMANT = { id: '77777777-7777-4777-8777-777777777777', email: TAMMY.email, verifiedEmail: null, role: 'contributor' };
    expect((await as(CLAIMANT).get('/api/groups')).body).toEqual([]);
    expect((await as(CLAIMANT).get(`/api/groups/${g.id}`)).status).toBe(404);
    expect((await as(TAMMY).get(`/api/groups/${g.id}`)).status).toBe(200);
  });
});

describe('what members see', () => {
  test('the owner sees who has signed in, and the newest name a person has set', async () => {
    const g = await seedAcctg();
    const rows = (await as(RICHARD).get(`/api/groups/${g.id}/members`)).body;
    const tammy = rows.find(r => r.member_email === 'tammy@ptechllc.com');
    const tim = rows.find(r => r.member_email === 'tim.baudier@dts-tax.com');
    expect(tammy).toEqual(expect.objectContaining({ display_name: 'Tammy Richard', has_signed_in: true, added_by_email: 'richard@ptechllc.com' }));
    expect(tim).toEqual(expect.objectContaining({ display_name: null, has_signed_in: false }));
    expect(tim.id).toBeTruthy();
    expect((await as(RICHARD).get(`/api/groups/${g.id}`)).body.created_by_email).toBe('richard@ptechllc.com');
  });

  test("a member, possibly an outside contact, sees names and addresses but not the owner's working detail", async () => {
    const g = await seedAcctg();
    const rows = (await as(TAMMY).get(`/api/groups/${g.id}/members`)).body;
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(Object.keys(r).sort()).toEqual(['display_name', 'member_email']);
    const one = (await as(TAMMY).get(`/api/groups/${g.id}`)).body;
    expect(one).not.toHaveProperty('created_by');
    expect(one).not.toHaveProperty('created_by_email');
    expect(one.can_manage).toBe(false);
  });
});

describe('handing a group over', () => {
  test('the owner can give it to someone who has signed in, and loses the controls', async () => {
    const g = await seedAcctg();
    mockAppend.mockClear();
    const res = await as(RICHARD).put(`/api/groups/${g.id}/owner`).send({ email: 'Tammy@PTechLLC.com' });
    expect(res.status).toBe(200);
    expect(res.body.owner_email).toBe('tammy@ptechllc.com');
    expect(res.body.can_manage).toBe(false);
    expect(events('group_owner_changed').map(e => e.detail)).toEqual([`group ${g.id} "Acctg" owner "richard@ptechllc.com" ${ARROW} "tammy@ptechllc.com"`]);
  });

  test('it cannot go to someone who has never signed in', async () => {
    const g = await seedAcctg();
    const res = await as(RICHARD).put(`/api/groups/${g.id}/owner`).send({ email: 'tim.baudier@dts-tax.com' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/hasn't signed in/);
  });

  test('a non-admin is told only that the handover cannot happen, whatever the reason', async () => {
    const g = await seedAcctg();
    // two accounts share Jackson's address (a recreated sign-in)
    store.users.push({ user_id: '88888888-8888-4888-8888-888888888888', email: 'jackson@ptechllc.com', role: 'contributor' });
    const toViewer = await as(RICHARD).put(`/api/groups/${g.id}/owner`).send({ email: 'viewer@ptechllc.com' });
    const toTwin = await as(RICHARD).put(`/api/groups/${g.id}/owner`).send({ email: 'jackson@ptechllc.com' });
    expect(toViewer.status).toBe(400);
    expect(toTwin.status).toBe(400);
    expect(toViewer.body.error.replace('viewer@ptechllc.com', 'X')).toBe(toTwin.body.error.replace('jackson@ptechllc.com', 'X'));
    expect(toViewer.body.error).not.toMatch(/view files|more than one|account/i);
    expect(groupRow(g.id).owner_id).toBe(RICHARD.id);
  });

  test('an admin gets the exact reason, to be able to fix it', async () => {
    const g = await seedAcctg();
    store.users.push({ user_id: '88888888-8888-4888-8888-888888888888', email: 'jackson@ptechllc.com', role: 'contributor' });
    const toViewer = await as(DAVE).put(`/api/groups/${g.id}/owner`).send({ email: 'viewer@ptechllc.com' });
    const toTwin = await as(DAVE).put(`/api/groups/${g.id}/owner`).send({ email: 'jackson@ptechllc.com' });
    expect(toViewer.status).toBe(400);
    expect(toViewer.body.error).toMatch(/only view files/);
    expect(toTwin.status).toBe(409);
    expect(toTwin.body.error).toMatch(/More than one Depot account/);
  });

  test('every refused handover is chained with its reason, so probing shows up', async () => {
    const g = await seedAcctg();
    store.users.push({ user_id: '88888888-8888-4888-8888-888888888888', email: 'jackson@ptechllc.com', role: 'viewer' });
    mockAppend.mockClear();
    await as(RICHARD).put(`/api/groups/${g.id}/owner`).send({ email: 'viewer@ptechllc.com' });
    await as(RICHARD).put(`/api/groups/${g.id}/owner`).send({ email: 'jackson@ptechllc.com' });
    await as(RICHARD).put(`/api/groups/${g.id}/owner`).send({ email: 'nobody@example.com' });
    expect(events('group_owner_change_refused').map(e => e.detail)).toEqual([
      `group ${g.id} "Acctg" ${ARROW} "viewer@ptechllc.com": viewer`,
      // one of the two accounts is a viewer: still ambiguous, never quietly the contributor
      `group ${g.id} "Acctg" ${ARROW} "jackson@ptechllc.com": ambiguous`,
      `group ${g.id} "Acctg" ${ARROW} "nobody@example.com": unknown`,
    ]);
    expect(events('group_owner_changed')).toEqual([]);
  });

  test('handing it to the person who already owns it changes and records nothing', async () => {
    const g = await seedAcctg();
    mockAppend.mockClear();
    const res = await as(RICHARD).put(`/api/groups/${g.id}/owner`).send({ email: 'richard@ptechllc.com' });
    expect(res.status).toBe(200);
    expect(res.body.can_manage).toBe(true);
    expect(mockAppend).not.toHaveBeenCalled();
  });

  test('renaming a group to the name it already has records nothing', async () => {
    const g = await seedAcctg();
    mockAppend.mockClear();
    expect((await as(RICHARD).put(`/api/groups/${g.id}`).send({ name: ' Acctg ' })).status).toBe(200);
    expect(mockAppend).not.toHaveBeenCalled();
  });
});

describe('audit entries', () => {
  test('lead with the group id and quote names, so a crafted name cannot pose as another group', async () => {
    const payroll = (await as(RICHARD).post('/api/groups').send({ name: 'Payroll' })).body;
    const fake = (await as(JACKSON).post('/api/groups').send({ name: `Payroll (${payroll.id})` })).body;
    mockAppend.mockClear();
    await as(JACKSON).post(`/api/groups/${fake.id}/members`).send({ email: 'mallory@evil.example' });
    expect(events('group_member_added').map(e => e.detail)).toEqual([`group ${fake.id} "Payroll (${payroll.id})" + "mallory@evil.example"`]);
  });

  test('two different renames never record the same text', async () => {
    const a = (await as(RICHARD).post('/api/groups').send({ name: 'Q1' })).body;
    const b = (await as(RICHARD).post('/api/groups').send({ name: `Q1 ${ARROW} Q2` })).body;
    mockAppend.mockClear();
    await as(RICHARD).put(`/api/groups/${a.id}`).send({ name: `Q2 ${ARROW} Q3` });
    await as(RICHARD).put(`/api/groups/${b.id}`).send({ name: 'Q3' });
    const [d1, d2] = events('group_renamed').map(e => e.detail.replace(/^group \S+ /, ''));
    expect(d1).toBe(`"Q1" ${ARROW} "Q2 ${ARROW} Q3"`);
    expect(d2).toBe(`"Q1 ${ARROW} Q2" ${ARROW} "Q3"`);
  });

  test('records the stored address, not the raw request', async () => {
    const g = await seedAcctg();
    mockAppend.mockClear();
    await as(RICHARD).post(`/api/groups/${g.id}/members`).send({ email: '  New.Person@Example.COM ' });
    expect(events('group_member_added').map(e => e.detail)).toEqual([`group ${g.id} "Acctg" + "new.person@example.com"`]);
  });

  test('a failing audit write is logged but does not fail the change that succeeded', async () => {
    mockAppend.mockRejectedValue(new Error('chain locked'));
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await as(RICHARD).post('/api/groups').send({ name: 'Acctg' });
    expect(res.status).toBe(201);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('audit group_created failed'), 'chain locked');
    spy.mockRestore();
  });
});

// Each test slips another request's effect in just before a statement runs, the way a
// concurrent request would.
describe('changes that race each other', () => {
  test('a handover authorised before an admin took the group away does not undo it', async () => {
    const g = await seedAcctg();
    mockAppend.mockClear();
    // Richard's handover to Jackson passes the check; the admin's handover to Tammy lands first.
    interleave(/^UPDATE groups SET owner_id/, () => Object.assign(groupRow(g.id), { owner_id: TAMMY.id, owner_email: TAMMY.email }));
    const res = await as(RICHARD).put(`/api/groups/${g.id}/owner`).send({ email: 'jackson@ptechllc.com' });
    expect(res.status).toBe(409);
    expect(groupRow(g.id).owner_email).toBe('tammy@ptechllc.com');
    expect(events('group_owner_changed')).toEqual([]);
  });

  test('a rename that lands after someone else renamed the group is refused, not applied', async () => {
    const g = await seedAcctg();
    interleave(/^UPDATE groups SET name/, () => { groupRow(g.id).name = 'Finance'; });
    expect((await as(RICHARD).put(`/api/groups/${g.id}`).send({ name: 'Accounting' })).status).toBe(409);
    expect(groupRow(g.id).name).toBe('Finance');
  });

  test.each([
    ['rename', /^UPDATE groups SET name/, (id) => as(RICHARD).put(`/api/groups/${id}`).send({ name: 'Renamed' })],
    ['handover', /^UPDATE groups SET owner_id/, (id) => as(RICHARD).put(`/api/groups/${id}/owner`).send({ email: 'tammy@ptechllc.com' })],
    ['member add', /^INSERT INTO group_members/, (id) => as(RICHARD).post(`/api/groups/${id}/members`).send({ email: 'new@example.com' })],
    ['member removal', /^DELETE FROM group_members/, (id) => as(RICHARD).delete(`/api/groups/${id}/members/${store.members.find(m => m.group_id === id).id}`)],
    ['delete', /^DELETE FROM groups/, (id) => as(RICHARD).delete(`/api/groups/${id}`)],
  ])('a group deleted by someone else during a %s answers 404 and records nothing', async (_label, write, call) => {
    const g = await seedAcctg();
    mockAppend.mockClear();
    interleave(write, () => {
      store.groups = store.groups.filter(x => x.id !== g.id);
      store.members = store.members.filter(m => m.group_id !== g.id);
    });
    expect((await call(g.id)).status).toBe(404);
    expect(mockAppend).not.toHaveBeenCalled();
  });

  test('someone removed at the same moment they are re-added ends up in the group', async () => {
    const g = await seedAcctg();
    // the INSERT conflicts on Tammy's row; a concurrent removal deletes it before the follow-up SELECT
    interleave(/^SELECT id, member_email, added_by_email, created_at FROM group_members/, () => {
      store.members = store.members.filter(m => !(m.group_id === g.id && m.member_email === 'tammy@ptechllc.com'));
    });
    const res = await as(RICHARD).post(`/api/groups/${g.id}/members`).send({ email: 'tammy@ptechllc.com' });
    expect(res.status).toBe(201);
    expect(store.members.filter(m => m.group_id === g.id && m.member_email === 'tammy@ptechllc.com')).toHaveLength(1);
  });

  test('if their row keeps vanishing, the answer is "try again", not "group not found"', async () => {
    const g = await seedAcctg();
    const tammy = store.members.find(m => m.member_email === 'tammy@ptechllc.com');
    interleave(/^INSERT INTO group_members/, () => { if (!store.members.includes(tammy)) store.members.push(tammy); }, 2);
    interleave(/^SELECT id, member_email, added_by_email, created_at FROM group_members/, () => { store.members = store.members.filter(m => m !== tammy); }, 2);
    const res = await as(RICHARD).post(`/api/groups/${g.id}/members`).send({ email: 'tammy@ptechllc.com' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Try again/);
  });

  test('two renames that deadlock on the name index are a 409 to retry, not a 500', async () => {
    const g = await seedAcctg();
    interleave(/^UPDATE groups SET name/, () => { throw pgErr('40P01', 'deadlock detected'); });
    expect((await as(RICHARD).put(`/api/groups/${g.id}`).send({ name: 'Accounting' })).status).toBe(409);
  });

  test('the fake refuses a statement it does not know, so SQL edits cannot slip past these tests', () => {
    expect(() => mockFakeQuery('SELECT * FROM groups')).toThrow(/allow-list/);
  });
});

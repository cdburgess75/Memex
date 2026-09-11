'use strict';
// Groups against a REAL, THROWAWAY Postgres: the real base schema a box starts from
// (postgres/init/01_schema.sql), the real migration runner, the real routes and lib, and
// the real audit chain. This is what checks the statements in lib/groups.js actually do —
// the visibility and scoping rules in their WHERE clauses, the unique indexes, ON
// CONFLICT, the foreign key, the conditional writes. The route suite's fake can only pin
// those statements by their text.
//
// It DROPS AND RECREATES THE WHOLE public SCHEMA, so it refuses to run unless the
// database name contains "test":
//
//   createdb memex_groups_test
//   MEMEX_TEST_PG_URL=postgres://user:pass@localhost:5432/memex_groups_test \
//     npx jest integration/groups.pg
//
// Without MEMEX_TEST_PG_URL the suite is skipped (normal CI / sandbox).
const fs = require('fs');
const path = require('path');

const PG = process.env.MEMEX_TEST_PG_URL;
const suite = PG ? describe : describe.skip;
// Migrations and the first connection can outlast Jest's 5 s default on a slow runner.
if (PG) jest.setTimeout(30000);

let mockUser;
jest.mock('../../middleware/auth', () => (req, _res, next) => { req.user = mockUser; next(); });

// Signed in with addresses Keycloak has verified (group membership matches only those).
const RICHARD = { id: '11111111-1111-4111-8111-111111111111', email: 'richard@ptechllc.com', verifiedEmail: 'richard@ptechllc.com', role: 'contributor' };
const DAVE    = { id: '22222222-2222-4222-8222-222222222222', email: 'dave@ptechllc.com', verifiedEmail: 'dave@ptechllc.com', role: 'admin' };
const TAMMY   = { id: '33333333-3333-4333-8333-333333333333', email: 'tammy@ptechllc.com', verifiedEmail: 'tammy@ptechllc.com', role: 'contributor' };
const JACKSON = { id: '44444444-4444-4444-8444-444444444444', email: 'jackson@ptechllc.com', verifiedEmail: 'jackson@ptechllc.com', role: 'contributor' };
const VIEWER  = { id: '55555555-5555-4555-8555-555555555555', email: 'viewer@ptechllc.com', verifiedEmail: 'viewer@ptechllc.com', role: 'viewer' };
const RICHARD_DEMOTED = { ...RICHARD, role: 'viewer' };
const RICHARD_TWIN = { id: '66666666-6666-4666-8666-666666666666', email: RICHARD.email, role: 'contributor' };

suite('groups against real Postgres', () => {
  let db, groups, auditLog, migrations, request, app;
  const as = (u) => { mockUser = u; return request(app); };
  const reset = () => db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const count = async (sql, p = []) => (await db.queryOne(sql, p)).n;

  async function seed() {
    const acctg = (await as(RICHARD).post('/api/groups').send({ name: 'Acctg' })).body;
    await as(RICHARD).post(`/api/groups/${acctg.id}/members`).send({ email: 'tammy@ptechllc.com' });
    await as(RICHARD).post(`/api/groups/${acctg.id}/members`).send({ email: 'tim.baudier@dts-tax.com' });
    const it = (await as(JACKSON).post('/api/groups').send({ name: 'IT' })).body;
    await as(JACKSON).post(`/api/groups/${it.id}/members`).send({ email: 'jackson.helper@example.com' });
    return { acctg, it };
  }

  beforeAll(async () => {
    const dbName = decodeURIComponent(new URL(PG).pathname.slice(1));
    if (!/test/i.test(dbName)) throw new Error(`refusing to run: "${dbName}" does not look like a throwaway test database`);
    process.env.DATABASE_URL = PG;
    db = require('../../lib/db');
    await reset();
    await db.query(fs.readFileSync(path.join(__dirname, '../../../postgres/init/01_schema.sql'), 'utf8'));
    migrations = require('../../lib/migrations');
    groups = require('../../lib/groups');
    auditLog = require('../../lib/auditLog');
    request = require('supertest');
    const express = require('express');
    app = express();
    app.use(express.json());
    app.use('/api/groups', require('../../routes/groups'));
  });

  afterAll(async () => {
    try { await reset(); } catch { /* best effort */ }
    try { await db.end(); } catch { /* pool may already be closed */ }
  });

  test('every migration applies on the real base schema, and running again changes nothing', async () => {
    const first = await migrations.run();
    expect(first.applied).toContain('0006_groups.sql');
    expect((await migrations.run()).applied).toEqual([]);
    // and the file itself is idempotent, for a box that ran it by hand
    await db.query(fs.readFileSync(path.join(__dirname, '../../migrations/0006_groups.sql'), 'utf8'));
    for (const u of [RICHARD, DAVE, TAMMY, JACKSON, VIEWER])
      await db.query('INSERT INTO user_roles (user_id, email, role) VALUES ($1, $2, $3)', [u.id, u.email, u.role]);
    // three profiles share Tammy's address: an old name, the current one, and a newer blank one
    await db.query(`INSERT INTO user_profiles (user_id, email, display_name, updated_at) VALUES
      ($1, 'tammy@ptechllc.com', 'Old Tammy', NOW() - interval '2 days'),
      ($2, 'TAMMY@ptechllc.com', 'Tammy Richard', NOW() - interval '1 day'),
      ($3, 'tammy@ptechllc.com', '', NOW())`,
      [TAMMY.id, '31313131-3131-4131-8131-313131313131', '32323232-3232-4232-8232-323232323232']);
  });

  describe('with Acctg (Richard) and IT (Jackson)', () => {
    let acctg, it;
    beforeEach(async () => {
      await db.query('TRUNCATE groups CASCADE');
      ({ acctg, it } = await seed());
    });

    test('each caller is listed exactly the groups they own or belong to; admins all', async () => {
      const names = async (u) => (await as(u).get('/api/groups')).body.map(g => `${g.name}:${g.can_manage}`).sort();
      expect(await names(RICHARD)).toEqual(['Acctg:true']);
      expect(await names(TAMMY)).toEqual(['Acctg:false']);
      expect(await names(JACKSON)).toEqual(['IT:true']);
      expect(await names(DAVE)).toEqual(['Acctg:true', 'IT:true']);
      expect(await names(VIEWER)).toEqual([]);
      expect(await names(RICHARD_TWIN)).toEqual([]);
      expect(await names(RICHARD_DEMOTED)).toEqual(['Acctg:false']);
    });

    test('every listed group opens, and nothing else does', async () => {
      for (const u of [RICHARD, RICHARD_DEMOTED, RICHARD_TWIN, TAMMY, JACKSON, VIEWER, DAVE]) {
        const listed = (await as(u).get('/api/groups')).body.map(g => g.id).sort();
        const opens = [];
        for (const g of [acctg, it]) if ((await as(u).get(`/api/groups/${g.id}`)).status === 200) opens.push(g.id);
        expect(opens.sort()).toEqual(listed);
      }
    });

    test('refused callers change nothing', async () => {
      const before = await db.query('SELECT * FROM groups g LEFT JOIN group_members m ON m.group_id = g.id ORDER BY g.name, m.member_email');
      expect((await as(TAMMY).put(`/api/groups/${acctg.id}/owner`).send({ email: 'tammy@ptechllc.com' })).status).toBe(403);
      expect((await as(RICHARD_DEMOTED).post(`/api/groups/${acctg.id}/members`).send({ email: 'x@example.com' })).status).toBe(403);
      expect((await as(JACKSON).put(`/api/groups/${acctg.id}`).send({ name: 'Mine' })).status).toBe(404);
      expect((await as(RICHARD_TWIN).delete(`/api/groups/${acctg.id}`)).status).toBe(404);
      expect(await db.query('SELECT * FROM groups g LEFT JOIN group_members m ON m.group_id = g.id ORDER BY g.name, m.member_email')).toEqual(before);
    });

    test('a member cannot be removed through another group, and a delete takes only its own group', async () => {
      const tim = await db.queryOne("SELECT id FROM group_members WHERE member_email = 'tim.baudier@dts-tax.com'");
      expect((await as(DAVE).delete(`/api/groups/${it.id}/members/${tim.id}`)).status).toBe(404);
      expect(await count('SELECT count(*)::int AS n FROM group_members WHERE id = $1', [tim.id])).toBe(1);
      expect((await as(RICHARD).delete(`/api/groups/${acctg.id}`)).status).toBe(200);
      expect(await count('SELECT count(*)::int AS n FROM group_members WHERE group_id = $1', [acctg.id])).toBe(0);
      expect(await count('SELECT count(*)::int AS n FROM groups WHERE id = $1', [it.id])).toBe(1);
      expect(await count('SELECT count(*)::int AS n FROM group_members WHERE group_id = $1', [it.id])).toBe(1);
    });

    test('names are unique through case and invisible characters; a group may change its own case', async () => {
      for (const n of ['acctg', 'ACCTG', 'Acctg\u200B', '\uFF21cctg', 'Acctg\u034F', 'Acctg\uFE0F', 'Ac\u00ADctg'])
        expect((await as(TAMMY).post('/api/groups').send({ name: n })).status).toBe(409);
      expect((await as(JACKSON).put(`/api/groups/${it.id}`).send({ name: 'acctg' })).status).toBe(409);
      expect((await as(RICHARD).put(`/api/groups/${acctg.id}`).send({ name: 'ACCTG' })).status).toBe(200);
    });

    test('adding someone twice in another letter case finds the same row', async () => {
      const res = await as(RICHARD).post(`/api/groups/${acctg.id}/members`).send({ email: 'TAMMY@PTECHLLC.COM' });
      expect(res.status).toBe(200);
      expect(res.body.already_member).toBe(true);
      expect(await count('SELECT count(*)::int AS n FROM group_members WHERE group_id = $1', [acctg.id])).toBe(2);
    });

    test('adding to a group that has just been deleted is refused by the foreign key, cleanly', async () => {
      await db.query('DELETE FROM groups WHERE id = $1', [acctg.id]);
      expect(await groups.addMember(acctg.id, { email: 'late@example.com', user: RICHARD })).toEqual({ member: null, added: false });
    });

    test('renames and handovers only land on the group the caller was authorised against', async () => {
      expect(await groups.renameGroup(acctg.id, 'Accounting', 'Some older name')).toBeNull();
      expect(await groups.transferOwner(acctg.id, { ownerId: TAMMY.id, ownerEmail: TAMMY.email, expectedOwnerId: JACKSON.id })).toBeNull();
      expect(await db.queryOne('SELECT name, owner_id FROM groups WHERE id = $1', [acctg.id])).toEqual({ name: 'Acctg', owner_id: RICHARD.id });
      // an ownerless group can still be handed over (IS NOT DISTINCT FROM NULL)
      await db.query('UPDATE groups SET owner_id = NULL, owner_email = NULL WHERE id = $1', [it.id]);
      const r = await groups.transferOwner(it.id, { ownerId: TAMMY.id, ownerEmail: TAMMY.email, expectedOwnerId: null });
      expect(r.owner_id).toBe(TAMMY.id);
    });

    test('the owner sees one row per member with the newest non-blank name; a member sees names and addresses only', async () => {
      const full = (await as(RICHARD).get(`/api/groups/${acctg.id}/members`)).body;
      expect(full).toHaveLength(2);
      expect(full.find(r => r.member_email === 'tammy@ptechllc.com')).toEqual(expect.objectContaining({ display_name: 'Tammy Richard', has_signed_in: true }));
      expect(full.find(r => r.member_email === 'tim.baudier@dts-tax.com')).toEqual(expect.objectContaining({ display_name: null, has_signed_in: false }));
      const trimmed = (await as(TAMMY).get(`/api/groups/${acctg.id}/members`)).body;
      expect(trimmed.map(r => Object.keys(r).sort().join(','))).toEqual(['display_name,member_email', 'display_name,member_email']);
    });

    test('a handover to an address two accounts share is refused, even when one of them is a viewer', async () => {
      await db.query('INSERT INTO user_roles (user_id, email, role) VALUES ($1, $2, $3)', ['88888888-8888-4888-8888-888888888888', 'JACKSON@ptechllc.com', 'viewer']);
      try {
        expect((await as(DAVE).put(`/api/groups/${acctg.id}/owner`).send({ email: 'jackson@ptechllc.com' })).status).toBe(409);
        expect((await db.queryOne('SELECT owner_id FROM groups WHERE id = $1', [acctg.id])).owner_id).toBe(RICHARD.id);
      } finally {
        await db.query('DELETE FROM user_roles WHERE user_id = $1', ['88888888-8888-4888-8888-888888888888']);
      }
    });

    test('malformed ids are a 404, never a uuid error; an upper-case id still resolves', async () => {
      for (const bad of ['not-a-uuid', `{${acctg.id}}`, acctg.id.replace(/-/g, '')])
        expect((await as(DAVE).get(`/api/groups/${encodeURIComponent(bad)}`)).status).toBe(404);
      expect((await as(DAVE).get(`/api/groups/${acctg.id.toUpperCase()}`)).status).toBe(200);
    });

    test('every change lands in the tamper-evident chain with quoted, id-first details', async () => {
      await as(RICHARD).put(`/api/groups/${acctg.id}`).send({ name: 'Accounting' });
      const rows = await db.query("SELECT event_type, detail FROM document_events WHERE event_type LIKE 'group_%' ORDER BY chain_seq DESC LIMIT 2");
      expect(rows[0]).toEqual({ event_type: 'group_renamed', detail: `group ${acctg.id} "Acctg" \u2192 "Accounting"` });
      expect((await auditLog.verify()).ok).toBe(true);
    });
  });
});

'use strict';
// Everyone gets a library of their own, and things land in it -- against a REAL,
// THROWAWAY Postgres.
//
// Depot has had two ideas of "private" side by side: a library you own and have not
// shared, and a file marked personal hiding inside somebody else's library. From here the
// LIBRARY is the unit of privacy: each person has one, it is where anything they upload
// lands when they have not said where, and the personal-file flag stays only for what is
// already stored.
//
//   MEMEX_TEST_PG_URL=postgres://user:pass@localhost:5432/memex_piece5_test \
//     npx jest --runInBand integration/personalLibraries.pg
const fs = require('fs');
const path = require('path');

const PG = process.env.MEMEX_TEST_PG_URL;
const suite = PG ? describe : describe.skip;
if (PG) jest.setTimeout(180000);

jest.mock('../../lib/auditLog', () => ({ append: jest.fn(async () => ({})) }));
// Signing in is real apart from the signature: the token says whatever the test says.
jest.mock('jsonwebtoken');
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn(() => ({ getSigningKey: async () => ({ getPublicKey: () => 'k' }) })) }));

const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const DAVE = { id: U(2), email: 'dave@ptechllc.com', role: 'contributor' };
const JACK = { id: U(3), email: 'jackson@ptechllc.com', role: 'contributor' };
const LOOKER = { id: U(4), email: 'looker@ptechllc.com', role: 'viewer' };

suite('a library of your own', () => {
  let db, libraries;
  const reset = () => db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const migrate = async () => {
    await db.query(fs.readFileSync(path.join(__dirname, '../../../postgres/init/01_schema.sql'), 'utf8'));
    await require('../../lib/migrations').run();
  };

  beforeAll(async () => {
    const dbName = decodeURIComponent(new URL(PG).pathname.slice(1));
    if (!/test/i.test(dbName)) throw new Error(`refusing to run: "${dbName}" does not look like a throwaway test database`);
    process.env.DATABASE_URL = PG;
    db = require('../../lib/db');
    libraries = require('../../lib/libraries');
  });

  afterAll(async () => {
    try { await reset(); } catch { /* best effort */ }
    try { await db.end(); } catch { /* already closed */ }
  });

  const mine = (userId) => db.query('SELECT name, personal, owner_email FROM libraries WHERE owner_id = $1 ORDER BY created_at', [userId]);

  test('the migration gives everyone who has already signed in one, named after them', async () => {
    await reset();
    // people exist BEFORE the migration runs -- this is the shape of a live box
    await db.query(fs.readFileSync(path.join(__dirname, '../../../postgres/init/01_schema.sql'), 'utf8'));
    // verified_email arrives in a later migration, so a pre-migration box has none
    for (const p of [DAVE, JACK, LOOKER]) {
      await db.query('INSERT INTO user_roles (user_id, email, role) VALUES ($1, $2, $3)', [p.id, p.email, p.role]);
    }
    await db.query('INSERT INTO user_profiles (user_id, email, display_name) VALUES ($1, $2, $3)', [JACK.id, JACK.email, 'Jackson Reed']);
    await require('../../lib/migrations').run();

    expect(await mine(DAVE.id)).toEqual([{ name: 'dave', personal: true, owner_email: DAVE.email }]);
    // a display name is used where one is known
    expect(await mine(JACK.id)).toEqual([{ name: 'Jackson Reed', personal: true, owner_email: JACK.email }]);
    // somebody who can only look at files is skipped: they could never put anything in it
    expect(await mine(LOOKER.id)).toEqual([]);
  });

  test('running it again changes nothing', async () => {
    const before = await db.query('SELECT id FROM libraries ORDER BY id');
    await require('../../lib/migrations').run();
    expect(await db.query('SELECT id FROM libraries ORDER BY id')).toEqual(before);
  });

  test('nobody can end up with two, however hard you try', async () => {
    // the app's own path is conditional on the same unique index the migration relies on
    expect(await libraries.ensurePersonalLibrary(DAVE, 'Dave Again')).toBeNull();
    await expect(db.query(
      `INSERT INTO libraries (name, owner_id, owner_email, personal) VALUES ('sneaky', $1, $2, true)`, [DAVE.id, DAVE.email]
    )).rejects.toThrow(/duplicate key|unique/i);
    expect((await mine(DAVE.id)).length).toBe(1);
  });

  test('somebody new gets one the first time they are seen', async () => {
    const NEW = { id: U(9), email: 'newbie@ptechllc.com', role: 'contributor' };
    await db.query('INSERT INTO user_roles (user_id, email, role, verified_email) VALUES ($1, $2, $3, $2)', [NEW.id, NEW.email, NEW.role]);
    const made = await libraries.ensurePersonalLibrary(NEW, null);
    expect(made).toMatchObject({ name: 'newbie' });
    expect(await mine(NEW.id)).toEqual([{ name: 'newbie', personal: true, owner_email: NEW.email }]);
    // and a viewer still gets nothing
    expect(await libraries.ensurePersonalLibrary({ ...NEW, id: U(10), role: 'viewer' }, null)).toBeNull();
  });

  test('a request that names no library lands in the person\'s own, not in a shared one', async () => {
    // the shared library is older, which is exactly what the old rule would have picked
    const shared = (await db.query(
      `INSERT INTO libraries (name, owner_id, owner_email, created_at) VALUES ('Company Files', $1, $2, NOW() - interval '1 year') RETURNING id`,
      [DAVE.id, DAVE.email]))[0].id;
    const oldest = (await db.query('SELECT id FROM libraries ORDER BY created_at ASC LIMIT 1'))[0].id;
    expect(oldest).toBe(shared);

    const daves = (await db.query('SELECT id FROM libraries WHERE owner_id = $1 AND personal', [DAVE.id]))[0].id;
    expect(await libraries.defaultLibraryFor(DAVE)).toBe(daves);
    expect(await libraries.defaultLibraryFor(JACK)).not.toBe(daves);
    // no person at all (a link with no creator, a background job) falls back to the oldest
    expect(await libraries.defaultLibraryFor(null)).toBe(shared);
    // and so does somebody with none of their own
    expect(await libraries.defaultLibraryFor(LOOKER)).toBe(shared);
  });

  // The destination of a move or a copy counts too. Left at "the install's oldest
  // library" it is the seeded one -- which is the SHARED one on every box -- so a request
  // that forgot to name a destination would quietly publish a folder company-wide.
  test('a move or copy with no destination named goes to the person\'s own library', async () => {
    const src = fs.readFileSync(path.join(__dirname, '../../routes/files/folders.js'), 'utf8');
    expect(src).not.toMatch(/defaultLibraryId\(\)/);
    const moveAndCopy = [...src.matchAll(/req\.body\?\.library_id \|\| \(await libraries\.(\w+)\(([^)]*)\)\)/g)];
    expect(moveAndCopy.length).toBeGreaterThanOrEqual(2);
    for (const m of moveAndCopy) expect([m[1], m[2]]).toEqual(['defaultLibraryFor', 'req.user']);
  });

  test('a personal library is private: nobody else gets in, and it is not listed to them', async () => {
    const documentAccess = require('../../lib/documentAccess');
    const daves = (await db.query('SELECT id FROM libraries WHERE owner_id = $1 AND personal', [DAVE.id]))[0].id;
    await db.query(
      `INSERT INTO documents (name, size, mime_type, storage_path, uploaded_by, uploaded_by_email, library_id, library_scoped)
       VALUES ('notes.txt', 9, 'text/plain', 's/1', $1, $2, $3, true)`, [DAVE.id, DAVE.email, daves]);
    const canRead = async (who) => !!(await db.queryOne(
      `SELECT 1 FROM documents d WHERE d.library_id = $1 AND ${documentAccess.condition('d', 2)}`,
      [daves, ...documentAccess.userParams({ ...who, emailVerified: true }, 'read')]));
    expect(await canRead(DAVE)).toBe(true);
    expect(await canRead(JACK)).toBe(false);
    const listed = await libraries.listLibraries({ ...JACK, emailVerified: true });
    expect(listed.map(l => String(l.id))).not.toContain(String(daves));
  });

  /* Somebody who could not add files, and now can.
   *
   * A viewer has no library of their own, and for a long time the only thing that made one
   * was the step auth runs on a FIRST sign-in. So somebody made a contributor later, or
   * given a role by an administrator before they ever signed in, never got one -- and
   * anything they uploaded without naming a library went to the install's shared default.
   * Through the real admin and library routers and the real auth middleware, as the server
   * mounts them.
   */
  describe('promoted, or given a role before signing in', () => {
    let request, app, jwt;
    const ADMIN = { id: U(20), email: 'admin@ptechllc.com' };
    const VERA = { id: U(21), email: 'vera@ptechllc.com' };            // a viewer, about to be promoted
    const EARLY = { id: U(22), email: 'early@ptechllc.com', name: 'Early Bird' }; // role set before first sign-in
    const PRIOR = { id: U(23), email: 'prior@ptechllc.com' };          // promoted before this fix
    const GONE = { id: U(24), email: 'gone@ptechllc.com' };            // switched off
    const FRESH = { id: U(25), email: 'fresh@ptechllc.com' };          // never seen before

    beforeAll(async () => {
      await reset();
      await migrate();
      for (const [p, role] of [[ADMIN, 'admin'], [VERA, 'viewer'], [PRIOR, 'contributor'], [GONE, 'viewer']]) {
        await db.query('INSERT INTO user_roles (user_id, email, role, verified_email) VALUES ($1, $2, $3, $2)', [p.id, p.email, role]);
      }
      await db.query('UPDATE user_roles SET disabled_at = NOW() WHERE user_id = $1', [GONE.id]);
      await db.query('INSERT INTO user_profiles (user_id, email, display_name) VALUES ($1, $2, $3)', [VERA.id, VERA.email, 'Vera Lang']);
      jwt = require('jsonwebtoken');
      jwt.decode.mockReturnValue({ header: { kid: 'k' } });
      request = require('supertest');
      const express = require('express');
      app = express();
      app.use(express.json());
      app.use('/api/admin', require('../../routes/admin'));
      app.use('/api/libraries', require('../../routes/libraries'));
    });

    const as = (p) => {
      jwt.verify.mockReturnValue({ sub: p.id, email: p.email, email_verified: true, ...(p.name ? { name: p.name } : {}) });
      return (r) => r.set('Authorization', 'Bearer t');
    };
    const setRole = (p, role) => as(ADMIN)(request(app).put(`/api/admin/users/${p.id}/role`)).send({ role });
    const listFor = (p) => as(p)(request(app).get('/api/libraries'));

    test('a viewer signing in still gets nothing', async () => {
      const res = await listFor(VERA);
      expect(res.status).toBe(200);
      expect(await mine(VERA.id)).toEqual([]);
    });

    test('a viewer made a contributor gets one there and then, named after them', async () => {
      const res = await setRole(VERA, 'contributor');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ role: 'contributor' });
      expect(await mine(VERA.id)).toEqual([{ name: 'Vera Lang', personal: true, owner_email: VERA.email }]);
      // and it is theirs: listed to them as the owner, and where their unaddressed uploads land
      const listed = (await listFor(VERA)).body.filter(l => l.personal);
      expect(listed).toEqual([expect.objectContaining({ name: 'Vera Lang', owner_id: VERA.id, my_access: 'owner', add_right: 'owner' })]);
      expect(await libraries.defaultLibraryFor({ ...VERA, role: 'contributor' })).toBe(listed[0].id);
    });

    test('changing role again, down to viewer and back up, never makes a second or takes one away', async () => {
      for (const role of ['admin', 'viewer', 'contributor', 'admin']) {
        expect((await setRole(VERA, role)).status).toBe(200);
        expect(await mine(VERA.id)).toEqual([{ name: 'Vera Lang', personal: true, owner_email: VERA.email }]);
      }
    });

    test('once they have one, a request asks and writes nothing', async () => {
      const spy = jest.spyOn(libraries, 'ensurePersonalLibrary');
      try {
        expect((await listFor(VERA)).status).toBe(200);
        expect(spy).not.toHaveBeenCalled();
      } finally { spy.mockRestore(); }
    });

    test('given a role before they ever signed in: made on their first request, before it is answered', async () => {
      const res = await setRole(EARLY, 'contributor');
      expect(res.status).toBe(200);
      // the admin's upsert knows nothing but an id -- no address to name or own it by yet
      expect(await db.queryOne('SELECT email, role FROM user_roles WHERE user_id = $1', [EARLY.id])).toEqual({ email: null, role: 'contributor' });
      expect(await mine(EARLY.id)).toEqual([]);

      const first = await listFor(EARLY);
      expect(first.status).toBe(200);
      // the very request that found it missing already lists it
      expect(first.body.filter(l => l.personal)).toEqual([expect.objectContaining({ name: 'Early Bird', owner_id: EARLY.id, my_access: 'owner' })]);
      expect(await mine(EARLY.id)).toEqual([{ name: 'Early Bird', personal: true, owner_email: EARLY.email }]);
    });

    test('somebody promoted before this release gets theirs on their next request', async () => {
      // owning a SHARED library (handed over from somebody who left, say) is not having your own
      await db.query(`INSERT INTO libraries (name, owner_id, owner_email, created_at) VALUES ('Handed over', $1, $2, NOW() - interval '1 day')`, [PRIOR.id, PRIOR.email]);
      expect((await listFor(PRIOR)).status).toBe(200);
      expect(await mine(PRIOR.id)).toEqual([
        { name: 'Handed over', personal: false, owner_email: PRIOR.email },
        { name: 'prior', personal: true, owner_email: PRIOR.email },
      ]);
    });

    test('given the viewer role before signing in, then promoted: named by the address their sign-in recorded', async () => {
      const LATE = { id: U(28), email: 'late@ptechllc.com' };
      expect((await setRole(LATE, 'viewer')).status).toBe(200);
      expect((await listFor(LATE)).status).toBe(200);
      // the row still has no address of its own -- only the verified one sign-in keeps up to date
      expect(await db.queryOne('SELECT email, verified_email FROM user_roles WHERE user_id = $1', [LATE.id])).toEqual({ email: null, verified_email: LATE.email });
      expect(await mine(LATE.id)).toEqual([]);
      expect((await setRole(LATE, 'contributor')).status).toBe(200);
      expect(await mine(LATE.id)).toEqual([{ name: 'late', personal: true, owner_email: LATE.email }]);
    });

    test('many first requests at once still make exactly one', async () => {
      const RUSH = { id: U(26), email: 'rush@ptechllc.com' };
      await db.query(`INSERT INTO user_roles (user_id, email, role, verified_email) VALUES ($1, $2, 'contributor', $2)`, [RUSH.id, RUSH.email]);
      as(RUSH);
      const all = await Promise.all(Array.from({ length: 8 }, () => request(app).get('/api/libraries').set('Authorization', 'Bearer t')));
      expect(all.map(r => r.status)).toEqual(Array(8).fill(200));
      expect(await mine(RUSH.id)).toEqual([{ name: 'rush', personal: true, owner_email: RUSH.email }]);
    });

    test('a switched-off account is given nothing, whatever its role is set to', async () => {
      expect((await setRole(GONE, 'contributor')).status).toBe(200);
      expect(await mine(GONE.id)).toEqual([]);
      const res = await listFor(GONE);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('ACCOUNT_DISABLED');
      expect(await mine(GONE.id)).toEqual([]);
    });

    test('somebody never seen before still gets one on their first sign-in', async () => {
      const res = await listFor(FRESH);
      expect(res.status).toBe(200);
      expect(res.body.filter(l => l.personal)).toEqual([expect.objectContaining({ name: 'fresh', owner_id: FRESH.id })]);
      expect(await db.queryOne('SELECT role FROM user_roles WHERE user_id = $1', [FRESH.id])).toEqual({ role: 'contributor' });
    });

    test('only an admin can change a role, and a refused change makes nothing', async () => {
      const LEFT = { id: U(27), email: 'left@ptechllc.com' };
      await db.query(`INSERT INTO user_roles (user_id, email, role, verified_email) VALUES ($1, $2, 'viewer', $2)`, [LEFT.id, LEFT.email]);
      const res = await as(PRIOR)(request(app).put(`/api/admin/users/${LEFT.id}/role`)).send({ role: 'contributor' });
      expect(res.status).toBe(403);
      expect(await db.queryOne('SELECT role FROM user_roles WHERE user_id = $1', [LEFT.id])).toEqual({ role: 'viewer' });
      expect(await mine(LEFT.id)).toEqual([]);
    });
  });

  /* Migration 0017 catches up everybody the app missed before it learned the above. */
  describe('the catch-up migration', () => {
    const MIGRATION = '0017_personal_libraries_for_promoted.sql';
    const P = {
      promoted: { id: U(40), email: 'Promoted@ptechllc.com' },
      verifiedOnly: { id: U(41), email: null, verified: 'verified@ptechllc.com' },
      unknown: { id: U(42), email: null, verified: null },
      viewer: { id: U(43), email: 'viewer@ptechllc.com', role: 'viewer' },
      off: { id: U(44), email: 'off@ptechllc.com', disabled: true },
      has: { id: U(45), email: 'has@ptechllc.com' },
      archived: { id: U(46), email: 'archived@ptechllc.com' },
    };

    beforeAll(async () => {
      await reset();
      await migrate();
      for (const p of Object.values(P)) {
        await db.query(
          `INSERT INTO user_roles (user_id, email, role, verified_email, disabled_at)
           VALUES ($1, $2, $3, $4, CASE WHEN $5::boolean THEN NOW() END)`,
          [p.id, p.email, p.role || 'contributor', p.verified === undefined ? (p.email && p.email.toLowerCase()) : p.verified, !!p.disabled]);
      }
      await db.query('INSERT INTO user_profiles (user_id, email, display_name) VALUES ($1, $2, $3)', [P.promoted.id, 'promoted@ptechllc.com', '  Pat Promoted ']);
      await db.query(`INSERT INTO libraries (name, owner_id, owner_email, personal) VALUES ('Mine already', $1, $2, true)`, [P.has.id, P.has.email]);
      await db.query(`INSERT INTO libraries (name, owner_id, owner_email, personal, archived_at) VALUES ('Parked', $1, $2, true, NOW())`, [P.archived.id, P.archived.email]);
      // as a box that is about to take this release: everything up to it has run
      await db.query('DELETE FROM schema_migrations WHERE name = $1', [MIGRATION]);
      await require('../../lib/migrations').run();
    });

    test('everyone who can add files and had none now has one', async () => {
      expect(await mine(P.promoted.id)).toEqual([{ name: 'Pat Promoted', personal: true, owner_email: 'promoted@ptechllc.com' }]);
      // an account whose row never had an address, but whose sign-in recorded a verified one
      expect(await mine(P.verifiedOnly.id)).toEqual([{ name: 'verified', personal: true, owner_email: 'verified@ptechllc.com' }]);
    });

    test('viewers, the switched-off, and anyone with no known address are skipped', async () => {
      expect(await mine(P.viewer.id)).toEqual([]);
      expect(await mine(P.off.id)).toEqual([]);
      expect(await mine(P.unknown.id)).toEqual([]);
    });

    test('nobody who already had one, archived or not, gets another', async () => {
      expect(await mine(P.has.id)).toEqual([{ name: 'Mine already', personal: true, owner_email: P.has.email }]);
      expect(await mine(P.archived.id)).toEqual([{ name: 'Parked', personal: true, owner_email: P.archived.email }]);
    });

    test('it runs once, and running the migrations again changes nothing', async () => {
      expect(await db.queryOne('SELECT count(*)::int AS n FROM schema_migrations WHERE name = $1', [MIGRATION])).toEqual({ n: 1 });
      const before = await db.query('SELECT id FROM libraries ORDER BY id');
      await require('../../lib/migrations').run();
      expect(await db.query('SELECT id FROM libraries ORDER BY id')).toEqual(before);
    });
  });
});

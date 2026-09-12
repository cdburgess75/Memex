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
});

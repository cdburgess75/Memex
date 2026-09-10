'use strict';
// Library sharing against a REAL, THROWAWAY Postgres. This file grows with each
// release of piece 2; this part covers the groundwork: migration 0007 (library owners,
// verified addresses, the shares table and its constraints), the auth statements that
// keep verified addresses current, and exact folder matching through the real routes.
//
// It DROPS AND RECREATES THE WHOLE public SCHEMA, so it refuses to run unless the
// database name contains "test":
//
//   MEMEX_TEST_PG_URL=postgres://user:pass@localhost:5432/memex_sharing_test \
//     npx jest --runInBand integration/librarySharing.pg
//
// Without MEMEX_TEST_PG_URL the suite is skipped (normal CI / sandbox).
const fs = require('fs');
const os = require('os');
const path = require('path');

const PG = process.env.MEMEX_TEST_PG_URL;
const suite = PG ? describe : describe.skip;
// Migrations and the first connection can outlast Jest's 5 s default on a slow runner.
if (PG) jest.setTimeout(30000);

jest.mock('jsonwebtoken');
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn(() => ({ getSigningKey: async () => ({ getPublicKey: () => 'k' }) })) }));
jest.mock('../../lib/storage', () => ({ upload: jest.fn(async () => {}), download: jest.fn(async () => Buffer.alloc(0)), copy: jest.fn(async () => {}), del: jest.fn(async () => {}) }));

const ADMIN = { id: '22222222-2222-4222-8222-222222222222', email: 'dave@ptechllc.com', role: 'admin' };
const RICHARD = { id: '11111111-1111-4111-8111-111111111111', email: 'richard@ptechllc.com', role: 'contributor' };

suite('library sharing groundwork against real Postgres', () => {
  let db, migrations, request, app;
  const reset = () => db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const one = (sql, p = []) => db.queryOne(sql, p);
  const code = async (p) => { try { await p; return 'ok'; } catch (e) { return e.code || e.message; } };

  beforeAll(async () => {
    const dbName = decodeURIComponent(new URL(PG).pathname.slice(1));
    if (!/test/i.test(dbName)) throw new Error(`refusing to run: "${dbName}" does not look like a throwaway test database`);
    process.env.DATABASE_URL = PG;
    db = require('../../lib/db');
    migrations = require('../../lib/migrations');
    await reset();
    await db.query(fs.readFileSync(path.join(__dirname, '../../../postgres/init/01_schema.sql'), 'utf8'));
    // Stop just before 0007, so the owner backfill has something real to backfill.
    const early = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
    for (const f of migrations.migrationFiles()) if (f < '0007') fs.copyFileSync(path.join(migrations.DIR, f), path.join(early, f));
    await migrations.run({ dir: early });
    await db.query(`INSERT INTO libraries (id, name, created_by, created_by_email) VALUES
      ('aaaaaaaa-0000-4000-8000-000000000001', 'Clients', $1, 'Richard@PTechLLC.com'),
      ('aaaaaaaa-0000-4000-8000-000000000002', 'Legacy', NULL, 'Old@Example.com')`, [RICHARD.id]);
    request = require('supertest');
    const express = require('express');
    app = express();
    app.use(express.json());
    // The real auth middleware runs in front of the real routes; only token
    // verification is stubbed, so each request is whoever jwt.verify says it is.
    app.use('/api/files', require('../../routes/files'));
  });

  afterAll(async () => {
    try { await reset(); } catch { /* best effort */ }
    try { await db.end(); } catch { /* already closed */ }
  });

  test('0007 applies over an existing box, backfills owners, and re-runs as a no-op', async () => {
    const r = await migrations.run();
    expect(r.applied).toEqual(expect.arrayContaining(['0007_library_sharing.sql']));
    expect((await migrations.run()).applied).toEqual([]);
    await db.query(fs.readFileSync(path.join(migrations.DIR, '0007_library_sharing.sql'), 'utf8'));
    expect(await one("SELECT owner_id, owner_email FROM libraries WHERE name = 'Clients'")).toEqual({ owner_id: RICHARD.id, owner_email: 'richard@ptechllc.com' });
    // an owner is an account: a library with an address but no creator id (like the one
    // seeded at install) stays ownerless, address and all, until piece 5 gives it one
    expect(await one("SELECT owner_id, owner_email FROM libraries WHERE name = 'Legacy'")).toEqual({ owner_id: null, owner_email: null });
  });

  describe('library_grants refuses anything but a well-formed read or write share', () => {
    const L = 'aaaaaaaa-0000-4000-8000-000000000001';
    const ins = (cols, vals) => code(db.query(`INSERT INTO library_grants (library_id, ${cols}) VALUES ($1, ${vals.map((_, i) => '$' + (i + 2)).join(', ')})`, [L, ...vals]));
    test('a person, by lower-cased address, at read or write', async () => {
      expect(await ins('subject_type, subject_email, permission', ['user', 'tim@dts-tax.com', 'read'])).toBe('ok');
      expect(await ins('subject_type, subject_email, permission, folder_path', ['user', 'tim@dts-tax.com', 'write', 'Clients/Mender'])).toBe('ok');
    });
    test('never admin, never an unnormalised address, never two subjects or none', async () => {
      expect(await ins('subject_type, subject_email, permission', ['user', 'x@y.com', 'admin'])).toBe('23514');
      expect(await ins('subject_type, subject_email, permission', ['user', 'X@Y.com', 'read'])).toBe('23514');
      expect(await ins('subject_type, subject_email, permission', ['user', ' x@y.com', 'read'])).toBe('23514');
      expect(await ins('subject_type, permission', ['user', 'read'])).toBe('23514');
      expect(await ins('subject_type, subject_email, permission', ['group', 'x@y.com', 'read'])).toBe('23514');
    });
    test.each([['/Clients'], ['Clients/'], ['a//b'], ['a\\b'], ['..'], ['a/../b'], ['./a'], [' a'], ['a /b'], ['x'.repeat(401)], ['a' + String.fromCharCode(1) + 'b']])(
      'a malformed folder path (%j) is refused', async (p) => {
        expect(await ins('subject_type, subject_email, permission, folder_path', ['user', 'p@q.com', 'read', p])).toBe('23514');
      });
    // The CHECK spells out JavaScript's \p{Cc} and \s rather than [[:cntrl:]] and
    // [[:space:]], whose meaning depends on the database's locale; this proves the two
    // agree, so a path the code accepts is never refused later as a 500.
    test('the database accepts exactly the folder paths canonicalFolderPath accepts', async () => {
      const { canonicalFolderPath } = require('../../lib/documents');
      const c = (cp) => String.fromCodePoint(cp);
      const odd = [0x09, 0x0b, 0x1f, 0x7f, 0x80, 0x85, 0x9f, 0xa0, 0x1680, 0x2000, 0x2007, 0x200a, 0x200b,
        0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff, 0xfff9, 0xfffb, 0x1F4C1];
      const paths = ['Tax & Co', 'Caf' + c(0xe9), '...', '.hidden/x', c(0x4E2D).repeat(341), c(0x4E2D).repeat(342),
        'x'.repeat(400), 'x'.repeat(401), c(0x1F4C1).repeat(255), c(0x1F4C1).repeat(257)];
      for (const cp of odd) paths.push(`a${c(cp)}b`, `${c(cp)}ab`, `ab${c(cp)}`, `x/${c(cp)}y`, `x${c(cp)}/y`);
      const disagree = [];
      let n = 0;
      for (const p of paths) {
        const js = canonicalFolderPath(p) === p;
        const pg = (await ins('subject_type, subject_email, permission, folder_path', ['user', `agree${n++}@q.com`, 'read', p])) === 'ok';
        if (js !== pg) disagree.push({ path: [...p].map(ch => ch.codePointAt(0).toString(16)).join(' ').slice(0, 60), js, pg });
      }
      expect(disagree).toEqual([]);
      expect(n).toBeGreaterThan(100);
    });

    test('the same subject can hold one share per path, and a deleted library takes its shares with it', async () => {
      expect(await ins('subject_type, subject_email, permission', ['user', 'tim@dts-tax.com', 'write'])).toBe('23505');
      const g = await one("INSERT INTO groups (name) VALUES ('Acctg') RETURNING id");
      expect(await ins('subject_type, group_id, permission', ['group', g.id, 'read'])).toBe('ok');
      await db.query('DELETE FROM groups WHERE id = $1', [g.id]);
      expect(await one('SELECT count(*)::int AS n FROM library_grants WHERE subject_type = $1', ['group'])).toEqual({ n: 0 });
      const tmp = await one("INSERT INTO libraries (name) VALUES ('Tmp') RETURNING id");
      await db.query("INSERT INTO library_grants (library_id, subject_type, subject_email, permission) VALUES ($1, 'user', 'a@b.com', 'read')", [tmp.id]);
      await db.query('DELETE FROM libraries WHERE id = $1', [tmp.id]);
      expect(await one('SELECT count(*)::int AS n FROM library_grants WHERE library_id = $1', [tmp.id])).toEqual({ n: 0 });
    });
  });

  describe('auth keeps the verified address current', () => {
    const jwt = require('jsonwebtoken');
    let auth;
    beforeAll(() => { jwt.decode.mockReturnValue({ header: { kid: 'k' } }); auth = require('../../middleware/auth'); });
    const signIn = async (claims) => {
      jwt.verify.mockReturnValue({ sub: '33333333-3333-4333-8333-333333333333', email: 'Tammy@PTechLLC.com', ...claims });
      const req = { headers: { authorization: 'Bearer t' } };
      let status = 200;
      await auth(req, { status: (s) => { status = s; return { json: () => {} }; } }, () => {});
      return { req, status, row: await one("SELECT role, email, verified_email, email_verified_at IS NOT NULL AS stamped FROM user_roles WHERE user_id = '33333333-3333-4333-8333-333333333333'") };
    };
    test('first sign-in, verified: provisioned with the verified address', async () => {
      const { row, req } = await signIn({ email_verified: true });
      expect(row).toEqual({ role: 'contributor', email: 'tammy@ptechllc.com', verified_email: 'tammy@ptechllc.com', stamped: true });
      expect(req.user.verifiedEmail).toBe('tammy@ptechllc.com');
    });
    test('the provider later says unverified: the stored address is cleared', async () => {
      const { row } = await signIn({ email_verified: false });
      expect(row).toMatchObject({ verified_email: null, stamped: false });
    });
    test('and verified again: restored', async () => {
      const { row } = await signIn({ email_verified: true });
      expect(row).toMatchObject({ verified_email: 'tammy@ptechllc.com', stamped: true });
    });
  });

  describe('folders are matched exactly, through the real routes', () => {
    const L = 'aaaaaaaa-0000-4000-8000-000000000001';
    const E = String.fromCodePoint(0x1F4C1);
    const names = ['Q1_A/x.txt', 'Q1-A/y.txt', '50%/a.txt', '500/b.txt', 'Tax & Co/c.txt', 'Clients/' + E + ' Files/d.txt', 'Clients/' + E + ' Files/sub/e.txt'];
    beforeAll(async () => {
      for (const n of names) {
        await db.query(`INSERT INTO documents (name, size, mime_type, storage_path, uploaded_by, uploaded_by_email, library_id)
                        VALUES ($1, 1, 'text/plain', $2, $3, $4, $5)`, [n, 'p/' + n, ADMIN.id, ADMIN.email, L]);
      }
      await db.query("INSERT INTO user_roles (user_id, email, role, verified_email) VALUES ($1, $2, 'admin', $2)", [ADMIN.id, ADMIN.email]);
      const jwt = require('jsonwebtoken');
      jwt.decode.mockReturnValue({ header: { kid: 'k' } });
      jwt.verify.mockReturnValue({ sub: ADMIN.id, email: ADMIN.email, email_verified: true });
    });
    const live = async () => (await db.query('SELECT name FROM documents WHERE deleted_at IS NULL AND library_id = $1 ORDER BY name', [L])).map(r => r.name);

    const post = (url, body) => request(app).post(url).set('Authorization', 'Bearer t').send(body);

    test("'Q1_A' reaches only Q1_A, and '50%' only 50%", async () => {
      expect((await post('/api/files/folder/delete', { path: 'Q1_A', source_library_id: L })).body.count).toBe(1);
      expect((await post('/api/files/folder/delete', { path: '50%', source_library_id: L })).body.count).toBe(1);
      const names = await live();
      expect(names).toEqual(expect.arrayContaining(['Q1-A/y.txt', '500/b.txt']));
      expect(names).not.toContain('Q1_A/x.txt');
      expect(names).not.toContain('50%/a.txt');
    });

    test('a folder with characters the old path cleaner rewrote can be found at all', async () => {
      const res = await post('/api/files/folder/rename', { path: 'Tax & Co', name: 'Tax and Co', source_library_id: L });
      expect(res.body.count).toBe(1);
      expect(await live()).toContain('Tax and Co/c.txt');
    });

    test('renaming a folder with an emoji in it keeps every character of the rest of the name', async () => {
      const res = await post('/api/files/folder/rename', { path: 'Clients/' + E + ' Files', name: 'Archive', source_library_id: L });
      expect(res.body.count).toBe(2);
      expect(await live()).toEqual(expect.arrayContaining(['Clients/Archive/d.txt', 'Clients/Archive/sub/e.txt']));
    });

    test('a malformed library id is a 400, not a cast error', async () => {
      expect((await post('/api/files/folder/delete', { path: '500', source_library_id: 'lib-1' })).status).toBe(400);
    });

    test('a library that does not hold the folder is a 404 that touches nothing', async () => {
      const before = await live();
      const other = 'aaaaaaaa-0000-4000-8000-000000000002';
      expect((await post('/api/files/folder/delete', { path: '500', source_library_id: other })).status).toBe(404);
      expect(await live()).toEqual(before);
    });
  });

  // Moving into a folder keeps an existing one exactly and names only the new part;
  // files (PUT /:id/rename) and folders (/folder/reparent) land in the same place.
  describe('destinations and old folder links, through the real routes', () => {
    const L = 'aaaaaaaa-0000-4000-8000-000000000001';
    const TAMMY = { id: '44444444-4444-4444-8444-444444444444', email: 'tammy2@ptechllc.com' };
    let reportId;
    const add = async (name, owner) => (await one(
      `INSERT INTO documents (name, size, mime_type, storage_path, uploaded_by, uploaded_by_email, library_id)
       VALUES ($1, 1, 'text/plain', $2, $3, $4, $5) RETURNING id`, [name, 'p/' + name, owner.id, owner.email, L])).id;
    // sorted here, not by ORDER BY, so the expected order doesn't depend on the collation
    const names = async () => (await db.query(
      'SELECT name FROM documents WHERE deleted_at IS NULL AND library_id = $1 AND uploaded_by = $2', [L, TAMMY.id])).map(r => r.name).sort();
    beforeAll(async () => {
      await db.query("INSERT INTO user_roles (user_id, email, role, verified_email) VALUES ($1, $2, 'contributor', $2)", [TAMMY.id, TAMMY.email]);
      await add('Smith & Co (2025)/old.txt', TAMMY);
      await add('Hidden & Co/secret.txt', RICHARD); // exists, but not for Tammy
      await add('Inbox/Sub/n.txt', TAMMY);
      reportId = await add('Inbox/report.pdf', TAMMY);
      const jwt = require('jsonwebtoken');
      jwt.verify.mockReturnValue({ sub: TAMMY.id, email: TAMMY.email, email_verified: true });
    });
    const post = (url, body) => request(app).post(url).set('Authorization', 'Bearer t').send({ source_library_id: L, ...body });
    const renameFile = (name) => request(app).put(`/api/files/${reportId}/rename`).set('Authorization', 'Bearer t').send({ name });

    test('a new "R&D" is named the same for the folder and the file moved with it', async () => {
      expect((await renameFile('R&D/report.pdf')).body.name).toBe('R_D/report.pdf');
      expect((await post('/api/files/folder/reparent', { path: 'Inbox/Sub', target: 'R&D' })).body.path).toBe('R_D/Sub');
      expect(await names()).toEqual(['R_D/Sub/n.txt', 'R_D/report.pdf', 'Smith & Co (2025)/old.txt']);
    });

    test('an existing "Smith & Co (2025)" is kept exactly, with any new part under it named as new', async () => {
      expect((await renameFile('Smith & Co (2025)/New & Sub/report.pdf')).body.name).toBe('Smith & Co (2025)/New _ Sub/report.pdf');
      expect((await post('/api/files/folder/reparent', { path: 'R_D/Sub', target: 'Smith & Co (2025)/New & Sub' })).body.path)
        .toBe('Smith & Co (2025)/New _ Sub/Sub');
      expect(await names()).toEqual(['Smith & Co (2025)/New _ Sub/Sub/n.txt', 'Smith & Co (2025)/New _ Sub/report.pdf', 'Smith & Co (2025)/old.txt']);
    });

    test('a folder only someone else can see is not a destination', async () => {
      expect((await post('/api/files/folder/reparent', { path: 'Smith & Co (2025)/New _ Sub/Sub', target: 'Hidden & Co' })).body.path).toBe('Hidden _ Co/Sub');
      expect((await one("SELECT count(*)::int AS n FROM documents WHERE name LIKE 'Hidden & Co/%' AND uploaded_by = $1", [TAMMY.id])).n).toBe(0);
    });

    test('markup never reaches a stored name', async () => {
      await post('/api/files/folder/reparent', { path: 'Hidden _ Co/Sub', target: '<img src=x onerror=alert(1)>' });
      await renameFile('<b>x</b>/report.pdf');
      for (const n of await names()) expect(n).not.toMatch(/[<>"]/);
    });

    test('a folder link stored under the old rewritten key is still listed, and can be revoked', async () => {
      const link = await one(`INSERT INTO folder_share_links (folder_path, document_ids, token_hash, created_by, created_by_email)
                              VALUES ('Tax _ Co', '{}', 'legacy-hash', $1, $2) RETURNING id`, [TAMMY.id, TAMMY.email]);
      const list = await request(app).get('/api/files/folder/links').query({ path: 'Tax & Co' }).set('Authorization', 'Bearer t');
      expect(list.status).toBe(200);
      expect(list.body.shares.map(x => x.id)).toEqual([link.id]);
      expect((await request(app).delete(`/api/files/folder/links/${link.id}`).set('Authorization', 'Bearer t')).status).toBe(200);
    });
  });
});

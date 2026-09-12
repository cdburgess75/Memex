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
jest.mock('../../lib/storage', () => ({
  upload: jest.fn(async () => {}), download: jest.fn(async () => Buffer.alloc(0)), copy: jest.fn(async () => {}), del: jest.fn(async () => {}),
  downloadStream: jest.fn(async () => ({ stream: require('stream').Readable.from([Buffer.from('bytes')]), length: 5 })),
  isLocalProvider: jest.fn(async () => true), getUrl: jest.fn(), localBase: jest.fn(), validateLocalToken: jest.fn(),
}));
jest.mock('../../lib/notifications', () => ({ create: jest.fn(async () => ({})) }));
jest.mock('../../lib/emailEvents', () => ({ send: jest.fn(async () => ({})) }));

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
    app.use('/api/libraries', require('../../routes/libraries'));
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
    // a library of its own, so the shares made here don't make "Clients" a shared
    // library for the route tests further down
    const L = 'aaaaaaaa-0000-4000-8000-0000000000c1';
    beforeAll(() => db.query("INSERT INTO libraries (id, name) VALUES ($1, 'Constraints')", [L]));
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
    const TAMMY = { id: '77777777-7777-4777-8777-777777777777', email: 'tammy2@ptechllc.com' };
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
  // ---- release 2: everything acting on someone's behalf checks their access live ----
  describe('side channels check access live (real SQL)', () => {
    const documentAccess = require('../../lib/documentAccess');
    const { tokenHash } = require('../../lib/shareLinks');
    const L = 'aaaaaaaa-0000-4000-8000-000000000001';
    const TIM = { id: '44444444-4444-4444-8444-444444444444', email: 'tim@dts-tax.com' };
    const VIEW = { id: '55555555-5555-4555-8555-555555555555', email: 'viewer@ptechllc.com' };
    let mine, theirs, emailShared;

    beforeAll(async () => {
      await db.query(`INSERT INTO user_roles (user_id, email, role, verified_email) VALUES
        ($1, $2, 'contributor', $2), ($3, $4, 'contributor', NULL), ($5, $6, 'viewer', $6)
        ON CONFLICT (user_id) DO NOTHING`, [RICHARD.id, RICHARD.email, TIM.id, TIM.email, VIEW.id, VIEW.email]);
      const ins = async (name, by, byEmail) => (await db.queryOne(
        `INSERT INTO documents (name, size, mime_type, storage_path, uploaded_by, uploaded_by_email, library_id)
         VALUES ($1, 5, 'application/pdf', $2, $3, $4, $5) RETURNING id`, [name, 'p/' + name, by, byEmail, L])).id;
      mine = await ins('Links/mine.pdf', RICHARD.id, RICHARD.email);
      theirs = await ins('Links/theirs.pdf', ADMIN.id, ADMIN.email);
      emailShared = await ins('Links/shared-by-email.pdf', ADMIN.id, ADMIN.email);
      await db.query(`INSERT INTO document_acl (document_id, subject_type, subject_id, subject_email, permission) VALUES ($1, 'user', $2, $3, 'admin')`, [mine, RICHARD.id, RICHARD.email]);
      // Tim (address unverified) and the viewer each hold an address-keyed write grant
      await db.query(`INSERT INTO document_acl (document_id, subject_type, subject_id, subject_email, permission) VALUES
        ($1, 'user', $2, $2, 'write'), ($1, 'user', $3, $3, 'write')`, [emailShared, TIM.email, VIEW.email]);
    });

    test('resolveActor reads the live account; an unverified address matches nothing by address', async () => {
      expect(await documentAccess.resolveActor(RICHARD.id)).toMatchObject({ role: 'contributor', email: RICHARD.email, emailVerified: true });
      const tim = await documentAccess.resolveActor(TIM.id);
      expect(tim).toMatchObject({ emailVerified: false });
      expect(await documentAccess.getAccessibleDocument({ id: emailShared, user: tim, required: 'read' })).toBeNull();
      expect(await documentAccess.resolveActor('66666666-6666-4666-8666-666666666666')).toBeNull();
    });

    test('readersAmong: owners read their own, address grants count only when verified, strangers read nothing', async () => {
      const r = await documentAccess.readersAmong([mine, theirs, emailShared], [RICHARD.email, TIM.email, VIEW.email, 'nobody@x.com']);
      expect([...r.get(RICHARD.email)]).toEqual([mine]);
      expect([...r.get(TIM.email)]).toEqual([]);            // his account's address isn't verified
      expect([...r.get(VIEW.email)]).toEqual([emailShared]); // verified, read via the write grant
      expect([...r.get('nobody@x.com')]).toEqual([]);
    });

    const link = async (docId, createdBy, createdByEmail) => {
      const token = require('crypto').randomBytes(16).toString('hex');
      await db.query(`INSERT INTO document_share_links (document_id, token_hash, created_by, created_by_email, allow_upload)
                      VALUES ($1, $2, $3, $4, true)`, [docId, tokenHash(token), createdBy, createdByEmail]);
      return token;
    };

    test("a link works while its creator can edit the file, and stops the moment they can't", async () => {
      const token = await link(mine, RICHARD.id, RICHARD.email);
      expect((await request(app).get(`/api/files/share/${token}/info`)).status).toBe(200);
      expect((await request(app).get(`/api/files/share/${token}`)).status).toBe(200);
      await db.query("UPDATE user_roles SET role = 'viewer' WHERE user_id = $1", [RICHARD.id]);
      try {
        expect((await request(app).get(`/api/files/share/${token}/info`)).status).toBe(404);
        expect((await request(app).get(`/api/files/share/${token}`)).status).toBe(404);
      } finally { await db.query("UPDATE user_roles SET role = 'contributor' WHERE user_id = $1", [RICHARD.id]); }
    });

    test('a link whose creator only ever reached the file through an unverified address is dead', async () => {
      const token = await link(emailShared, TIM.id, TIM.email);
      expect((await request(app).get(`/api/files/share/${token}/info`)).status).toBe(404);
    });

    test('a link made by a viewer never works, even with a write grant behind it', async () => {
      const token = await link(emailShared, VIEW.id, VIEW.email);
      expect((await request(app).get(`/api/files/share/${token}/info`)).status).toBe(404);
    });

    test('a folder link serves only the files its creator can still edit', async () => {
      const token = require('crypto').randomBytes(16).toString('hex');
      await db.query(`INSERT INTO folder_share_links (folder_path, document_ids, token_hash, created_by, created_by_email)
                      VALUES ('Links', $1::uuid[], $2, $3, $4)`, [[mine, theirs], tokenHash(token), RICHARD.id, RICHARD.email]);
      const res = await request(app).get(`/api/files/folder/share/${token}`).buffer(true).parse((r, cb) => { const c = []; r.on('data', d => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });
      expect(res.status).toBe(200);
      const zip = res.body.toString('latin1');
      expect(zip).toContain('mine.pdf');
      expect(zip).not.toContain('theirs.pdf');
    });

    test('followers who can no longer read a file are not told about it', async () => {
      const docFollows = require('../../lib/docFollows');
      await docFollows.follow(mine, RICHARD.email);
      await docFollows.follow(mine, VIEW.email);
      expect(await docFollows.followersOf(mine, 'someone-else@x.com')).toEqual([RICHARD.email]);
    });
  });

  // Release 3: every write checks its destination (libraries.writeRight), and records
  // whether what it wrote is library content (documents.library_scoped).
  describe('destination checks (real SQL)', () => {
    const libraries = require('../../lib/libraries');
    const jwt = require('jsonwebtoken');
    const LD = 'aaaaaaaa-0000-4000-8000-0000000000d1';   // owned by OWNER, shared
    const LOPEN = 'aaaaaaaa-0000-4000-8000-0000000000d2'; // no owner, no members, no shares
    const LMEM = 'aaaaaaaa-0000-4000-8000-0000000000d3';  // no shares, members: RO only
    const LR = 'aaaaaaaa-0000-4000-8000-0000000000d4';    // made by an older release after 0007
    const u = (n, role = 'contributor', verified = true) => ({ id: `d${n}d${n}d${n}d${n}-0000-4000-8000-00000000000${n}`, email: `u${n}@dest.com`, role, verified });
    const OWNER = u(1), RW = u(2), RO = u(3), GRP = u(4), UNV = u(5, 'contributor', false), VIEWER = u(6, 'viewer'), MAKER = u(7);
    const people = [OWNER, RW, RO, GRP, UNV, VIEWER, MAKER];
    const as = (who) => jwt.verify.mockReturnValue({ sub: who.id, email: who.email, email_verified: who.verified });
    const addDoc = async (name, owner, lib, scoped = false) => (await one(
      `INSERT INTO documents (name, size, mime_type, storage_path, uploaded_by, uploaded_by_email, library_id, library_scoped)
       VALUES ($1, 1, 'text/plain', $2, $3, $4, $5, $6) RETURNING id`, [name, 'p/' + lib + name, owner.id, owner.email, lib, scoped])).id;
    const grant = (lib, email, permission, folder = '') => db.query(
      "INSERT INTO library_grants (library_id, folder_path, subject_type, subject_email, permission) VALUES ($1, $2, 'user', $3, $4)", [lib, folder, email, permission]);
    const post = (url, body) => request(app).post(url).set('Authorization', 'Bearer t').send(body);

    beforeAll(async () => {
      for (const p of people) {
        await db.query('INSERT INTO user_roles (user_id, email, role, verified_email) VALUES ($1, $2, $3, $4)', [p.id, p.email, p.role, p.verified ? p.email : null]);
      }
      await db.query(`INSERT INTO libraries (id, name, created_by, created_by_email, owner_id, owner_email) VALUES
        ($1, 'Destinations', $5, $6, $5, $6), ($2, 'Open', NULL, NULL, NULL, NULL), ($3, 'Members only', NULL, NULL, NULL, NULL),
        ($4, 'Rollback era', $7, $8, NULL, NULL)`, [LD, LOPEN, LMEM, LR, OWNER.id, OWNER.email, MAKER.id, 'U7@Dest.com']);
      await db.query("INSERT INTO library_members (library_id, subject_email) VALUES ($1, $2), ($1, $3)", [LMEM, RO.email, UNV.email]);
      await grant(LD, RW.email, 'write', 'Team');
      await grant(LD, RO.email, 'read');
      await grant(LD, UNV.email, 'write');
      await grant(LD, VIEWER.email, 'write');
      await grant(LD, 'nobody@dest.com', 'read', 'Parent/Child');
      const g = await one("INSERT INTO groups (name) VALUES ('Dest writers') RETURNING id");
      await db.query('INSERT INTO group_members (group_id, member_email) VALUES ($1, $2)', [g.id, 'U4@Dest.com']);
      await db.query("INSERT INTO library_grants (library_id, subject_type, group_id, permission) VALUES ($1, 'group', $2, 'write')", [LD, g.id]);
    });

    test('0008 gives a rollback-era library its creator, then marks only owners\' own files as library content', async () => {
      const mine = await addDoc('Backfill/mine.txt', MAKER, LR);
      const other = await addDoc('Backfill/other.txt', OWNER, LR);
      const ownerless = await addDoc('Backfill/legacy.txt', RICHARD, 'aaaaaaaa-0000-4000-8000-000000000002');
      const sql = fs.readFileSync(path.join(migrations.DIR, '0008_document_library_scope.sql'), 'utf8');
      await db.query(sql);
      await db.query(sql); // and again: nothing changes
      expect(await one('SELECT owner_id, owner_email FROM libraries WHERE id = $1', [LR])).toEqual({ owner_id: MAKER.id, owner_email: 'u7@dest.com' });
      const scoped = async (id) => (await one('SELECT library_scoped FROM documents WHERE id = $1', [id])).library_scoped;
      expect(await scoped(mine)).toBe(true);
      expect(await scoped(other)).toBe(false);
      expect(await scoped(ownerless)).toBe(false);
    });

    test.each([
      ['an admin, in an owned library', () => ADMIN, LD, '', { right: 'admin', scoped: true }],
      ['an admin, in an unowned unshared library', () => ADMIN, LOPEN, '', { right: 'admin', scoped: false }],
      ['the owner, anywhere in it', () => OWNER, LD, 'Deep/Down', { right: 'owner', scoped: true }],
      ['a Read-Write share on the folder', () => RW, LD, 'Team', { right: 'grant', scoped: true }],
      ['... and below it', () => RW, LD, 'Team/Sub/Deeper', { right: 'grant', scoped: true }],
      ['... but not a folder that merely starts the same', () => RW, LD, 'Teammates', { status: 403 }],
      ['... nor the library root, once it is shared', () => RW, LD, '', { status: 403 }],
      ['a Read-only share', () => RO, LD, '', { status: 403 }],
      ['a Read-Write share through a group (by verified address)', () => GRP, LD, 'Anything', { right: 'grant', scoped: true }],
      ['a share to an address its account has not verified', () => UNV, LD, '', { status: 403 }],
      ['a viewer, whatever the share says', () => VIEWER, LD, '', { status: 403 }],
      ['anyone, in an open library nobody has shared', () => RW, LOPEN, 'x', { right: 'legacy', scoped: false }],
      ['a listed member, in a members-only library', () => RO, LMEM, '', { right: 'legacy', scoped: false }],
      ['someone not listed there', () => RW, LMEM, '', { status: 403 }],
      ['a listed member whose address is not verified (the old rule is unchanged)', () => UNV, LMEM, '', { right: 'legacy', scoped: false }],
      ['an unknown library', () => OWNER, 'aaaaaaaa-0000-4000-8000-0000000000ff', '', { status: 404 }],
      ['a malformed library id', () => OWNER, 'lib-1', '', { status: 400 }],
    ])('writeRight: %s', async (_label, who, lib, at, want) => {
      const user = who();
      const got = await libraries.writeRight({ ...user, emailVerified: user.verified !== false }, lib, at);
      expect(got).toMatchObject(want);
    });

    test('sharedFolderAt: a share at the folder or anywhere below it', async () => {
      expect(await libraries.sharedFolderAt(LD, 'Team')).toBe(true);
      expect(await libraries.sharedFolderAt(LD, 'Parent')).toBe(true);        // Parent/Child is shared
      expect(await libraries.sharedFolderAt(LD, 'Parent/Child/x')).toBe(false);
      expect(await libraries.sharedFolderAt(LD, 'Te')).toBe(false);
      expect(await libraries.sharedFolderAt(LOPEN, 'Team')).toBe(false);
    });

    test('a new folder is library content only where the right says so', async () => {
      as(RW);
      expect((await post('/api/files/folder', { path: 'Team/New', library_id: LD })).status).toBe(200);
      expect((await post('/api/files/folder', { path: 'Elsewhere', library_id: LD })).status).toBe(403);
      expect((await post('/api/files/folder', { path: 'Mine', library_id: LOPEN })).status).toBe(200);
      as(RO);
      expect((await post('/api/files/folder', { path: 'Team/Nope', library_id: LD })).status).toBe(403);
      const marks = await db.query("SELECT name, library_id, library_scoped FROM documents WHERE name LIKE '%/.keep' AND uploaded_by IN ($1, $2)", [RW.id, RO.id]);
      expect(marks.map(m => [m.name, m.library_id, m.library_scoped]).sort()).toEqual([
        ['Mine/.keep', LOPEN, false],
        ['Team/New/.keep', LD, true],
      ]);
    });

    test('a shared folder now moves with its share, and the operations that END one say so', async () => {
      as(OWNER);
      await addDoc('Team/plan.txt', OWNER, LD, true);
      const before = await db.query("SELECT subject_type, subject_email, group_id, permission FROM library_grants WHERE library_id = $1 AND folder_path = 'Team' ORDER BY subject_email", [LD]);
      expect(before.length).toBeGreaterThan(0);
      // A rename carries the share with the folder: the same people, at the same level.
      const ren = await post('/api/files/folder/rename', { path: 'Team', name: 'Team2', source_library_id: LD });
      expect([ren.status, ren.body.shares_moved]).toEqual([200, before.length]);
      expect((await one("SELECT count(*)::int AS n FROM documents WHERE name = 'Team2/plan.txt' AND library_id = $1 AND deleted_at IS NULL", [LD])).n).toBe(1);
      expect((await one("SELECT count(*)::int AS n FROM library_grants WHERE library_id = $1 AND folder_path = 'Team'", [LD])).n).toBe(0);
      const after = await db.query("SELECT subject_type, subject_email, group_id, permission FROM library_grants WHERE library_id = $1 AND folder_path = 'Team2' ORDER BY subject_email", [LD]);
      expect(after).toEqual(before);
      // ...and so does a move within the library.
      const rep = await post('/api/files/folder/reparent', { path: 'Team2', target: 'Archive', source_library_id: LD });
      expect([rep.status, rep.body.shares_moved]).toEqual([200, before.length]);
      expect((await one("SELECT count(*)::int AS n FROM documents WHERE name = 'Archive/Team2/plan.txt' AND library_id = $1", [LD])).n).toBe(1);
      expect(await db.query("SELECT subject_type, subject_email, group_id, permission FROM library_grants WHERE library_id = $1 AND folder_path = 'Archive/Team2' ORDER BY subject_email", [LD])).toEqual(before);
      // Deleting it ENDS the sharing, and says whose it was -- and it can be undone.
      const gone = await post('/api/files/folder/delete', { path: 'Archive/Team2', source_library_id: LD });
      expect(gone.status).toBe(200);
      expect(gone.body.shares_ended.length).toBe(before.length);
      expect((await one("SELECT count(*)::int AS n FROM library_grants WHERE library_id = $1 AND folder_path = 'Archive/Team2'", [LD])).n).toBe(0);
      const back = await post('/api/files/folder/restore', { op_id: gone.body.op_id });
      expect([back.status, back.body.count]).toEqual([200, gone.body.count]);
      expect(await db.query("SELECT subject_type, subject_email, group_id, permission FROM library_grants WHERE library_id = $1 AND folder_path = 'Archive/Team2' ORDER BY subject_email", [LD])).toEqual(before);
      // put it back, so the rest of the suite sees the library it expects
      expect((await post('/api/files/folder/reparent', { path: 'Archive/Team2', target: '', source_library_id: LD })).status).toBe(200);
      expect((await post('/api/files/folder/rename', { path: 'Team2', name: 'Team', source_library_id: LD })).status).toBe(200);
    });

    test('moving a folder to a library held only under the old open rule leaves library content behind', async () => {
      as(OWNER);
      const content = await addDoc('Outbox/content.txt', OWNER, LD, true);
      const personal = await addDoc('Outbox/personal.txt', OWNER, LD, false);
      const res = await post('/api/files/folder/move', { path: 'Outbox', library_id: LOPEN, source_library_id: LD });
      expect(res.status).toBe(200);
      expect(res.body.count).toBe(1);
      expect(res.body.kept).toBe(1);
      const where = async (id) => (await one('SELECT library_id, library_scoped FROM documents WHERE id = $1', [id]));
      expect(await where(content)).toEqual({ library_id: LD, library_scoped: true });
      expect(await where(personal)).toEqual({ library_id: LOPEN, library_scoped: false });
    });

    // An admin tidying folders must never turn a colleague's private file into library
    // content (the flag never flips back, and release 4's shares would hand it out).
    test("an admin's renames and moves never scope a colleague's personal file", async () => {
      await db.query("INSERT INTO user_roles (user_id, email, role, verified_email) VALUES ($1, $2, 'admin', $2) ON CONFLICT (user_id) DO NOTHING", [ADMIN.id, ADMIN.email]);
      jwt.verify.mockReturnValue({ sub: ADMIN.id, email: ADMIN.email, email_verified: true });
      const theirs = await addDoc('Tidy/theirs.txt', RW, LD, false);
      const mine = await addDoc('Tidy/mine.txt', ADMIN, LD, false);
      expect((await post('/api/files/folder/rename', { path: 'Tidy', name: 'Tidied', source_library_id: LD })).status).toBe(200);
      const scoped = async (id) => (await one('SELECT library_scoped FROM documents WHERE id = $1', [id])).library_scoped;
      expect([await scoped(theirs), await scoped(mine)]).toEqual([false, false]); // a rename changes no scope
      expect((await post('/api/files/folder/reparent', { path: 'Tidied', target: 'Archive', source_library_id: LD })).status).toBe(200);
      expect([await scoped(theirs), await scoped(mine)]).toEqual([false, true]);  // only the admin's own file
      const other = await addDoc('Loose/theirs2.txt', RW, LD, false);
      await request(app).put(`/api/files/${other}/rename`).set('Authorization', 'Bearer t').send({ name: 'Archive/theirs2.txt' });
      expect(await scoped(other)).toBe(false);
    });
  });

  // Release 4: sharing. What a share grants, decided by documentAccess.condition() on
  // real SQL, the library list each person sees, and the share routes end to end.
  describe('sharing (real SQL)', () => {
    const jwt = require('jsonwebtoken');
    const documentAccess = require('../../lib/documentAccess');
    const LS = 'aaaaaaaa-0000-4000-8000-0000000000e1';      // owned by OWN, shared below
    const LNOOWNER = 'aaaaaaaa-0000-4000-8000-0000000000e2'; // no owner: can't be shared yet
    const person = (n, role = 'contributor', verified = true) => ({ id: `e${n}e${n}e${n}e${n}-0000-4000-8000-00000000000${n}`, email: `s${n}@share.com`, role, verified });
    const OWN = person(1), RWU = person(2), ROU = person(3), GRPU = person(4), VWR = person(5, 'viewer'), UNV = person(6, 'contributor', false), P = person(7), STRANGER = person(8);
    const SADMIN = { id: 'e9e9e9e9-0000-4000-8000-000000000009', email: 's9@share.com', role: 'admin', verified: true };
    const everyone = [OWN, RWU, ROU, GRPU, VWR, UNV, P, STRANGER, SADMIN];
    const as = (who) => { jwt.verify.mockReturnValue({ sub: who.id, email: who.email, email_verified: who.verified }); return request(app); };
    const auth = (r) => r.set('Authorization', 'Bearer t');
    const docs = {};
    const add = async (key, name, owner, scoped) => {
      docs[key] = (await one(
        `INSERT INTO documents (name, size, mime_type, storage_path, uploaded_by, uploaded_by_email, library_id, library_scoped)
         VALUES ($1, 1, 'text/plain', $2, $3, $4, $5, $6) RETURNING id`, [name, 'p/s/' + name, owner.id, owner.email, LS, scoped])).id;
      await documentAccess.grantOwnerAdmin(docs[key], owner); // as every upload does
    };
    const can = async (who, key, required) => !!(await documentAccess.getAccessibleDocument({
      id: docs[key], user: { id: who.id, role: who.role, email: who.email, emailVerified: who.verified }, required, columns: 'd.id',
    }));
    let groupId;

    beforeAll(async () => {
      for (const u of everyone) {
        await db.query('INSERT INTO user_roles (user_id, email, role, verified_email) VALUES ($1, $2, $3, $4)', [u.id, u.email, u.role, u.verified ? u.email : null]);
      }
      await db.query(`INSERT INTO libraries (id, name, created_by, created_by_email, owner_id, owner_email) VALUES
        ($1, 'Sharing', $3, $4, $3, $4), ($2, 'Nobody owns me', NULL, NULL, NULL, NULL)`, [LS, LNOOWNER, OWN.id, OWN.email]);
      await add('own', 'Plans/own.txt', OWN, true);
      await add('personal', 'Plans/personal.txt', P, false);      // uploaded before sharing: stays P's
      await add('team', 'Team/t.txt', OWN, true);
      await add('team2', 'Team2/x.txt', OWN, true);                // looks like Team, isn't
      await add('q1', 'Q1_A/q.txt', OWN, true);
      await add('q1dash', 'Q1-A/q.txt', OWN, true);
      groupId = (await one("INSERT INTO groups (name, owner_id, owner_email) VALUES ('Sharers', $1, $2) RETURNING id", [OWN.id, OWN.email])).id;
      await db.query('INSERT INTO group_members (group_id, member_email) VALUES ($1, $2)', [groupId, GRPU.email.toUpperCase()]);
    });

    test('the owner shares through the routes; each share is chained', async () => {
      const share = (body) => auth(as(OWN).post(`/api/libraries/${LS}/shares`)).send(body);
      expect((await share({ email: RWU.email, permission: 'write' })).status).toBe(201);
      expect((await share({ email: ROU.email, permission: 'read' })).status).toBe(201);
      expect((await share({ group_id: groupId, permission: 'write', folder_path: 'Team' })).status).toBe(201);
      expect((await share({ email: VWR.email, permission: 'write' })).status).toBe(201);
      expect((await share({ email: UNV.email, permission: 'write' })).status).toBe(201);
      expect((await share({ email: 'nobody@outside.com', permission: 'read', folder_path: 'Q1_A' })).status).toBe(201);
      const dup = await share({ email: RWU.email.toUpperCase(), permission: 'read' });
      expect(dup.status).toBe(409);
      expect(dup.body.share.subject_email).toBe(RWU.email);
      expect((await one("SELECT count(*)::int AS n FROM document_events WHERE event_type = 'library_shared'")).n).toBe(6);
    });

    test.each([
      // who, document, read, write, admin
      ['the owner, on library content', () => OWN, 'own', true, true, true],
      ['the owner, on someone else\'s personal file', () => OWN, 'personal', false, false, false],
      ['a Read-Write share', () => RWU, 'own', true, true, false],
      ['a Read-Write share, on a personal file', () => RWU, 'personal', false, false, false],
      ['a Read-only share', () => ROU, 'team', true, false, false],
      ['a group Read-Write share of Team, in Team', () => GRPU, 'team', true, true, false],
      ['... not in Team2', () => GRPU, 'team2', false, false, false],
      ['... nor elsewhere', () => GRPU, 'own', false, false, false],
      ['a viewer with a Read-Write share only reads', () => VWR, 'own', true, false, false],
      ['a share to an address not verified gives nothing', () => UNV, 'own', false, false, false],
      ['the uploader of a personal file keeps it', () => P, 'personal', true, true, true],
      ['... but sees nothing shared with others', () => P, 'own', false, false, false],
      ['a stranger', () => STRANGER, 'own', false, false, false],
      ['an admin', () => SADMIN, 'personal', true, true, true],
    ])('%s', async (_l, who, key, r, w, a) => {
      const u = who();
      expect([await can(u, key, 'read'), await can(u, key, 'write'), await can(u, key, 'admin')]).toEqual([r, w, a]);
    });

    test("a folder share's '_' is an ordinary character", async () => {
      const outsider = { id: null, role: '', email: 'nobody@outside.com', verified: false };
      // no account at all: shares never match (they need a verified account)
      expect(await can(outsider, 'q1', 'read')).toBe(false);
      await db.query("INSERT INTO user_roles (user_id, email, role, verified_email) VALUES ('eaeaeaea-0000-4000-8000-00000000000a', 'nobody@outside.com', 'contributor', 'nobody@outside.com')");
      const signedIn = { id: 'eaeaeaea-0000-4000-8000-00000000000a', role: 'contributor', email: 'nobody@outside.com', verified: true };
      expect([await can(signedIn, 'q1', 'read'), await can(signedIn, 'q1dash', 'read')]).toEqual([true, false]);
    });

    test('each person sees the library listed, with what they can do there', async () => {
      const mine = async (who) => (await auth(as(who).get('/api/libraries'))).body.find(l => l.id === LS) || null;
      expect(await mine(OWN)).toMatchObject({ my_access: 'owner', can_manage: true, add_right: 'owner', shared: true });
      expect(await mine(RWU)).toMatchObject({ my_access: 'rw', can_manage: false, add_right: 'grant' });
      expect((await mine(RWU)).shared).toBeUndefined(); // only managers are told
      expect(await mine(ROU)).toMatchObject({ my_access: 'r', add_right: null });
      expect(await mine(GRPU)).toMatchObject({ my_access: 'folders', my_folders: [{ path: 'Team', level: 'rw' }], add_right: null });
      expect(await mine(VWR)).toMatchObject({ my_access: 'r', add_right: null });
      expect(await mine(P)).toMatchObject({ my_access: 'listed' }); // still has personal files there
      expect(await mine(UNV)).toBeNull();
      expect(await mine(STRANGER)).toBeNull(); // shared, so no longer open to everyone
      expect(await mine(SADMIN)).toMatchObject({ my_access: 'admin', can_manage: true });
    });

    test('a manager sees who it is shared with, and whether each address can use it', async () => {
      expect((await auth(as(RWU).get(`/api/libraries/${LS}/shares`))).status).toBe(403);
      const res = await auth(as(OWN).get(`/api/libraries/${LS}/shares`));
      expect(res.status).toBe(200);
      const byWho = Object.fromEntries(res.body.shares.map(x => [x.subject_email || x.group.name, x]));
      expect(byWho[RWU.email].account).toBe('ok');
      expect(byWho[UNV.email].account).toBe('unverified');
      expect(byWho.Sharers).toMatchObject({ folder_path: 'Team', folder_present: true, account: null, group: { name: 'Sharers', member_count: 1 } });
    });

    test('group membership is live: leaving the group ends the access', async () => {
      expect(await can(GRPU, 'team', 'read')).toBe(true);
      await db.query('DELETE FROM group_members WHERE group_id = $1', [groupId]);
      expect(await can(GRPU, 'team', 'read')).toBe(false);
      await db.query('INSERT INTO group_members (group_id, member_email) VALUES ($1, $2)', [groupId, GRPU.email]);
    });

    test('what a Read-Write sharer added belongs to the library: removing the share ends their access to it', async () => {
      await add('added', 'Plans/added.txt', RWU, true);
      expect(await can(RWU, 'added', 'write')).toBe(true);
      expect(await can(OWN, 'added', 'admin')).toBe(true);
      // their owner row is not shown as if it counted
      expect((await documentAccess.listGrants(docs.added)).some(g => g.subject_id === RWU.id)).toBe(false);
      const list = (await auth(as(OWN).get(`/api/libraries/${LS}/shares`))).body.shares;
      const rw = list.find(x => x.subject_email === RWU.email);
      expect((await auth(as(OWN).delete(`/api/libraries/${LS}/shares/${rw.id}`))).status).toBe(200);
      expect(await can(RWU, 'added', 'read')).toBe(false);
      expect(await can(OWN, 'added', 'read')).toBe(true);
    });

    test('a file shared one by one still works on library content', async () => {
      await documentAccess.grantUserAccess(docs.own, { email: STRANGER.email, permission: 'read', grantedBy: OWN });
      expect(await can(STRANGER, 'own', 'read')).toBe(true);
      expect(await can(STRANGER, 'own', 'write')).toBe(false);
    });

    test('a level change is conditional, and a library with no owner cannot be shared', async () => {
      const list = (await auth(as(OWN).get(`/api/libraries/${LS}/shares`))).body.shares;
      const ro = list.find(x => x.subject_email === ROU.email);
      expect((await auth(as(OWN).put(`/api/libraries/${LS}/shares/${ro.id}`)).send({ permission: 'write' })).body.share.permission).toBe('write');
      expect(await can(ROU, 'team', 'write')).toBe(true);
      expect((await auth(as(SADMIN).post(`/api/libraries/${LNOOWNER}/shares`)).send({ email: 'x@y.com', permission: 'read' })).status).toBe(409);
    });

    test('granting a folder the old way is retired', async () => {
      const res = await auth(as(OWN).post('/api/files/folder/members')).send({ path: 'Plans', email: 'x@y.com', permission: 'admin', source_library_id: LS });
      expect(res.status).toBe(410);
    });
  });

  // Release 4, after review: moving library content out, uploads into shared folders
  // with unusual names, and who still sees a library listed.
  describe('sharing: moving out, uploading in, listing (real SQL)', () => {
    const jwt = require('jsonwebtoken');
    const documentAccess = require('../../lib/documentAccess');
    const shares = require('../../lib/libraryShares');
    const LM = 'aaaaaaaa-0000-4000-8000-0000000000f1';       // owned by MOWN, shared
    const LOTHER = 'aaaaaaaa-0000-4000-8000-0000000000f2';   // owned by MOWN, not shared
    const LOPEN2 = 'aaaaaaaa-0000-4000-8000-0000000000f3';   // no owner, members, shares
    const LMEM2 = 'aaaaaaaa-0000-4000-8000-0000000000f4';    // members-only (not the stranger)
    const who = (n, role = 'contributor', email = `m${n}@move.com`, verified = email) =>
      ({ id: `f${n}f${n}f${n}f${n}-0000-4000-8000-00000000000${n}`, email, role, verified });
    const MOWN = who(1), MRW = who(2), MFOLD = who(3), MVIEW = who(4, 'viewer'), MSTR = who(5), MCLAIM = who(6, 'contributor', 'victim@move.com', 'mclaim@move.com');
    const as = (u) => { jwt.verify.mockReturnValue({ sub: u.id, email: u.email, email_verified: !!u.verified }); return request(app); };
    const auth = (r) => r.set('Authorization', 'Bearer t');
    const docs = {};
    const add = async (key, name, owner, lib, scoped) => {
      docs[key] = (await one(`INSERT INTO documents (name, size, mime_type, storage_path, uploaded_by, uploaded_by_email, library_id, library_scoped)
        VALUES ($1, 1, 'text/plain', $2, $3, $4, $5, $6) RETURNING id`, [name, 'p/m/' + key, owner.id, owner.email, lib, scoped])).id;
      await documentAccess.grantOwnerAdmin(docs[key], owner);
    };
    const reads = async (u, key) => !!(await documentAccess.getAccessibleDocument({ id: docs[key], user: { id: u.id, role: u.role, email: u.email, emailVerified: !!u.verified }, required: 'read', columns: 'd.id' }));
    const libOf = async (key) => (await one('SELECT library_id FROM documents WHERE id = $1', [docs[key]])).library_id;

    beforeAll(async () => {
      for (const u of [MOWN, MRW, MFOLD, MVIEW, MSTR, MCLAIM]) {
        await db.query('INSERT INTO user_roles (user_id, email, role, verified_email) VALUES ($1, $2, $3, $4)', [u.id, u.email, u.role, u.verified || null]);
      }
      await db.query(`INSERT INTO libraries (id, name, owner_id, owner_email) VALUES
        ($1, 'Moves', $5, $6), ($2, 'Owner other', $5, $6), ($3, 'Open two', NULL, NULL), ($4, 'Members two', NULL, NULL)`, [LM, LOTHER, LOPEN2, LMEM2, MOWN.id, MOWN.email]);
      await db.query('INSERT INTO library_members (library_id, subject_email) VALUES ($1, $2)', [LMEM2, MOWN.email]);
      await add('plans', 'Plans/p.txt', MOWN, LM, true);
      await add('loose', 'Loose/l.txt', MOWN, LM, true);
      await add('smith', 'Smith & Co (2025)/a.txt', MOWN, LM, true);
      await add('smithPersonal', 'Smith & Co (2025)/mine.txt', MSTR, LM, false); // MSTR's own, from before sharing
      await add('private', 'Private/only-mine.txt', MSTR, LM, false);
      await add('otherSmith', 'Smith & Co (2025)/b.txt', MOWN, LOTHER, true);
      await add('granted', 'Plans/for-viewer.txt', MOWN, LM, true);
      await documentAccess.grantUserAccess(docs.granted, { email: MVIEW.email, permission: 'read', grantedBy: MOWN });
      await shares.createShare({ libraryId: LM, folderPath: '', email: MRW.email, permission: 'write', user: MOWN });
      await shares.createShare({ libraryId: LM, folderPath: 'Smith & Co (2025)', email: MFOLD.email, permission: 'write', user: MOWN });
      await shares.createShare({ libraryId: LM, folderPath: '', email: 'victim@move.com', permission: 'read', user: MOWN });
    });

    test('a Read-Write sharee cannot carry library content off to a library of their own; the owner keeps it', async () => {
      const mine = await auth(as(MRW).post('/api/libraries')).send({ name: 'Carried off' });
      const t = await auth(as(MRW).post('/api/files/library-transfer')).send({ ids: [docs.plans], libraryId: mine.body.id, mode: 'move' });
      expect(t.body).toMatchObject({ count: 0, kept: 1 });
      const f = await auth(as(MRW).post('/api/files/folder/move')).send({ path: 'Loose', library_id: mine.body.id, source_library_id: LM });
      expect(f.body).toMatchObject({ count: 0, kept: 1 });
      expect([await libOf('plans'), await libOf('loose')]).toEqual([LM, LM]);
      expect([await reads(MOWN, 'plans'), await reads(MOWN, 'loose')]).toEqual([true, true]);
      // copying out is still allowed: the copy is theirs
      const c = await auth(as(MRW).post('/api/files/library-transfer')).send({ ids: [docs.plans], libraryId: mine.body.id, mode: 'copy' });
      expect(c.body.count).toBe(1);
    });

    test('the owner can move their library content to another library they own', async () => {
      const t = await auth(as(MOWN).post('/api/files/library-transfer')).send({ ids: [docs.loose], libraryId: LOTHER, mode: 'move' });
      expect(t.body).toMatchObject({ count: 1, kept: 0 });
      expect(await libOf('loose')).toBe(LOTHER);
      expect(await reads(MOWN, 'loose')).toBe(true);
    });

    test('a Read-Write folder sharee adds files inside a shared folder with an unusual name, exactly', async () => {
      expect((await auth(as(MFOLD).post('/api/files/folder')).send({ path: 'Smith & Co (2025)/Q1 & Q2', library_id: LM })).body.path).toBe('Smith & Co (2025)/Q1 _ Q2');
      const created = await auth(as(MFOLD).post('/api/files/create')).send({ name: 'Plan', type: 'md', folder: 'Smith & Co (2025)', library_id: LM });
      expect(created.status).toBe(200);
      expect(created.body.name).toBe('Smith & Co (2025)/Plan.md');
      const row = await one('SELECT library_scoped FROM documents WHERE id = $1', [created.body.id]);
      expect(row.library_scoped).toBe(true);
      // and outside the shared folder they have no right at all
      expect((await auth(as(MFOLD).post('/api/files/create')).send({ name: 'Nope', type: 'md', folder: 'Plans', library_id: LM })).status).toBe(403);
    });

    test("a folder share reaches library content in that folder of that library only", async () => {
      expect(await reads(MFOLD, 'smith')).toBe(true);
      expect(await reads(MFOLD, 'smithPersonal')).toBe(false); // someone's personal file in the shared folder
      expect(await reads(MFOLD, 'otherSmith')).toBe(false);    // same folder name, another library
    });

    test('a share matches the verified address, never the address an account merely signs in with', async () => {
      // MCLAIM signs in as victim@move.com, but Keycloak verified mclaim@move.com
      expect(await reads(MCLAIM, 'plans')).toBe(false);
      expect(await reads({ ...MCLAIM, verified: 'victim@move.com' }, 'plans')).toBe(false); // the token's claim alone changes nothing
    });

    test('someone given files one by one still sees the library listed once it is shared', async () => {
      const lib = (await auth(as(MVIEW).get('/api/libraries'))).body.find(l => l.id === LM);
      expect(lib).toMatchObject({ my_access: 'listed', add_right: null });
      expect(await reads(MVIEW, 'granted')).toBe(true);
    });

    test('the old rules still list open and members-only libraries as before', async () => {
      const mine = async (u) => (await auth(as(u).get('/api/libraries'))).body;
      expect((await mine(MSTR)).find(l => l.id === LOPEN2)).toMatchObject({ my_access: 'listed', add_right: 'legacy' });
      expect((await mine(MSTR)).find(l => l.id === LMEM2)).toBeUndefined();
      expect((await mine(MOWN)).find(l => l.id === LMEM2)).toMatchObject({ my_access: 'listed', add_right: 'legacy' });
    });

    test("sharing a folder that holds only someone else's private files is 'not found'", async () => {
      const res = await auth(as(MOWN).post(`/api/libraries/${LM}/shares`)).send({ email: 'x@y.com', permission: 'read', folder_path: 'Private' });
      expect(res.status).toBe(404);
    });

    test('a level change made from a stale level changes nothing', async () => {
      const s = (await shares.listShares(LM)).find(x => x.subject_email === MRW.email);
      expect(await shares.setPermission(LM, s.id, 'read', 'read')).toBeNull(); // it is 'write' now
      expect((await shares.getShare(LM, s.id)).permission).toBe('write');
    });

    test('an owner demoted to viewer can read their library but not change or share it', async () => {
      await db.query("UPDATE user_roles SET role = 'viewer' WHERE user_id = $1", [MOWN.id]);
      try {
        const u = { ...MOWN, role: 'viewer' };
        expect(await reads(u, 'plans')).toBe(true);
        expect(!!(await documentAccess.getAccessibleDocument({ id: docs.plans, user: { id: u.id, role: 'viewer', email: u.email, emailVerified: true }, required: 'write', columns: 'd.id' }))).toBe(false);
        expect((await auth(as(u).get('/api/libraries'))).body.find(l => l.id === LM)).toMatchObject({ can_manage: false, add_right: null });
        expect((await auth(as(u).get(`/api/libraries/${LM}/shares`))).status).toBe(403);
      } finally { await db.query("UPDATE user_roles SET role = 'contributor' WHERE user_id = $1", [MOWN.id]); }
    });

    test('the access review builds on the real schema and reports the shares', async () => {
      const report = await require('../../lib/accessReview').build();
      const rw = report.users.find(u => u.email === MRW.email);
      expect(rw.libraryAccess).toContain('Moves (Read-Write, direct)');
      expect(report.users.find(u => u.email === MCLAIM.email).libraryAccess).toEqual([]);
    });
  });
});

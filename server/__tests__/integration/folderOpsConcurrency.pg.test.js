'use strict';
/* Piece 4's other half, against a REAL, THROWAWAY Postgres: NOTHING MAY PLACE A DOCUMENT
 * BY NAME WHILE A FOLDER OPERATION RUNS.
 *
 * The folder operations hold the library's tree lock exclusively and rewrite every path
 * in one transaction. Every write that puts a name into that tree -- an upload, a blank
 * file, a folder's .keep marker, a chunked upload completing, a restore -- takes the same
 * lock in SHARED mode, so placements run alongside each other but never inside a folder
 * operation. Without that, an INSERT landing between the exclusivity check and the
 * commit produces exactly the folder merge whatIsAt() exists to refuse (the check is a
 * point-in-time EXISTS under READ COMMITTED, and there is no unique index on
 * documents(library_id, name) behind it), and a file can land at a path the operation has
 * just vacated -- outside the share that travelled with the folder.
 *
 * The interleaving is driven through folderOps.hooks.beforeStatement, as accessKeys.hooks
 * drives the access lists: the placement is fired when the rename's documents UPDATE is
 * about to run, and the tree's own lock queue (pg_locks) is what the test waits on, so
 * nothing here depends on a sleep being long enough.
 *
 * It DROPS AND RECREATES THE WHOLE public SCHEMA, so it refuses to run unless the
 * database name contains "test":
 *
 *   MEMEX_TEST_PG_URL=postgres://user:pass@localhost:5432/memex_folder_test \
 *     npx jest --runInBand --testTimeout=60000 integration/folderOpsConcurrency.pg
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const PG = process.env.MEMEX_TEST_PG_URL;
const suite = PG ? describe : describe.skip;
if (PG) jest.setTimeout(180000);

jest.mock('jsonwebtoken');
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn(() => ({ getSigningKey: async () => ({ getPublicKey: () => 'k' }) })) }));
jest.mock('../../lib/auditLog', () => ({ append: jest.fn(async () => ({})) }));
jest.mock('../../lib/storage', () => {
  const tmp = require('path').join(require('os').tmpdir(), 'memex-folderops-concurrency');
  return {
    upload: jest.fn(async () => {}), download: jest.fn(async () => Buffer.alloc(0)), copy: jest.fn(async () => {}), del: jest.fn(async () => {}),
    // the chunked path streams the assembled file in: drain it, as the real one does
    uploadStream: jest.fn(async (_p, stream) => { for await (const _c of stream) { /* drained */ } return { size: 0 }; }),
    downloadStream: jest.fn(async () => ({ stream: require('stream').Readable.from([Buffer.from('bytes')]), length: 5 })),
    isLocalProvider: jest.fn(async () => true), getUrl: jest.fn(), localBase: jest.fn(async () => tmp), validateLocalToken: jest.fn(),
  };
});
jest.mock('../../lib/notifications', () => ({ create: jest.fn(async () => ({})) }));
jest.mock('../../lib/emailEvents', () => ({ send: jest.fn(async () => ({})) }));

const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const LIB = U(90);
const SESSION = U(70);
const OWNER = { id: U(2), email: 'owner@acme.test', role: 'contributor' };
const OTHER = { id: U(3), email: 'other@acme.test', role: 'contributor' };
const ADMIN = { id: U(1), email: 'admin@acme.test', role: 'admin' };

suite('placements and folder operations against real Postgres', () => {
  let db, folderOps, folderLocks, request, app, jwt;
  const reset = () => db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');

  beforeAll(async () => {
    const dbName = decodeURIComponent(new URL(PG).pathname.slice(1));
    if (!/test/i.test(dbName)) throw new Error(`refusing to run: "${dbName}" does not look like a throwaway test database`);
    process.env.DATABASE_URL = PG;
    db = require('../../lib/db');
    folderOps = require('../../lib/folderOps');
    folderLocks = require('../../lib/folderLocks');
    await reset();
    await db.query(fs.readFileSync(path.join(__dirname, '../../../postgres/init/01_schema.sql'), 'utf8'));
    await require('../../lib/migrations').run();
    fs.mkdirSync(path.join(os.tmpdir(), 'memex-folderops-concurrency'), { recursive: true });
    jwt = require('jsonwebtoken');
    jwt.decode.mockReturnValue({ header: { kid: 'k' } });
    request = require('supertest');
    const express = require('express');
    app = express();
    app.use(express.json());
    app.use('/api/files', require('../../routes/files'));
  });

  afterEach(() => { folderOps.hooks.beforeStatement = null; });

  afterAll(async () => {
    try { await reset(); } catch { /* best effort */ }
    try { await db.end(); } catch { /* already closed */ }
  });

  const as = (p) => { jwt.verify.mockReturnValue({ sub: p.id, email: p.email, email_verified: true }); return request(app); };
  const authed = (r) => r.set('Authorization', 'Bearer t').set('x-library-id', LIB);
  const names = async () => (await db.query('SELECT name FROM documents WHERE library_id = $1 AND deleted_at IS NULL ORDER BY name', [LIB])).map(r => r.name);
  const sharedPaths = async () => (await db.query('SELECT folder_path FROM library_grants WHERE library_id = $1 ORDER BY folder_path', [LIB])).map(r => r.folder_path);

  // Invariant D: no share may be left on a path with nothing under it. An empty shared
  // name is a trap -- whatever folder takes that name next is shared with whoever the
  // old share named, without anybody deciding that.
  const sharesOverNothing = async () => db.query(
    `SELECT g.folder_path FROM library_grants g
      WHERE g.library_id = $1 AND g.folder_path <> ''
        AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.library_id = g.library_id AND d.deleted_at IS NULL
                         AND starts_with(d.name, g.folder_path || '/'))`, [LIB]);

  // How many transactions are queued behind somebody else's advisory lock. This is what
  // the test waits on instead of a sleep: a placement that has reached the tree lock and
  // cannot have it is exactly one waiter here.
  const waitingForTheTree = async () =>
    (await db.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted"))[0].n;
  async function until(what, predicate, ms = 15000) {
    const deadline = Date.now() + ms;
    for (;;) {
      if (await predicate()) return;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise(r => setTimeout(r, 20));
    }
  }

  async function fixture({ docs = ['Clients/Mender/a.pdf'], shares = ['Clients/Mender'], session = null } = {}) {
    await db.query('TRUNCATE upload_sessions, document_acl, library_grants, folder_ops, documents, libraries, user_roles CASCADE');
    for (const p of [ADMIN, OWNER, OTHER]) {
      await db.query('INSERT INTO user_roles (user_id, email, role, verified_email) VALUES ($1, $2, $3, $2)', [p.id, p.email, p.role]);
    }
    await db.query('INSERT INTO libraries (id, name, owner_id, owner_email) VALUES ($1, $2, $3, $4)', [LIB, 'Clients', OWNER.id, OWNER.email]);
    for (const name of docs) {
      await db.query(
        `INSERT INTO documents (name, size, mime_type, storage_path, uploaded_by, uploaded_by_email, library_id, library_scoped)
         VALUES ($1, 10, 'text/plain', $2, $3, $4, $5, true)`,
        [name, `store/${Math.random()}`, OWNER.id, OWNER.email, LIB]);
    }
    for (const p of shares) {
      await db.query(
        `INSERT INTO library_grants (library_id, folder_path, subject_type, subject_email, permission) VALUES ($1, $2, 'user', $3, 'read')`,
        [LIB, p, OTHER.email]);
    }
    if (session) {
      await db.query(
        `INSERT INTO upload_sessions (id, name, size, mime_type, storage_path, chunk_size, total_chunks, received_chunks,
                                      uploaded_by, uploaded_by_email, status, library_id)
         VALUES ($1, $2, 0, 'application/octet-stream', $3, 8388608, 0, '{}', $4, $5, 'active', $6)`,
        [SESSION, session, `store/${SESSION}`, OWNER.id, OWNER.email, LIB]);
    }
  }

  /* Run `placement` (a function returning a supertest promise) so that it reaches the
   * library's tree lock while the rename is between its documents UPDATE and its
   * library_grants UPDATE -- the window where the paths have moved and the shares have
   * not. Returns both answers, plus what a reader outside the transaction could see of
   * the placement at the moment the grants were rewritten.
   */
  async function interleave(rename, placement) {
    let fired = null;
    let visibleMidOperation = null;
    folderOps.hooks.beforeStatement = async (sql) => {
      if (!fired && /UPDATE documents d SET name =/.test(sql)) {
        // .then() is what dispatches a supertest request: assigning the Test object alone
        // never sends it. Started, not awaited -- it is about to block on the lock.
        fired = placement().then(r => r);
        await until('the placement to queue behind the tree lock', async () => (await waitingForTheTree()) >= 1);
      } else if (fired && visibleMidOperation === null && /UPDATE library_grants g\s+SET folder_path =/.test(sql)) {
        // A separate connection, so this sees only what has COMMITTED. Anything the
        // placement has written is still invisible if it is waiting, as it must be.
        visibleMidOperation = await db.query(
          'SELECT name FROM documents WHERE library_id = $1 AND created_at > NOW() - interval \'1 minute\' AND name LIKE $2', [LIB, '%late%']);
      }
    };
    const renamed = await rename();
    const placed = await fired;
    return { renamed, placed, visibleMidOperation };
  }

  const rename = () => authed(as(OWNER).post('/api/files/folder/rename')).send({ path: 'Clients/Mender', name: 'Mender LLC' });

  test('a blank file made at the destination name waits, instead of merging two folders past the check that refuses it', async () => {
    await fixture();
    // 'Clients/Mender LLC' is where the folder is going. The exclusivity check has
    // already found nothing there when this fires; without the lock the INSERT commits
    // inside the operation and the merge whatIsAt() refuses happens anyway.
    const { renamed, placed, visibleMidOperation } = await interleave(rename, () =>
      authed(as(OWNER).post('/api/files/create')).send({ name: 'late', type: 'txt', folder: 'Clients/Mender LLC', library_id: LIB }));

    expect(renamed.status).toBe(200);
    expect(placed.status).toBe(200);
    expect(visibleMidOperation).toEqual([]); // it waited: nothing of it had committed
    expect(await names()).toEqual(['Clients/Mender LLC/a.pdf', 'Clients/Mender LLC/late.txt']);
    expect(await sharedPaths()).toEqual(['Clients/Mender LLC']); // the share came along
    expect(await sharesOverNothing()).toEqual([]);               // invariant D
  });

  test('a folder created at the destination name waits too (the .keep marker is a placement)', async () => {
    await fixture();
    const { renamed, placed, visibleMidOperation } = await interleave(rename, () =>
      authed(as(OWNER).post('/api/files/folder')).send({ path: 'Clients/Mender LLC/late', library_id: LIB }));

    expect([renamed.status, placed.status]).toEqual([200, 200]);
    expect(visibleMidOperation).toEqual([]);
    expect(await names()).toEqual(['Clients/Mender LLC/a.pdf', 'Clients/Mender LLC/late/.keep']);
    expect(await sharedPaths()).toEqual(['Clients/Mender LLC']);
    expect(await sharesOverNothing()).toEqual([]);
  });

  // The sharp one. A chunked upload's name is the full path it will land at, and a rename
  // carries it along with everything else (lib/folderCarry). Completing it under the lock
  // therefore reads the name the folder HAS, so the file lands inside the renamed folder
  // and under the share that travelled with it -- not at the path just vacated.
  test('a chunked upload completing mid-rename lands inside the renamed folder, under the share that moved with it', async () => {
    await fixture({ session: 'Clients/Mender/late.bin' });
    const { renamed, placed, visibleMidOperation } = await interleave(rename, () =>
      authed(as(OWNER).post(`/api/files/uploads/${SESSION}/complete`)).send({}));

    expect([renamed.status, placed.status]).toEqual([200, 200]);
    expect(visibleMidOperation).toEqual([]);
    expect(placed.body.doc.name).toBe('Clients/Mender LLC/late.bin');
    expect(await names()).toEqual(['Clients/Mender LLC/a.pdf', 'Clients/Mender LLC/late.bin']);
    expect(await sharedPaths()).toEqual(['Clients/Mender LLC']);
    expect(await sharesOverNothing()).toEqual([]);
  });

  test('placements do not block each other: the lock they take is shared', async () => {
    await fixture();
    let release;
    const held = new Promise(r => { release = r; });
    const holder = db.withTransaction(async (client) => {
      await folderLocks.session(client, 'placement');
      await folderLocks.tree(client, [LIB], 'shared');
      await held;
    });
    try {
      const res = await authed(as(OWNER).post('/api/files/create')).send({ name: 'alongside', type: 'txt', folder: 'Clients/Mender', library_id: LIB });
      expect(res.status).toBe(200);
    } finally { release(); await holder; }
    expect(await names()).toEqual(['Clients/Mender/a.pdf', 'Clients/Mender/alongside.txt']);
  });

  test('a folder operation holding the tree lock makes a placement wait for it, not fail', async () => {
    await fixture();
    let release;
    const held = new Promise(r => { release = r; });
    const holder = db.withTransaction(async (client) => {
      await folderLocks.session(client, 'folder');
      await folderLocks.tree(client, [LIB], 'exclusive');
      await held;
    });
    let settled = false;
    const placing = authed(as(OWNER).post('/api/files/create'))
      .send({ name: 'patient', type: 'txt', folder: 'Clients/Mender', library_id: LIB })
      .then((r) => { settled = true; return r; });
    try {
      await until('the placement to queue behind the tree lock', async () => (await waitingForTheTree()) >= 1);
      expect(settled).toBe(false);
    } finally { release(); await holder; }
    expect((await placing).status).toBe(200);
    expect(await names()).toEqual(['Clients/Mender/a.pdf', 'Clients/Mender/patient.txt']);
  });
});

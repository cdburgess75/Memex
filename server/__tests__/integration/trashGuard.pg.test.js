'use strict';
// A folder share must not reach files that were already in the Trash when it was made
// (piece 4, invariant A), against a REAL, THROWAWAY Postgres.
//
// Folder shares are keyed by a NAME, and names come round again: delete "Clients/Mender",
// make a new folder of that name for another client months later, share it, and without
// the guard the new people find the old client's deleted files in their Trash -- and can
// restore them. A whole-library share is deliberately not guarded: a library's identity
// is its id, which is never reused.
//
// It DROPS AND RECREATES THE WHOLE public SCHEMA, so it refuses to run unless the
// database name contains "test":
//
//   MEMEX_TEST_PG_URL=postgres://user:pass@localhost:5432/memex_trash_test \
//     npx jest --runInBand integration/trashGuard.pg
const fs = require('fs');
const path = require('path');

const PG = process.env.MEMEX_TEST_PG_URL;
const suite = PG ? describe : describe.skip;
if (PG) jest.setTimeout(120000);

jest.mock('jsonwebtoken');
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn(() => ({ getSigningKey: async () => ({ getPublicKey: () => 'k' }) })) }));
jest.mock('../../lib/auditLog', () => ({ append: jest.fn(async () => ({})) }));
jest.mock('../../lib/storage', () => ({
  upload: jest.fn(async () => {}), download: jest.fn(async () => Buffer.alloc(0)), copy: jest.fn(async () => {}), del: jest.fn(async () => {}),
  downloadStream: jest.fn(async () => ({ stream: require('stream').Readable.from([Buffer.from('bytes')]), length: 5 })),
  isLocalProvider: jest.fn(async () => true), getUrl: jest.fn(), localBase: jest.fn(), validateLocalToken: jest.fn(),
}));
jest.mock('../../lib/notifications', () => ({ create: jest.fn(async () => ({})) }));
jest.mock('../../lib/emailEvents', () => ({ send: jest.fn(async () => ({})) }));

const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const LIB = U(90);
const PEOPLE = {
  admin: { id: U(1), email: 'admin@acme.test', role: 'admin' },
  owner: { id: U(2), email: 'owner@acme.test', role: 'contributor' },
  before: { id: U(3), email: 'before@acme.test', role: 'contributor' },   // shared the folder BEFORE the delete
  after: { id: U(4), email: 'after@acme.test', role: 'contributor' },     // shared the same name AFTER it
  whole: { id: U(5), email: 'whole@acme.test', role: 'contributor' },     // shared the whole library, after
  stranger: { id: U(6), email: 'stranger@acme.test', role: 'contributor' },
};
const DOCS = { trashed: U(20), live: U(21), elsewhere: U(22) };

suite('a folder share does not reach what was already in the Trash', () => {
  let db, request, app, jwt;
  const reset = () => db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');

  beforeAll(async () => {
    const dbName = decodeURIComponent(new URL(PG).pathname.slice(1));
    if (!/test/i.test(dbName)) throw new Error(`refusing to run: "${dbName}" does not look like a throwaway test database`);
    process.env.DATABASE_URL = PG;
    db = require('../../lib/db');
    await reset();
    await db.query(fs.readFileSync(path.join(__dirname, '../../../postgres/init/01_schema.sql'), 'utf8'));
    await require('../../lib/migrations').run();
    jwt = require('jsonwebtoken');
    jwt.decode.mockReturnValue({ header: { kid: 'k' } });
    request = require('supertest');
    const express = require('express');
    app = express();
    app.use(express.json());
    app.use('/api/files', require('../../routes/files'));

    for (const p of Object.values(PEOPLE)) {
      await db.query('INSERT INTO user_roles (user_id, email, role, verified_email) VALUES ($1, $2, $3, $2)', [p.id, p.email, p.role]);
    }
    await db.query('INSERT INTO libraries (id, name, owner_id, owner_email) VALUES ($1, $2, $3, $4)', [LIB, 'Clients', PEOPLE.owner.id, PEOPLE.owner.email]);
    const doc = (id, name, deletedDaysAgo) => db.query(
      `INSERT INTO documents (id, name, size, mime_type, storage_path, uploaded_by, uploaded_by_email, library_id, library_scoped, deleted_at)
       VALUES ($1, $2, 10, 'text/plain', $7, $3, $4, $5, true, CASE WHEN $6::int IS NULL THEN NULL ELSE NOW() - make_interval(days => $6::int) END)`,
      [id, name, PEOPLE.owner.id, PEOPLE.owner.email, LIB, deletedDaysAgo, `store/${id}`]);
    await doc(DOCS.trashed, 'Clients/Mender/last-year.pdf', 30);   // deleted 30 days ago
    await doc(DOCS.live, 'Clients/Mender/this-year.pdf', null);    // still there
    await doc(DOCS.elsewhere, 'Clients/Other/x.pdf', null);
    const share = (email, folder, daysAgo) => db.query(
      `INSERT INTO library_grants (library_id, folder_path, subject_type, subject_email, permission, created_at)
       VALUES ($1, $2, 'user', $3, 'write', NOW() - make_interval(days => $4::int))`,
      [LIB, folder, email, daysAgo]);
    await share(PEOPLE.before.email, 'Clients/Mender', 60);        // before the delete
    await share(PEOPLE.after.email, 'Clients/Mender', 5);          // after it
    await share(PEOPLE.whole.email, '', 5);                        // the whole library, after it
  });

  afterAll(async () => {
    try { await reset(); } catch { /* best effort */ }
    try { await db.end(); } catch { /* already closed */ }
  });

  const as = (p) => { jwt.verify.mockReturnValue({ sub: p.id, email: p.email, email_verified: true }); return request(app); };
  const authed = (r) => r.set('Authorization', 'Bearer t');
  const trashIds = async (p) => (await authed(as(p).get('/api/files/trash'))).body.map(d => String(d.id));
  const liveIds = async (p) => (await authed(as(p).get(`/api/files?library=${LIB}`))).body.map(d => String(d.id));

  test('the Trash shows a deleted file only to people who could already reach it', async () => {
    expect(await trashIds(PEOPLE.before)).toContain(DOCS.trashed);
    expect(await trashIds(PEOPLE.after)).not.toContain(DOCS.trashed);
    expect(await trashIds(PEOPLE.stranger)).not.toContain(DOCS.trashed);
    expect(await trashIds(PEOPLE.owner)).toContain(DOCS.trashed);
    expect(await trashIds(PEOPLE.admin)).toContain(DOCS.trashed);
    // a share of the WHOLE library is not guarded: a library id is never reused
    expect(await trashIds(PEOPLE.whole)).toContain(DOCS.trashed);
  });

  test('nothing changes for files that are still there', async () => {
    for (const p of [PEOPLE.before, PEOPLE.after, PEOPLE.owner, PEOPLE.admin, PEOPLE.whole]) {
      expect([p.email, await liveIds(p)]).toEqual([p.email, expect.arrayContaining([DOCS.live])]);
    }
    expect(await liveIds(PEOPLE.stranger)).not.toContain(DOCS.live);
    expect(await liveIds(PEOPLE.after)).not.toContain(DOCS.elsewhere); // the share is one folder, as before
  });

  test('restoring, and a file version, are refused to the same people', async () => {
    expect((await authed(as(PEOPLE.after).post(`/api/files/${DOCS.trashed}/restore`))).status).toBe(404);
    expect((await authed(as(PEOPLE.stranger).post(`/api/files/${DOCS.trashed}/restore`))).status).toBe(404);
    const { id: versionId } = await db.queryOne(
      `INSERT INTO document_versions (document_id, version_number, name, size, mime_type, storage_path, saved_by, saved_by_email)
       VALUES ($1, 1, 'last-year.pdf', 10, 'text/plain', 'v1', $2, $3) RETURNING id`,
      [DOCS.trashed, PEOPLE.owner.id, PEOPLE.owner.email]);
    expect((await authed(as(PEOPLE.after).post(`/api/files/${DOCS.trashed}/restore-version/${versionId}`))).status).toBe(404);
    // and whoever could already reach it still can
    expect((await authed(as(PEOPLE.before).post(`/api/files/${DOCS.trashed}/restore`))).status).toBe(200);
    const row = await db.queryOne('SELECT deleted_at FROM documents WHERE id = $1', [DOCS.trashed]);
    expect(row.deleted_at).toBeNull();
  });

  test('once restored, it is an ordinary file again, open to everyone the folder is shared with', async () => {
    expect(await liveIds(PEOPLE.after)).toContain(DOCS.trashed);
    expect(await trashIds(PEOPLE.before)).not.toContain(DOCS.trashed);
  });
});

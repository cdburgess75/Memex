'use strict';
// Folder operations against a REAL, THROWAWAY Postgres (piece 4). This part covers the
// refusals: nothing may be renamed or moved ONTO an existing folder, because merging two
// folders would mix their sharing -- each side's people would gain the other's files --
// and a folder sitting in the Trash still holds its name, so it must say so rather than
// point at a folder nobody can see. Someone else's personal folder of the same name is
// neither a clash nor revealed: no share can reach it.
//
// It DROPS AND RECREATES THE WHOLE public SCHEMA, so it refuses to run unless the
// database name contains "test":
//
//   MEMEX_TEST_PG_URL=postgres://user:pass@localhost:5432/memex_folder_test \
//     npx jest --runInBand integration/folderOps.pg
const fs = require('fs');
const path = require('path');

const PG = process.env.MEMEX_TEST_PG_URL;
const suite = PG ? describe : describe.skip;
if (PG) jest.setTimeout(180000);

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
const LIB2 = U(91);
const OWNER = { id: U(2), email: 'owner@acme.test', role: 'contributor' };
const OTHER = { id: U(3), email: 'other@acme.test', role: 'contributor' };
const ADMIN = { id: U(1), email: 'admin@acme.test', role: 'admin' };

suite('folder operations against real Postgres', () => {
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
    app.use('/api/libraries', require('../../routes/libraries'));
  });

  afterAll(async () => {
    try { await reset(); } catch { /* best effort */ }
    try { await db.end(); } catch { /* already closed */ }
  });

  const as = (p) => { jwt.verify.mockReturnValue({ sub: p.id, email: p.email, email_verified: true }); return request(app); };
  const authed = (r, lib = LIB) => r.set('Authorization', 'Bearer t').set('x-library-id', lib);
  const names = async (lib = LIB) => (await db.query('SELECT name FROM documents WHERE library_id = $1 AND deleted_at IS NULL ORDER BY name', [lib])).map(r => r.name);

  async function fixture({ docs, shares = [], trashed = [] }) {
    await db.query('TRUNCATE document_acl, library_grants, documents, libraries, user_roles CASCADE');
    for (const p of [ADMIN, OWNER, OTHER]) {
      await db.query('INSERT INTO user_roles (user_id, email, role, verified_email) VALUES ($1, $2, $3, $2)', [p.id, p.email, p.role]);
    }
    for (const [id, name] of [[LIB, 'Clients'], [LIB2, 'Archive']]) {
      await db.query('INSERT INTO libraries (id, name, owner_id, owner_email) VALUES ($1, $2, $3, $4)', [id, name, OWNER.id, OWNER.email]);
    }
    const add = async (name, { lib = LIB, by = OWNER, scoped = true, deleted = false } = {}) => db.query(
      `INSERT INTO documents (name, size, mime_type, storage_path, uploaded_by, uploaded_by_email, library_id, library_scoped, deleted_at)
       VALUES ($1, 10, 'text/plain', $6, $2, $3, $4, $5, CASE WHEN $7 THEN NOW() - interval '2 days' END)`,
      [name, by.id, by.email, lib, scoped, `store/${Math.random()}`, deleted]);
    for (const d of docs) await add(d.name, d);
    for (const d of trashed) await add(d.name, { ...d, deleted: true });
    for (const s of shares) {
      await db.query(
        `INSERT INTO library_grants (library_id, folder_path, subject_type, subject_email, permission) VALUES ($1, $2, 'user', $3, $4)`,
        [s.lib || LIB, s.path, s.email || OTHER.email, s.permission || 'read']);
    }
  }

  test('a rename onto an existing folder is refused, and moves nothing', async () => {
    await fixture({ docs: [{ name: 'Clients/Mender/a.pdf' }, { name: 'Clients/Mender LLC/b.pdf' }] });
    const res = await authed(as(OWNER).post('/api/files/folder/rename')).send({ path: 'Clients/Mender', name: 'Mender LLC' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('FOLDER_EXISTS');
    expect(res.body.error).toContain('“Mender LLC”');
    expect(await names()).toEqual(['Clients/Mender LLC/b.pdf', 'Clients/Mender/a.pdf']);
  });

  test('a folder of that name in the Trash blocks it too, and says when it was deleted', async () => {
    await fixture({ docs: [{ name: 'Clients/Mender/a.pdf' }], trashed: [{ name: 'Clients/Mender LLC/old.pdf' }] });
    const res = await authed(as(OWNER).post('/api/files/folder/rename')).send({ path: 'Clients/Mender', name: 'Mender LLC' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('FOLDER_EXISTS_IN_TRASH');
    expect(res.body.error).toMatch(/was deleted there on \d+ \w+ \d{4}/);
    expect(await names()).toEqual(['Clients/Mender/a.pdf']);
  });

  test("somebody else's private folder of that name is neither a clash nor revealed", async () => {
    await fixture({ docs: [{ name: 'Clients/Mender/a.pdf' }, { name: 'Clients/Mender LLC/secret.pdf', by: OTHER, scoped: false }] });
    const res = await authed(as(OWNER).post('/api/files/folder/rename')).send({ path: 'Clients/Mender', name: 'Mender LLC' });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('secret');
    expect(await names()).toEqual(['Clients/Mender LLC/a.pdf', 'Clients/Mender LLC/secret.pdf']);
  });

  test('a share at the destination counts as a folder being there', async () => {
    await fixture({ docs: [{ name: 'Clients/Mender/a.pdf' }], shares: [{ path: 'Clients/Empty Shared' }] });
    const res = await authed(as(OWNER).post('/api/files/folder/rename')).send({ path: 'Clients/Mender', name: 'Empty Shared' });
    expect([res.status, res.body.code]).toEqual([409, 'FOLDER_EXISTS']);
  });

  test('renaming a folder to the name it already has does nothing at all', async () => {
    await fixture({ docs: [{ name: 'Clients/Mender/a.pdf' }] });
    const res = await authed(as(OWNER).post('/api/files/folder/rename')).send({ path: 'Clients/Mender', name: 'Mender' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, path: 'Clients/Mender', op_id: null, count: 0, shares_kept: false });
    expect(await names()).toEqual(['Clients/Mender/a.pdf']);
  });

  test('moving a folder where one of that name already sits is refused', async () => {
    await fixture({ docs: [{ name: 'Clients/Mender/a.pdf' }, { name: 'Archive/Mender/old.pdf' }] });
    const res = await authed(as(OWNER).post('/api/files/folder/reparent')).send({ path: 'Clients/Mender', target: 'Archive' });
    expect([res.status, res.body.code]).toEqual([409, 'FOLDER_EXISTS']);
    expect(await names()).toContain('Clients/Mender/a.pdf');
  });

  test('a folder moved up onto its own parent name is not a clash with itself', async () => {
    await fixture({ docs: [{ name: 'P/P/a.pdf' }] });
    const res = await authed(as(OWNER).post('/api/files/folder/reparent')).send({ path: 'P/P', target: '' });
    expect(res.status).toBe(200);
    expect(await names()).toEqual(['P/a.pdf']);
  });

  test('moving to another library that already has that folder is refused; the same library is not affected', async () => {
    await fixture({ docs: [{ name: 'Mender/a.pdf' }, { name: 'Mender/old.pdf', lib: LIB2 }] });
    const res = await authed(as(OWNER).post('/api/files/folder/move')).send({ path: 'Mender', library_id: LIB2 });
    expect([res.status, res.body.code]).toEqual([409, 'FOLDER_EXISTS']);
    expect(await names(LIB2)).toEqual(['Mender/old.pdf']);
    const same = await authed(as(OWNER).post('/api/files/folder/move')).send({ path: 'Mender', library_id: LIB });
    expect(same.status).toBe(200);
  });

  describe('an emptied shared folder stays', () => {
    const keeps = async (lib = LIB) => (await db.query(
      "SELECT name, uploaded_by, library_scoped FROM documents WHERE library_id = $1 AND name LIKE '%/.keep' AND deleted_at IS NULL ORDER BY name", [lib])).rows ?? [];
    const rows = async (sql, params) => db.query(sql, params);

    test('trashing the last file in a shared folder keeps the folder, empty and still shared', async () => {
      await fixture({ docs: [{ name: 'Clients/Mender/only.pdf' }], shares: [{ path: 'Clients/Mender' }] });
      const doc = await db.queryOne("SELECT id FROM documents WHERE name = 'Clients/Mender/only.pdf'");
      expect((await authed(as(OWNER).delete(`/api/files/${doc.id}`))).status).toBe(200);
      const kept = await rows("SELECT name, uploaded_by, library_scoped FROM documents WHERE library_id = $1 AND deleted_at IS NULL", [LIB]);
      expect(kept.map(r => r.name)).toEqual(['Clients/Mender/.keep']);
      // it belongs to the library, has no uploader, and so gives nobody anything new
      expect([kept[0].uploaded_by, kept[0].library_scoped]).toEqual([null, true]);
      // and the share still points at a folder that exists
      expect(await names()).toEqual(['Clients/Mender/.keep']);
    });

    test('moving the last file out of a shared folder keeps it too', async () => {
      await fixture({ docs: [{ name: 'Clients/Mender/only.pdf' }, { name: 'Clients/Other/x.pdf' }], shares: [{ path: 'Clients/Mender' }] });
      const doc = await db.queryOne("SELECT id FROM documents WHERE name = 'Clients/Mender/only.pdf'");
      const res = await authed(as(OWNER).put(`/api/files/${doc.id}/rename`)).send({ name: 'Clients/Other/only.pdf' });
      expect(res.status).toBe(200);
      expect(await names()).toEqual(['Clients/Mender/.keep', 'Clients/Other/only.pdf', 'Clients/Other/x.pdf']);
    });

    test('taking the last file to another library keeps it', async () => {
      await fixture({ docs: [{ name: 'Clients/Mender/only.pdf' }], shares: [{ path: 'Clients/Mender' }] });
      const doc = await db.queryOne("SELECT id FROM documents WHERE name = 'Clients/Mender/only.pdf'");
      const res = await authed(as(OWNER).post('/api/files/library-transfer')).send({ ids: [doc.id], libraryId: LIB2, mode: 'move' });
      expect(res.status).toBe(200);
      expect(await names()).toEqual(['Clients/Mender/.keep']);
      expect(await names(LIB2)).toEqual(['Clients/Mender/only.pdf']);
    });

    test('a folder nobody shares is not kept alive', async () => {
      await fixture({ docs: [{ name: 'Clients/Private/only.pdf' }] });
      const doc = await db.queryOne("SELECT id FROM documents WHERE name = 'Clients/Private/only.pdf'");
      expect((await authed(as(OWNER).delete(`/api/files/${doc.id}`))).status).toBe(200);
      expect(await names()).toEqual([]);
    });

    test('a folder that still holds something is not given a second marker', async () => {
      await fixture({ docs: [{ name: 'Clients/Mender/a.pdf' }, { name: 'Clients/Mender/b.pdf' }], shares: [{ path: 'Clients/Mender' }] });
      const doc = await db.queryOne("SELECT id FROM documents WHERE name = 'Clients/Mender/a.pdf'");
      expect((await authed(as(OWNER).delete(`/api/files/${doc.id}`))).status).toBe(200);
      expect(await names()).toEqual(['Clients/Mender/b.pdf']);
    });

    test('the folder above is kept when a share sits on it', async () => {
      await fixture({ docs: [{ name: 'Clients/Mender/Deep/only.pdf' }], shares: [{ path: 'Clients/Mender' }] });
      const doc = await db.queryOne("SELECT id FROM documents WHERE name = 'Clients/Mender/Deep/only.pdf'");
      expect((await authed(as(OWNER).delete(`/api/files/${doc.id}`))).status).toBe(200);
      expect(await names()).toEqual(['Clients/Mender/.keep']);
    });
    void keeps;
  });

  test('two renames of the same folder at once: one wins, and the library is left coherent', async () => {
    await fixture({ docs: [{ name: 'Clients/Mender/a.pdf' }, { name: 'Clients/Mender/b.pdf' }] });
    const [one, two] = await Promise.all([
      authed(as(OWNER).post('/api/files/folder/rename')).send({ path: 'Clients/Mender', name: 'First' }),
      authed(as(ADMIN).post('/api/files/folder/rename')).send({ path: 'Clients/Mender', name: 'Second' }),
    ]);
    const ok = [one, two].filter(r => r.status === 200 && r.body.count > 0);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    const left = await names();
    const folders = [...new Set(left.map(n => n.split('/').slice(0, 2).join('/')))];
    expect(folders).toHaveLength(1); // never half in one name and half in the other
    expect(left).toHaveLength(2);
  });
});

'use strict';
// A library opens one folder at a time -- through the real file router, against a REAL,
// THROWAWAY Postgres. Whatever someone may see, the folder answers (folder=, folders) must
// add up to exactly what the whole-library list says, and the search and favourites
// answers must never show a file the whole list would not. DROPS AND RECREATES the public
// schema; refuses to run unless the database name contains "test".
const fs = require('fs');
const path = require('path');

const PG = process.env.MEMEX_TEST_PG_URL;
const suite = PG ? describe : describe.skip;
if (PG) jest.setTimeout(120000);

jest.mock('jsonwebtoken');
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn(() => ({ getSigningKey: async () => ({ getPublicKey: () => 'k' }) })) }));
jest.mock('../../lib/auditLog', () => ({ append: jest.fn(async () => ({})) }));

const U = (n) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
const OWNER = { id: U(1), email: 'owner@corp.test' }, MEMBER = { id: U(2), email: 'member@corp.test' };
const ADMIN = { id: U(3), email: 'admin@corp.test' }, FOLDERONLY = { id: U(4), email: 'folder@corp.test' };
const LIB = U(50), OTHER_LIB = U(51);

suite('one folder at a time, through the real router and a real database', () => {
  let db, request, app, jwt;
  const reset = () => db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const doc = (name, by, lib = LIB, trashed = false) => db.queryOne(
    `INSERT INTO documents (name, size, mime_type, storage_path, uploaded_by, uploaded_by_email, library_id, library_scoped, deleted_at)
     VALUES ($1, 1, 'application/octet-stream', 'seed/' || md5($1), $2, $3, $4, true, CASE WHEN $5 THEN NOW() END) RETURNING id`,
    [name, by.id, by.email, lib, trashed]);

  beforeAll(async () => {
    const dbName = decodeURIComponent(new URL(PG).pathname.slice(1));
    if (!/test/i.test(dbName)) throw new Error(`refusing to run: "${dbName}" does not look like a throwaway test database`);
    process.env.DATABASE_URL = PG;
    db = require('../../lib/db');
    await reset();
    await db.query(fs.readFileSync(path.join(__dirname, '../../../postgres/init/01_schema.sql'), 'utf8'));
    await require('../../lib/migrations').run();
    for (const [a, role] of [[OWNER, 'contributor'], [MEMBER, 'contributor'], [ADMIN, 'admin'], [FOLDERONLY, 'contributor']]) {
      await db.query('INSERT INTO user_roles (user_id, email, role, verified_email) VALUES ($1, $2, $3, $2)', [a.id, a.email, role]);
    }
    await db.query('INSERT INTO libraries (id, name, owner_id, owner_email) VALUES ($1, $2, $3, $4), ($5, $6, $3, $4)', [LIB, '_Clients', OWNER.id, OWNER.email, OTHER_LIB, 'Other']);
    await db.query(`INSERT INTO library_grants (library_id, folder_path, subject_type, subject_email, permission, granted_by, granted_by_email)
                    VALUES ($1, '', 'user', $2, 'write', $3, $4), ($1, 'Acme/Contracts', 'user', $5, 'read', $3, $4)`,
      [LIB, MEMBER.email, OWNER.id, OWNER.email, FOLDERONLY.email]);
    for (const n of ['root.pdf', 'README', 'Acme/brief.pdf', 'Acme/Contracts/2024.pdf', 'Acme/Contracts/2025.pdf', 'Acme/Contracts/Old/1999.pdf',
      'Acme/Photos/a.jpg', 'Acme Two/x.pdf', 'Acme_/y.pdf', 'Empty/.keep', 'Acme/Contracts/Empty sub/.keep', '100%/z.pdf']) await doc(n, OWNER);
    await doc('Acme/Contracts/binned.pdf', OWNER, LIB, true);
    await doc('Acme/elsewhere.pdf', OWNER, OTHER_LIB);
    jwt = require('jsonwebtoken'); jwt.decode.mockReturnValue({ header: { kid: 'k' } });
    request = require('supertest');
    const express = require('express');
    app = express(); app.use(express.json());
    app.use('/api/files', require('../../routes/files'));
  });
  afterAll(async () => { try { await reset(); } catch { /* best effort */ } try { await db.end(); } catch { /* closed */ } });

  const get = (who, url, query) => { jwt.verify.mockReturnValue({ sub: who.id, email: who.email, email_verified: true }); return request(app).get(url).query(query).set('Authorization', 'Bearer t').expect(200).then(r => r.body); };
  const isKeep = (n) => /(^|\/)\.keep$/.test(n);

  test.each([['the owner', OWNER], ['a Read-Write member', MEMBER], ['an admin', ADMIN], ['someone given one folder', FOLDERONLY]])(
    'for %s, folder by folder adds up to the whole library', async (_n, who) => {
      const all = await get(who, '/api/files', { library: LIB });
      const folders = await get(who, '/api/files/folders', { library: LIB });
      // the folder list: every folder the whole list implies, with the files under it
      const want = new Map();
      for (const f of all) {
        const parts = f.name.split('/'); const base = parts.pop(); let acc = '';
        for (const p of parts) { acc = acc ? `${acc}/${p}` : p; want.set(acc, (want.get(acc) || 0) + (base === '.keep' ? 0 : 1)); }
      }
      expect(folders.map(f => [f.path, f.count])).toEqual([...want].sort((a, b) => a[0] < b[0] ? -1 : 1));
      expect(folders.every(f => f.name === f.path.split('/').pop())).toBe(true);
      // each folder's own files, and the root's
      let seen = 0;
      for (const folder of ['', ...want.keys()]) {
        const here = await get(who, '/api/files', { library: LIB, folder });
        const pre = folder ? folder + '/' : '';
        const expected = all.filter(f => f.name.startsWith(pre) && !f.name.slice(pre.length).includes('/') && !isKeep(f.name)).map(f => f.id).sort();
        expect(here.map(f => f.id).sort()).toEqual(expected);
        seen += here.length;
      }
      expect(seen).toBe(all.filter(f => !isKeep(f.name)).length);
    });

  test('a folder name is matched exactly: "Acme" is not "Acme Two" or "Acme_", and "%" is just a character', async () => {
    const acme = await get(OWNER, '/api/files', { library: LIB, folder: 'Acme' });
    expect(acme.map(f => f.name)).toEqual(['Acme/brief.pdf']);
    const pct = await get(OWNER, '/api/files', { library: LIB, folder: '100%' });
    expect(pct.map(f => f.name)).toEqual(['100%/z.pdf']);
    const slashes = await get(OWNER, '/api/files', { library: LIB, folder: '/Acme/' });
    expect(slashes.map(f => f.name)).toEqual(['Acme/brief.pdf']);
  });

  test('another library\'s files and the trash stay out', async () => {
    const contracts = await get(ADMIN, '/api/files', { library: LIB, folder: 'Acme/Contracts' });
    expect(contracts.map(f => f.name).sort()).toEqual(['Acme/Contracts/2024.pdf', 'Acme/Contracts/2025.pdf']);
  });

  test('search reaches every folder, matches by name or by who added it, and only what the caller may see', async () => {
    const byName = await get(OWNER, '/api/files', { library: LIB, q: '2025' });
    expect(byName.map(f => f.name)).toEqual(['Acme/Contracts/2025.pdf']);
    const byPerson = await get(OWNER, '/api/files', { library: LIB, q: 'owner@' });
    expect(byPerson.length).toBe(10);                                   // every live file, markers left out
    const limited = await get(FOLDERONLY, '/api/files', { library: LIB, q: '.pdf' });
    expect(limited.map(f => f.name).sort()).toEqual(['Acme/Contracts/2024.pdf', 'Acme/Contracts/2025.pdf', 'Acme/Contracts/Old/1999.pdf']);
    const wild = await get(OWNER, '/api/files', { library: LIB, q: '_' });
    expect(wild.map(f => f.name)).toEqual(['Acme_/y.pdf']);
  });

  test('favourites by id: only live files the caller can read; nonsense ids are ignored', async () => {
    const all = await get(OWNER, '/api/files', { library: LIB });
    const id = (n) => all.find(f => f.name === n).id;
    const ids = [id('root.pdf'), id('Acme/Contracts/2024.pdf'), 'nonsense', U(99)].join(',');
    expect((await get(OWNER, '/api/files', { library: LIB, ids })).map(f => f.name).sort()).toEqual(['Acme/Contracts/2024.pdf', 'root.pdf']);
    expect((await get(FOLDERONLY, '/api/files', { library: LIB, ids })).map(f => f.name)).toEqual(['Acme/Contracts/2024.pdf']);
  });
});

'use strict';
// Home and Admin no longer download every file. Home asks /api/files/summary, Admin asks
// /api/admin/files -- through the real routers, against a REAL, THROWAWAY Postgres.
// The test for the summary is that it says exactly what the page used to work out from
// the full list (GET /api/files), for every kind of person. DROPS AND RECREATES the
// public schema; refuses to run unless the database name contains "test".
const fs = require('fs');
const path = require('path');

const PG = process.env.MEMEX_TEST_PG_URL;
const suite = PG ? describe : describe.skip;
if (PG) jest.setTimeout(120000);

jest.mock('jsonwebtoken');
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn(() => ({ getSigningKey: async () => ({ getPublicKey: () => 'k' }) })) }));
jest.mock('../../lib/auditLog', () => ({ append: jest.fn(async () => ({})) }));

const U = (n) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
const OWNER = { id: U(1), email: 'owner@corp.test' }, MEMBER = { id: U(2), email: 'Member@corp.test' };
const ADMIN = { id: U(3), email: 'admin@corp.test' }, OTHER = { id: U(4), email: 'other@corp.test' };
const PROJECTS = U(50), OTHERS_OWN = U(51), ADMINS_OWN = U(52);
const GUIDE = 'Getting started with Depot.pdf';

// What index.html did with the full list, word for word where it matters.
function theOldWay(all, me) {
  const parts = (n) => String(n || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/').split('/').filter(Boolean);
  const display = (f) => parts(f.name).pop() || f.name;
  const files = all.filter(f => display(f) !== '.keep');
  const byLib = new Map();
  for (const f of files) {
    const k = String(f.library_id ?? '');
    const e = byLib.get(k) || { files: 0, bytes: 0, last: 0, folders: new Set() };
    e.files++; e.bytes += Number(f.size) || 0; e.last = Math.max(e.last, new Date(f.created_at).getTime());
    const p = parts(f.name); p.pop(); let acc = ''; for (const x of p) { acc = acc ? `${acc}/${x}` : x; e.folders.add(acc); }
    byLib.set(k, e);
  }
  const types = new Map();
  for (const f of files) { const ext = (display(f).split('.').pop() || '').toLowerCase(); const t = types.get(ext) || { n: 0, bytes: 0 }; t.n++; t.bytes += Number(f.size) || 0; types.set(ext, t); }
  const othersGuide = (f) => f.name === GUIDE && String(f.uploaded_by || '') !== String(me.id);
  return {
    totals: { files: files.length, bytes: files.reduce((s, f) => s + (Number(f.size) || 0), 0), others: files.filter(f => (f.uploaded_by_email || '').toLowerCase() !== me.email.toLowerCase()).length },
    libraries: [...byLib].map(([k, e]) => ({ library_id: k, files: e.files, folders: e.folders.size, bytes: e.bytes, last: e.last })).sort((a, b) => a.library_id.localeCompare(b.library_id)),
    types: [...types].map(([ext, t]) => ({ ext, ...t })).sort((a, b) => a.ext.localeCompare(b.ext)),
    recent: [...files].filter(f => !othersGuide(f)).sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 6).map(f => f.id),
  };
}
const shape = (s) => ({
  totals: s.totals,
  libraries: s.libraries.map(l => ({ library_id: String(l.library_id ?? ''), files: l.files, folders: l.folders, bytes: l.bytes, last: new Date(l.last).getTime() })).sort((a, b) => a.library_id.localeCompare(b.library_id)),
  types: [...s.types].sort((a, b) => a.ext.localeCompare(b.ext)),
  recent: s.recent.map(f => f.id),
});

suite('Home and Admin without the whole file list, through the real routers and a real database', () => {
  let db, request, app, jwt;
  const ids = {};
  const reset = () => db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const doc = async (key, name, size, by, lib, daysAgo, { scoped = true, trashed = false } = {}) => {
    const r = await db.queryOne(
      `INSERT INTO documents (name, size, mime_type, storage_path, uploaded_by, uploaded_by_email, library_id, library_scoped, created_at, deleted_at)
       VALUES ($1, $2, 'application/octet-stream', $3, $4, $5, $6, $7, NOW() - make_interval(days => $8::int, mins => $9::int), CASE WHEN $10 THEN NOW() END) RETURNING id`,
      [name, size, `seed/${key}`, by.id, by.email.toLowerCase(), lib, scoped, daysAgo, Object.keys(ids).length, trashed]);
    ids[key] = r.id;
  };

  beforeAll(async () => {
    const dbName = decodeURIComponent(new URL(PG).pathname.slice(1));
    if (!/test/i.test(dbName)) throw new Error(`refusing to run: "${dbName}" does not look like a throwaway test database`);
    process.env.DATABASE_URL = PG;
    db = require('../../lib/db');
    await reset();
    await db.query(fs.readFileSync(path.join(__dirname, '../../../postgres/init/01_schema.sql'), 'utf8'));
    await require('../../lib/migrations').run();
    for (const [a, role] of [[OWNER, 'contributor'], [MEMBER, 'contributor'], [ADMIN, 'admin'], [OTHER, 'contributor']]) {
      await db.query('INSERT INTO user_roles (user_id, email, role, verified_email) VALUES ($1, $2, $3, $2)', [a.id, a.email.toLowerCase(), role]);
    }
    await db.query('INSERT INTO libraries (id, name, owner_id, owner_email) VALUES ($1, $2, $3, $4)', [PROJECTS, 'Projects', OWNER.id, OWNER.email]);
    await db.query('INSERT INTO libraries (id, name, owner_id, owner_email, personal) VALUES ($1, $2, $3, $4, true)', [OTHERS_OWN, 'Other – My Library', OTHER.id, OTHER.email]);
    await db.query('INSERT INTO libraries (id, name, owner_id, owner_email, personal) VALUES ($1, $2, $3, $4, true)', [ADMINS_OWN, 'Admin – My Library', ADMIN.id, ADMIN.email]);
    await db.query(`INSERT INTO library_grants (library_id, folder_path, subject_type, subject_email, permission, granted_by, granted_by_email)
                    VALUES ($1, '', 'user', $2, 'write', $3, $4)`, [PROJECTS, MEMBER.email.toLowerCase(), OWNER.id, OWNER.email]);
    await doc('brief', 'Intake/brief.pdf', 10, OWNER, PROJECTS, 1);
    await doc('deep', 'Intake/2024/Q1/numbers.XLSX', 2000, MEMBER, PROJECTS, 2);
    await doc('keep', 'Empty folder/.keep', 0, OWNER, PROJECTS, 3);
    await doc('noext', 'Intake/README', 5, OWNER, PROJECTS, 4);
    await doc('dots', 'archive.tar.gz', 700, MEMBER, PROJECTS, 20);
    await doc('binned', 'Intake/old.pdf', 99, OWNER, PROJECTS, 5, { trashed: true });
    await doc('theirs', 'Private/notes.txt', 30, OTHER, OTHERS_OWN, 6);
    await doc('theirGuide', GUIDE, 3000, OTHER, OTHERS_OWN, 0);
    await doc('myGuide', GUIDE, 3000, ADMIN, ADMINS_OWN, 0);
    for (let i = 0; i < 5; i++) await doc(`bulk${i}`, `Bulk/file ${i}.pdf`, 100 + i, OWNER, PROJECTS, 7 + i);
    jwt = require('jsonwebtoken'); jwt.decode.mockReturnValue({ header: { kid: 'k' } });
    request = require('supertest');
    const express = require('express');
    app = express(); app.use(express.json());
    app.use('/api/files', require('../../routes/files'));
    app.use('/api/admin', require('../../routes/admin'));
  });
  afterAll(async () => { try { await reset(); } catch { /* best effort */ } try { await db.end(); } catch { /* closed */ } });

  const as = (a) => { jwt.verify.mockReturnValue({ sub: a.id, email: a.email.toLowerCase(), email_verified: true }); return (r) => r.set('Authorization', 'Bearer t'); };

  test.each([['the owner', OWNER], ['a Read-Write member', MEMBER], ['an admin', ADMIN], ['someone with only their own library', OTHER]])(
    'for %s, the summary says what the full list said', async (_n, who) => {
      const all = await as(who)(request(app).get('/api/files')).expect(200);
      const sum = await as(who)(request(app).get('/api/files/summary')).expect(200);
      expect(shape(sum.body)).toEqual(theOldWay(all.body, who));
    });

  test('folders are counted from every level, an empty folder (only its marker) not at all', async () => {
    const sum = await as(OWNER)(request(app).get('/api/files/summary')).expect(200);
    expect(sum.body.libraries.find(l => l.library_id === PROJECTS).folders).toBe(4);   // Intake, Intake/2024, Intake/2024/Q1, Bulk -- not Empty folder
  });

  test('an admin\'s recent files leave out other people\'s guide copies but keep their own', async () => {
    const sum = await as(ADMIN)(request(app).get('/api/files/summary')).expect(200);
    const recent = sum.body.recent.map(f => f.id);
    expect(recent).toContain(ids.myGuide);
    expect(recent).not.toContain(ids.theirGuide);
    expect(sum.body.recent.length).toBe(6);
  });

  test('favorites: only ones that exist, are live and can be read; nonsense ids are ignored', async () => {
    const fav = [ids.brief, ids.theirs, ids.binned, 'not-an-id', U(99)].join(',');
    const sum = await as(MEMBER)(request(app).get('/api/files/summary').query({ fav })).expect(200);
    expect(sum.body.favorites.map(f => f.id)).toEqual([ids.brief]);
  });

  test('admin files: newest first with totals, markers and the trash left out', async () => {
    const res = await as(ADMIN)(request(app).get('/api/admin/files').query({ limit: 3 })).expect(200);
    expect(res.body.total).toBe(12);
    expect(res.body.matched).toBe(12);
    expect(res.body.files).toHaveLength(3);
    const dates = res.body.files.map(f => new Date(f.created_at).getTime());
    expect([...dates].sort((a, b) => b - a)).toEqual(dates);
    const names = (await as(ADMIN)(request(app).get('/api/admin/files').query({ limit: 1000 })).expect(200)).body.files.map(f => f.name);
    expect(names).not.toContain('Empty folder/.keep');
    expect(names).not.toContain('Intake/old.pdf');
    expect(res.body.bytes).toBe(10 + 2000 + 5 + 700 + 30 + 3000 + 3000 + (100 + 101 + 102 + 103 + 104));
  });

  test('admin files: search by name or by who added it, with % and _ taken literally', async () => {
    const byName = await as(ADMIN)(request(app).get('/api/admin/files').query({ q: 'NUMBERS' })).expect(200);
    expect(byName.body.files.map(f => f.id)).toEqual([ids.deep]);
    const byPerson = await as(ADMIN)(request(app).get('/api/admin/files').query({ q: 'other@' })).expect(200);
    expect(byPerson.body.files.map(f => f.id).sort()).toEqual([ids.theirs, ids.theirGuide].sort());
    expect(byPerson.body.matched).toBe(2);
    const wild = await as(ADMIN)(request(app).get('/api/admin/files').query({ q: '%' })).expect(200);
    expect(wild.body.files).toHaveLength(0);
  });

  test('admin files is for admins only', async () => {
    await as(OWNER)(request(app).get('/api/admin/files')).expect(403);
  });
});

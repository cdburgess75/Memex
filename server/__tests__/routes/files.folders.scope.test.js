'use strict';
// Every folder operation matches documents by name prefix (`starts_with(d.name, $1 || '/')`),
// and a folder name is only unique within a library. Without a library predicate one
// rename or member-grant reaches across every library the caller can read.
//
// Unlike files.folders.test.js, this suite uses the REAL lib/documentAccess, because
// the risk being guarded is arithmetic: each query appends the library id after the
// five parameters userParams() supplies, at a hard-coded index. A mocked
// `condition: () => 'TRUE'` with `userParams: () => []` removes the placeholders and
// makes a wrong index invisible. The db mock below fails any query whose highest $N
// exceeds the parameters actually passed — which is exactly what Postgres would do.
const request = require('supertest');
const express = require('express');

const seen = [];

jest.mock('../../lib/db', () => ({
  query: jest.fn(async (sql, params = []) => {
    seen.push({ sql, params });
    const highest = Math.max(0, ...[...String(sql).matchAll(/\$(\d+)/g)].map(m => Number(m[1])));
    if (highest > params.length) {
      throw new Error(`bind mismatch: SQL references $${highest} but only ${params.length} parameters were passed`);
    }
    // Satisfy folderLibraryId()'s lookup; everything else can come back empty.
    return /SELECT DISTINCT d\.library_id/.test(sql) ? [{ library_id: 'lib-1' }] : [];
  }),
  queryOne: jest.fn().mockResolvedValue(null),
  withTransaction: jest.fn(),
}));
jest.mock('../../lib/auditLog', () => ({ append: jest.fn().mockResolvedValue({}) }));
jest.mock('../../lib/storage', () => ({
  upload: jest.fn().mockResolvedValue(undefined),
  download: jest.fn().mockResolvedValue(Buffer.from('x')),
  copy: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../lib/settings', () => ({ getOrEnv: jest.fn().mockResolvedValue(null) }));
jest.mock('../../lib/libraries', () => ({
  defaultLibraryId: jest.fn().mockResolvedValue('lib-1'),
  canAccessLibrary: jest.fn().mockResolvedValue(true),
}));
jest.mock('../../lib/notifications', () => ({ create: jest.fn().mockResolvedValue({}) }));
jest.mock('../../lib/emailEvents', () => ({ send: jest.fn().mockResolvedValue({}) }));

const mockUser = { id: '810da857-4296-473f-99e9-96f2a5ebd47e', email: 'user@test.com', role: 'contributor' };
jest.mock('../../middleware/auth', () => (req, _res, next) => { req.user = mockUser; next(); });

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/files', require('../../routes/files'));
  return app;
}

// Each folder route, and how to reach it.
const ROUTES = [
  ['rename', app => request(app).post('/api/files/folder/rename').send({ path: 'Clients/Acme', name: 'Acme2' })],
  ['delete', app => request(app).post('/api/files/folder/delete').send({ path: 'Clients/Acme' })],
  ['reparent', app => request(app).post('/api/files/folder/reparent').send({ path: 'Clients/Acme', target: 'Archive' })],
  ['move', app => request(app).post('/api/files/folder/move').send({ path: 'Clients/Acme', library_id: 'lib-2' })],
  ['zip', app => request(app).get('/api/files/folder/zip').query({ path: 'Clients/Acme' })],
  ['links', app => request(app).post('/api/files/folder/links').send({ path: 'Clients/Acme' })],
  ['members:list', app => request(app).get('/api/files/folder/members').query({ path: 'Clients/Acme' })],
  ['members:grant', app => request(app).post('/api/files/folder/members').send({ path: 'Clients/Acme', email: 'a@b.com', permission: 'read' })],
  ['members:revoke', app => request(app).delete('/api/files/folder/members').send({ path: 'Clients/Acme', email: 'a@b.com' })],
  ['copy', app => request(app).post('/api/files/folder/copy').send({ path: 'Clients/Acme', library_id: 'lib-2' })],
];

beforeEach(() => { seen.length = 0; });

describe('folder operations are scoped to one library', () => {
  test.each(ROUTES)('%s binds every placeholder it references', async (_name, call) => {
    await call(makeApp());
    // The mock throws on a bind mismatch; serverError would swallow it into a 500,
    // so assert on the captured queries rather than the status code.
    expect(seen.length).toBeGreaterThan(0);
    for (const { sql, params } of seen) {
      const highest = Math.max(0, ...[...String(sql).matchAll(/\$(\d+)/g)].map(m => Number(m[1])));
      expect(highest).toBeLessThanOrEqual(params.length);
    }
  });

  test.each(ROUTES)('%s constrains documents to a single library', async (_name, call) => {
    await call(makeApp());
    const prefixQueries = seen.filter(q => /starts_with\(d\.name, \$1 \|\| '\/'\)/.test(q.sql));
    expect(prefixQueries.length).toBeGreaterThan(0);
    for (const q of prefixQueries) {
      // folderLibraryId's own lookup is the one query that legitimately spans
      // libraries — it exists to discover which library the folder is in.
      if (/SELECT DISTINCT d\.library_id/.test(q.sql)) continue;
      const m = q.sql.match(/d\.library_id = \$(\d+)/);
      expect(m).not.toBeNull();
      expect(q.params[Number(m[1]) - 1]).toBe('lib-1');
    }
  });

  test('move refuses a destination library the caller cannot reach', async () => {
    const libraries = require('../../lib/libraries');
    libraries.canAccessLibrary.mockResolvedValueOnce(false);
    const res = await request(makeApp())
      .post('/api/files/folder/move')
      .send({ path: 'Clients/Acme', library_id: '00000000-0000-0000-0000-000000000000' });
    expect(res.status).toBe(403);
    // and nothing was rewritten
    expect(seen.some(q => /UPDATE documents d SET library_id/.test(q.sql))).toBe(false);
  });

  test('a folder present in two libraries is refused rather than silently spanning both', async () => {
    const db = require('../../lib/db');
    db.query.mockImplementationOnce(async () => [{ library_id: 'lib-1' }, { library_id: 'lib-2' }]);
    const res = await request(makeApp()).post('/api/files/folder/delete').send({ path: 'Clients/Acme' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/more than one library/i);
  });

  test('an explicit source library skips the lookup and is the one bound', async () => {
    const LIB9 = '99999999-9999-4999-8999-999999999999';
    await request(makeApp())
      .post('/api/files/folder/delete')
      .set('x-library-id', LIB9)
      .send({ path: 'Clients/Acme' });
    expect(seen.some(q => /SELECT DISTINCT d\.library_id/.test(q.sql))).toBe(false);
    const upd = seen.find(q => /UPDATE documents d SET deleted_at/.test(q.sql));
    const m = upd.sql.match(/d\.library_id = \$(\d+)/);
    expect(upd.params[Number(m[1]) - 1]).toBe(LIB9);
  });

  test('the source library can come in the body, as the app now sends it', async () => {
    const LIB9 = '99999999-9999-4999-8999-999999999999';
    await request(makeApp()).post('/api/files/folder/delete').send({ path: 'Clients/Acme', source_library_id: LIB9 });
    const upd = seen.find(q => /UPDATE documents d SET deleted_at/.test(q.sql));
    expect(upd.params[Number(upd.sql.match(/d\.library_id = \$(\d+)/)[1]) - 1]).toBe(LIB9);
  });

  test('a malformed source library id is a 400, never a database cast error', async () => {
    for (const bad of ['lib-9', '1 OR 1=1', "x'; DROP TABLE documents; --"]) {
      seen.length = 0;
      const res = await request(makeApp()).post('/api/files/folder/delete').set('x-library-id', bad).send({ path: 'Clients/Acme' });
      expect(res.status).toBe(400);
      expect(seen).toHaveLength(0);
    }
    const zip = await request(makeApp()).get('/api/files/folder/zip').query({ path: 'Clients/Acme', source_library_id: 'nope' });
    expect(zip.status).toBe(400);
  });
});

// A folder is found by its exact stored name. Unusual characters are NOT rewritten on
// the way in (that was safeDocName, which turned "Tax & Co" into "Tax _ Co" and so
// could never find it), and '_' / '%' are not wildcards.
describe('folders are matched exactly', () => {
  const E = String.fromCodePoint(0x1F4C1);  // a four-byte character, two UTF-16 units
  test.each([
    ['Tax & Co'],
    ['50%'],
    ['Q1_A'],
    ['Caf' + String.fromCharCode(0xE9)],
    ['Clients/' + E + ' Files'],
  ])('%s is bound exactly as given', async (path) => {
    await request(makeApp()).post('/api/files/folder/delete').send({ path });
    const upd = seen.find(q => /UPDATE documents d SET deleted_at/.test(q.sql));
    expect(upd).toBeDefined();
    expect(upd.params[0]).toBe(path);
    expect(upd.sql).toMatch(/starts_with\(d\.name, \$1 \|\| '\/'\)/);
    expect(upd.sql).not.toMatch(/d\.name LIKE \$1/);
  });

  test('separators are tidied but nothing else is', async () => {
    await request(makeApp()).post('/api/files/folder/delete').send({ path: '/Clients//Tax & Co/' });
    const upd = seen.find(q => /UPDATE documents d SET deleted_at/.test(q.sql));
    expect(upd.params[0]).toBe('Clients/Tax & Co');
  });

  test.each([['../etc'], ['a/./b'], ['a/ b'], [''], ['x'.repeat(401)]])('%s is refused before any query', async (path) => {
    const res = await request(makeApp()).post('/api/files/folder/delete').send({ path });
    expect(res.status).toBe(400);
    expect(seen).toHaveLength(0);
  });

  test('a rename counts the old path in characters, as Postgres substring() does', async () => {
    const oldPath = 'Clients/' + E + ' Files';
    await request(makeApp()).post('/api/files/folder/rename').send({ path: oldPath, name: 'Renamed' });
    const upd = seen.find(q => /UPDATE documents d SET name/.test(q.sql));
    expect(upd.params[2]).toBe(Array.from(oldPath).length + 1);
    expect(upd.params[2]).toBe(oldPath.length); // one less than the UTF-16 count would give
  });

  test('a reparent into an exactly-named folder binds that folder unchanged', async () => {
    await request(makeApp()).post('/api/files/folder/reparent').send({ path: 'Clients/Acme', target: 'Tax & Co' });
    const upd = seen.find(q => /UPDATE documents d SET name/.test(q.sql));
    expect(upd.params[1]).toBe('Tax & Co/Acme');
  });

  test('a reparent to the root still works, and a malformed target is refused', async () => {
    await request(makeApp()).post('/api/files/folder/reparent').send({ path: 'Clients/Acme', target: '' });
    expect(seen.find(q => /UPDATE documents d SET name/.test(q.sql)).params[1]).toBe('Acme');
    seen.length = 0;
    expect((await request(makeApp()).post('/api/files/folder/reparent').send({ path: 'Clients/Acme', target: '../x' })).status).toBe(400);
  });
});

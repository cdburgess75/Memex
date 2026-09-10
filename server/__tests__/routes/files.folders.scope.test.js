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
// The folders that exist in lib-1 (or LIB9, when a test names it explicitly) and the
// caller can see. Every folder above a stored name counts, as it does in Postgres.
const mockFolders = new Set();
function mockSeedFolders(...paths) {
  mockFolders.clear();
  for (const p of paths) {
    const segs = p.split('/');
    for (let n = 1; n <= segs.length; n++) mockFolders.add(segs.slice(0, n).join('/'));
  }
}
const LIB9 = '99999999-9999-4999-8999-999999999999';

jest.mock('../../lib/db', () => {
  const bindCheck = (sql, params) => {
    seen.push({ sql, params });
    const highest = Math.max(0, ...[...String(sql).matchAll(/\$(\d+)/g)].map(m => Number(m[1])));
    if (highest > params.length) {
      throw new Error(`bind mismatch: SQL references $${highest} but only ${params.length} parameters were passed`);
    }
  };
  return {
    query: jest.fn(async (sql, params = []) => {
      bindCheck(sql, params);
      // Satisfy folderLibraryId()'s lookup; everything else can come back empty.
      return /SELECT DISTINCT d\.library_id/.test(sql) ? [{ library_id: 'lib-1' }] : [];
    }),
    queryOne: jest.fn(async (sql, params = []) => {
      bindCheck(sql, params);
      // folderLibraryId() with an explicit library: does that library hold the folder?
      if (/SELECT 1 FROM documents d\s+WHERE d\.deleted_at IS NULL AND d\.library_id = \$1 AND starts_with\(d\.name, \$2/.test(sql)) {
        return ['lib-1', LIB9].includes(params[0]) && mockFolders.has(params[1]) ? { '?column?': 1 } : null;
      }
      // destinationFolder(): the longest of these prefixes that is a folder already.
      if (/SELECT p FROM unnest\(\$1::text\[\]\) AS p/.test(sql)) {
        const hit = params[0].filter(p => mockFolders.has(p)).sort((a, b) => b.length - a.length)[0];
        return hit ? { p: hit } : null;
      }
      // getAccessibleDocument() for the file rename below
      if (/FROM documents d\s+WHERE d\.id = \$1/.test(sql)) return { id: params[0], name: 'Inbox/report.pdf', library_id: 'lib-1' };
      if (/UPDATE documents SET name = \$2 WHERE id = \$1/.test(sql)) return { name: params[1] };
      return null;
    }),
    withTransaction: jest.fn(),
  };
});
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

beforeEach(() => { seen.length = 0; mockSeedFolders('Clients/Acme', 'Archive', 'Tax & Co', 'Smith & Co (2025)/Old', 'Inbox'); });

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
    await request(makeApp()).post('/api/files/folder/delete').send({ path: 'Clients/Acme', source_library_id: LIB9 });
    const upd = seen.find(q => /UPDATE documents d SET deleted_at/.test(q.sql));
    expect(upd.params[Number(upd.sql.match(/d\.library_id = \$(\d+)/)[1]) - 1]).toBe(LIB9);
  });

  // The app now always names the library. One that doesn't hold the folder used to
  // touch nothing and answer 200 {count: 0}, with a "renamed"/"trashed" audit line.
  test.each(ROUTES)(
    '%s: an explicit library that does not hold the folder is a 404 and touches nothing',
    async (_name, call) => {
      require('../../lib/auditLog').append.mockClear();
      mockSeedFolders('Somewhere/Else');
      const res = await call(makeApp()).set('x-library-id', LIB9);
      expect(res.status).toBe(404);
      expect(seen.some(q => /^\s*(UPDATE|INSERT|DELETE)/.test(q.sql) && /documents|document_acl/.test(q.sql))).toBe(false);
      const auditLog = require('../../lib/auditLog');
      expect(auditLog.append).not.toHaveBeenCalledWith(expect.objectContaining({ eventType: expect.stringMatching(/^folder_/) }));
    });

  test('copy maps a malformed or ambiguous source library to 400 / 409, not a 500', async () => {
    expect((await request(makeApp()).post('/api/files/folder/copy').send({ path: 'Clients/Acme', library_id: 'lib-2', source_library_id: 'nope' })).status).toBe(400);
    const db = require('../../lib/db');
    db.query.mockImplementationOnce(async () => [{ library_id: 'lib-1' }, { library_id: 'lib-2' }]);
    expect((await request(makeApp()).post('/api/files/folder/copy').send({ path: 'Clients/Acme', library_id: 'lib-2' })).status).toBe(409);
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
// the way in (that was safeDocName, which turned "Tax & Co" into "Tax _ Co", so an
// exact match could never find it), and '_' / '%' are not wildcards.
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

  // What no stored name can contain. (Odd-but-storable names -- a C1 control character
  // from a mis-decoded outside upload, a space at a segment's edge, a long CJK path --
  // stay reachable, so such a folder can at least be renamed.)
  test.each([['../etc'], ['a/./b'], [''], ['/'], ['x'.repeat(1001)], ['a' + String.fromCharCode(1) + 'b'], ['a\nb']])('%p is refused before any query', async (path) => {
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
    expect(seen.some(q => /UPDATE documents d SET name/.test(q.sql))).toBe(false);
  });

  test.each([
    ['Q1_A & 50%'],
    ['Caf' + String.fromCharCode(0xE9) + '/Old' + String.fromCharCode(0x92) + 's'], // C1 from a mis-decoded upload
    ['Clients/ Edge '],                                                             // pre-trim legacy name
    [String.fromCharCode(0x4E2D).repeat(360)],                                      // 1080 bytes of CJK
  ])('an odd but storable folder %p is still reachable (exactly)', async (path) => {
    const res = await request(makeApp()).post('/api/files/folder/delete').send({ path });
    expect(res.status).not.toBe(400);
    const upd = seen.find(q => /UPDATE documents d SET deleted_at/.test(q.sql));
    expect(upd.params[0]).toBe(path);
  });

  test('a reparent counts the old path in characters too', async () => {
    const oldPath = 'Clients/' + E + ' Files';
    await request(makeApp()).post('/api/files/folder/reparent').send({ path: oldPath, target: 'Archive' });
    const upd = seen.find(q => /UPDATE documents d SET name/.test(q.sql));
    expect(upd.params[1]).toBe('Archive/' + E + ' Files');
    expect(upd.params[2]).toBe(Array.from(oldPath).length + 1);
  });
});

// Every folder route finds its folder with starts_with / an exact key, never LIKE, and
// binds the path it was given unchanged. Checked per route with a path full of what
// LIKE and safeDocName would each get wrong.
describe('every folder route matches its folder exactly', () => {
  const ODD = 'Q1_A & 50%/Caf' + String.fromCharCode(0xE9);
  const CALLS = [
    ['rename', app => request(app).post('/api/files/folder/rename').send({ path: ODD, name: 'Renamed' })],
    ['delete', app => request(app).post('/api/files/folder/delete').send({ path: ODD })],
    ['reparent', app => request(app).post('/api/files/folder/reparent').send({ path: ODD, target: 'Archive' })],
    ['move', app => request(app).post('/api/files/folder/move').send({ path: ODD, library_id: 'lib-2' })],
    ['zip', app => request(app).get('/api/files/folder/zip').query({ path: ODD })],
    ['links:list', app => request(app).get('/api/files/folder/links').query({ path: ODD })],
    ['links:create', app => request(app).post('/api/files/folder/links').send({ path: ODD })],
    ['members:list', app => request(app).get('/api/files/folder/members').query({ path: ODD })],
    ['members:grant', app => request(app).post('/api/files/folder/members').send({ path: ODD, email: 'a@b.com', permission: 'read' })],
    ['members:revoke', app => request(app).delete('/api/files/folder/members').send({ path: ODD, email: 'a@b.com' })],
    ['copy', app => request(app).post('/api/files/folder/copy').send({ path: ODD, library_id: 'lib-2' })],
  ];
  test.each(CALLS)('%s', async (_name, call) => {
    await call(makeApp());
    expect(seen.length).toBeGreaterThan(0);
    for (const q of seen) expect(q.sql).not.toMatch(/\bLIKE\s+\$\d/);
    let located = 0;
    for (const q of seen) {
      const m = q.sql.match(/starts_with\(d\.name, \$(\d+) \|\| '\/'\)/);
      if (m) { expect(q.params[Number(m[1]) - 1]).toBe(ODD); located++; }
      if (/folder_path = ANY\(\$1::text\[\]\)/.test(q.sql)) { expect(q.params[0]).toContain(ODD); located++; }
    }
    expect(located).toBeGreaterThan(0);
  });
});

// Moving or renaming INTO a folder: an existing folder is kept exactly as stored, and
// only the part that doesn't exist yet is named the way a new folder is. Files (PUT
// /:id/rename) and folders (/folder/reparent) follow the same rule, so a mixed move
// lands in one place.
describe('destination folders', () => {
  const reparentTo = async (target) => {
    seen.length = 0;
    const res = await request(makeApp()).post('/api/files/folder/reparent').send({ path: 'Clients/Acme', target });
    const upd = seen.find(q => /UPDATE documents d SET name/.test(q.sql));
    return { res, path: upd ? upd.params[1] : null };
  };
  const renameFileTo = async (name) => {
    seen.length = 0;
    const res = await request(makeApp()).put('/api/files/11111111-1111-4111-8111-111111111111/rename').send({ name });
    return { res, name: res.body.name };
  };

  test.each([
    // [typed target, where the folder lands, where a file moved with it lands]
    ['R&D', 'R_D/Acme', 'R_D/report.pdf'],                                   // new: cleaned
    ['Tax & Co', 'Tax & Co/Acme', 'Tax & Co/report.pdf'],                   // existing: exact
    ['Smith & Co (2025)/Old', 'Smith & Co (2025)/Old/Acme', 'Smith & Co (2025)/Old/report.pdf'],
    ['Smith & Co (2025)/New & Sub', 'Smith & Co (2025)/New _ Sub/Acme', 'Smith & Co (2025)/New _ Sub/report.pdf'], // existing + new
    ['Clients / Acme2', 'Clients/Acme2/Acme', 'Clients/Acme2/report.pdf'],   // stray spaces trimmed
    ['Caf' + String.fromCharCode(0xE9), 'Caf_/Acme', 'Caf_/report.pdf'],
  ])('a move to %p puts the folder and a file in the same place', async (target, folderLands, fileLands) => {
    expect((await reparentTo(target)).path).toBe(folderLands);
    expect((await renameFileTo(`${target}/report.pdf`)).name).toBe(fileLands);
  });

  test('a new folder name can never store markup', async () => {
    const { path } = await reparentTo('<img src=x onerror=alert(1)>');
    expect(path).toBe('_img src_x onerror_alert_1__/Acme');
    const { name } = await renameFileTo('<b>x</b>/a"<i>.pdf');
    expect(name).not.toMatch(/[<>"]/);
  });

  test('a folder the caller cannot see is not a destination: the name is cleaned as new', async () => {
    mockSeedFolders('Clients/Acme'); // "Tax & Co" exists for someone else, not for this caller
    expect((await reparentTo('Tax & Co')).path).toBe('Tax _ Co/Acme');
  });

  test('renaming a file inside a folder with an unusual name keeps it in that folder', async () => {
    expect((await renameFileTo('Smith & Co (2025)/Old/renamed.pdf')).name).toBe('Smith & Co (2025)/Old/renamed.pdf');
  });

  test.each([['../etc'], ['a/../b']])('a traversal target %p is refused', async (target) => {
    expect((await reparentTo(target)).res.status).toBe(400);
    expect((await renameFileTo(`${target}/f.pdf`)).res.status).toBe(400);
  });

  test('moving a folder into itself, even by a new name under it, is refused', async () => {
    expect((await reparentTo('Clients/Acme/Sub')).res.status).toBe(400);
  });

  test('the destination lookup is scoped to the source library and the caller', async () => {
    await reparentTo('Tax & Co');
    const q = seen.find(x => /SELECT p FROM unnest/.test(x.sql));
    expect(q.params[1]).toBe('lib-1');
    const documentAccess = require('../../lib/documentAccess');
    expect(q.sql).toContain(documentAccess.condition('d', 3));
    expect(q.params.slice(2)).toEqual(documentAccess.userParams(mockUser, 'read'));
  });
});

// Links minted before folders were matched exactly were stored under safeDocName's
// rewritten key; the dialog must still list them, or a live link can't be revoked.
describe('folder links made before exact matching', () => {
  test('are listed under the folder they were made for', async () => {
    const db = require('../../lib/db');
    db.query.mockImplementationOnce(async (sql, params) => {
      seen.push({ sql, params });
      return params[0].includes('Tax _ Co') ? [{ id: 'l1', folder_path: 'Tax _ Co', document_ids: [], created_at: new Date().toISOString() }] : [];
    });
    const res = await request(makeApp()).get('/api/files/folder/links').query({ path: 'Tax & Co' });
    expect(res.status).toBe(200);
    expect(res.body.shares.map(x => x.id)).toEqual(['l1']);
    const q = seen.find(x => /FROM folder_share_links/.test(x.sql));
    expect(q.params[0]).toEqual(['Tax & Co', 'Tax _ Co']);
    expect(q.params[1]).toBe(mockUser.id); // still only the caller's own links
  });

  test('a plain folder name is looked up once', async () => {
    await request(makeApp()).get('/api/files/folder/links').query({ path: 'Reports/2025' });
    expect(seen.find(x => /FROM folder_share_links/.test(x.sql)).params[0]).toEqual(['Reports/2025']);
  });
});

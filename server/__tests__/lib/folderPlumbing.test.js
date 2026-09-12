'use strict';
// The parts every folder operation will be built from (piece 4): the path rules, the
// per-library lock, the "keep an emptied shared folder alive" marker, and the indexed
// prefix lookup. Nothing here is wired into a route yet.
const folderPaths = require('../../lib/folderPaths');
const folderLocks = require('../../lib/folderLocks');
const documents = require('../../lib/documents');
const db = require('../../lib/db');

describe('the path rules', () => {
  const { rekey, cutFor, parentOf, baseOf, isUnder, isAtOrUnder, movesIntoItself, codePoints } = folderPaths;
  test('a folder and everything under it move; nothing else does', () => {
    expect(rekey('Clients/Mender', 'Clients/Mender', 'Clients/Mender LLC')).toBe('Clients/Mender LLC');
    expect(rekey('Clients/Mender/Q1.pdf', 'Clients/Mender', 'Clients/Mender LLC')).toBe('Clients/Mender LLC/Q1.pdf');
    expect(rekey('Clients/Mender/Deep/a.pdf', 'Clients/Mender', 'Archive/2025/Mender')).toBe('Archive/2025/Mender/Deep/a.pdf');
  });
  test('a folder whose name merely starts the same is left alone', () => {
    for (const p of ['Clients/Mender Extra/b.pdf', 'Clients/MenderX', 'Clients/Men', 'Clientsy/Mender/c.pdf']) {
      expect([p, rekey(p, 'Clients/Mender', 'Z')]).toEqual([p, p]);
    }
  });
  test('the cut counts code points, as Postgres substring() does', () => {
    expect(cutFor('Clients')).toBe(8);
    // an emoji is one code point but two UTF-16 units, so JavaScript's .length would cut
    // one character short of where Postgres substring(from n) does
    expect(codePoints('📁 Emoji')).toBe(7);
    expect('📁 Emoji'.length).toBe(8);
    expect(cutFor('📁 Emoji')).toBe(8);
  });
  test('parents, bases, and being inside', () => {
    expect(parentOf('A/B/C')).toBe('A/B');
    expect(parentOf('A')).toBe('');
    expect(baseOf('A/B/C')).toBe('C');
    expect(isUnder('A/B', 'A')).toBe(true);
    expect(isUnder('A', 'A')).toBe(false);
    expect(isAtOrUnder('A', 'A')).toBe(true);
    expect(isAtOrUnder('AB', 'A')).toBe(false);
  });
  test('a folder cannot be moved into itself or into its own child', () => {
    expect(movesIntoItself('A/B', 'A/B')).toBe(true);
    expect(movesIntoItself('A/B', 'A/B/C')).toBe(true);
    expect(movesIntoItself('A/B', 'A')).toBe(false);
    expect(movesIntoItself('A/B', 'A/BC')).toBe(false);
  });
});

describe('the per-library lock', () => {
  const client = () => { const calls = []; return { calls, query: async (sql, params) => { calls.push({ sql, params }); return { rows: [{ k: 11 }, { k: 22 }] }; } }; };
  test('one lock per library, taken in key order, so two operations cannot deadlock', async () => {
    const c = client();
    await folderLocks.tree(c, ['lib-b', 'lib-a', 'lib-b', null]);
    expect(c.calls[0].sql).toMatch(/hashtext\(id\).*ORDER BY 1/s);
    expect(c.calls[0].params[0]).toEqual(['lib-b', 'lib-a']);
    expect(c.calls.slice(1).map(x => x.sql)).toEqual([
      'SELECT pg_advisory_xact_lock($1::int, $2::int)',
      'SELECT pg_advisory_xact_lock($1::int, $2::int)',
    ]);
    expect(c.calls.slice(1).map(x => x.params)).toEqual([[folderLocks.TREE_NS, 11], [folderLocks.TREE_NS, 22]]);
  });
  test('a placement waits on the same lock, but shares it with other placements', async () => {
    const c = client();
    await folderLocks.tree(c, ['lib-a'], 'shared');
    expect(c.calls[1].sql).toContain('pg_advisory_xact_lock_shared');
  });
  test('nothing to lock, nothing sent', async () => {
    const c = client();
    await folderLocks.tree(c, []);
    await folderLocks.tree(c, null);
    expect(c.calls).toEqual([]);
  });
  test('a folder operation gives up waiting sooner than an upload does', async () => {
    const f = client(); await folderLocks.session(f, 'folder');
    const p = client(); await folderLocks.session(p, 'placement');
    expect(f.calls.map(x => x.sql)).toEqual(["SET LOCAL lock_timeout = '3000ms'", "SET LOCAL statement_timeout = '120000ms'", 'SET LOCAL jit = off']);
    expect(p.calls[0].sql).toBe("SET LOCAL lock_timeout = '10000ms'");
  });
  test('what to answer when Postgres will not wait any longer', () => {
    expect(folderLocks.busyError({ code: '55P03' }).body.code).toBe('LIBRARY_BUSY');
    expect(folderLocks.busyError({ code: '40P01' }).body.code).toBe('LIBRARY_BUSY');
    expect(folderLocks.busyError({ code: '57014' }).body.code).toBe('FOLDER_TOO_LARGE');
    expect(folderLocks.busyError({ code: '23505' })).toBeNull();
    expect(folderLocks.busyError(new Error('x'))).toBeNull();
  });
});

describe('keeping an emptied shared folder alive', () => {
  const { keepSharedFoldersAlive } = require('../../lib/keepMarker');
  function fake({ covering = [], planted = true } = {}) {
    const calls = [];
    return {
      calls,
      query: async (sql, params) => {
        calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
        if (/FROM library_grants g/.test(sql)) return covering;
        if (/INSERT INTO documents/.test(sql)) return planted ? [{ id: 'new-doc' }] : [];
        return [];
      },
    };
  }
  test('a folder with a share over it is kept, once per path, with its own storage object', async () => {
    const q = fake({ covering: [{ id: 'g1', folder_path: 'Clients/Mender' }, { id: 'g2', folder_path: 'Clients/Mender' }] });
    const planted = await keepSharedFoldersAlive(q, 'lib', ['Clients/Mender/a.pdf', 'Clients/Mender/b.pdf']);
    expect(planted).toEqual([{ path: 'Clients/Mender', id: 'new-doc', storagePath: expect.stringMatching(/^documents\/[0-9a-f-]{36}-keep$/) }]);
    const inserts = q.calls.filter(c => c.sql.includes('INSERT INTO documents'));
    expect(inserts).toHaveLength(1);
    expect(inserts[0].sql).toContain("$2 || '/.keep'");
    expect(inserts[0].sql).toContain('NULL, NULL'); // no uploader: it belongs to the library
    expect(inserts[0].sql).toMatch(/WHERE NOT EXISTS .* d\.deleted_at IS NULL/);
  });
  test('the covering shares are locked first, so two last-file removals cannot both skip', async () => {
    const q = fake({ covering: [{ id: 'g1', folder_path: 'A' }] });
    await keepSharedFoldersAlive(q, 'lib', ['A/x']);
    expect(q.calls[0].sql).toContain('FOR UPDATE');
    expect(q.calls[0].sql).toContain("starts_with(n, g2.folder_path || '/')"); // shares AT or ABOVE the name
  });
  test('nothing to do: no names, no library, or no share over them', async () => {
    expect(await keepSharedFoldersAlive(fake(), 'lib', [])).toEqual([]);
    expect(await keepSharedFoldersAlive(fake(), null, ['A/x'])).toEqual([]);
    const q = fake({ covering: [] });
    expect(await keepSharedFoldersAlive(q, 'lib', ['A/x'])).toEqual([]);
    expect(q.calls.filter(c => c.sql.includes('INSERT'))).toEqual([]);
  });
  test('a folder that still holds something keeps nothing new', async () => {
    const q = fake({ covering: [{ id: 'g1', folder_path: 'A' }], planted: false });
    expect(await keepSharedFoldersAlive(q, 'lib', ['A/x'])).toEqual([]);
  });
});

describe('the indexed prefix lookup, and numbered parameters', () => {
  test('prefixRange asks a range the text_pattern_ops index can answer', () => {
    expect(documents.prefixRange('d', '$2')).toBe("d.name ~>=~ ($2 || '/') AND d.name ~<~ ($2 || '0')");
  });
  test('paramList numbers as it goes', () => {
    const p = db.paramList();
    expect([p('a'), p(2), p(null)]).toEqual(['$1', '$2', '$3']);
    expect(p.vals).toEqual(['a', 2, null]);
  });
});

describe('the helpers can read inside a caller transaction', () => {
  const q = () => { const calls = []; return { calls, query: async (sql, params) => { calls.push({ sql, params }); return []; }, queryOne: async (sql, params) => { calls.push({ sql, params }); return { id: 'row-id', p: 'A', owner_id: 'someone' }; } }; };
  test.each([
    ['libraries.writeRight', (c) => require('../../lib/libraries').writeRight({ id: 'u', role: 'contributor' }, '00000000-0000-4000-8000-000000000001', '', c)],
    ['libraries.managesLibrary', (c) => require('../../lib/libraries').managesLibrary({ id: 'u', role: 'contributor' }, '00000000-0000-4000-8000-000000000001', c)],
    ['libraries.sharedFolderAt', (c) => require('../../lib/libraries').sharedFolderAt('00000000-0000-4000-8000-000000000001', 'A', c)],
    ['libraryShares.folderVisibleTo', (c) => require('../../lib/libraryShares').folderVisibleTo('lib', 'A', { id: 'u' }, c)],
    ['libraryShares.findShare', (c) => require('../../lib/libraryShares').findShare('lib', 'A', { email: 'x@y.z' }, c)],
    ['libraryShares.createShare', (c) => require('../../lib/libraryShares').createShare({ libraryId: 'lib', folderPath: 'A', email: 'x@y.z', permission: 'read', user: { id: 'u' } }, c)],
    ['libraryShares.getShare', (c) => require('../../lib/libraryShares').getShare('lib', 'share', c)],
    ['documents.destinationFolder', (c) => require('../../lib/documents').destinationFolder('A/B', 'lib', { id: 'u' }, c)],
    ['documentAccess.grantOwnerAdmin', (c) => require('../../lib/documentAccess').grantOwnerAdmin('doc', { id: 'u', email: 'x@y.z' }, c)],
    ['folderNotifyPrefs.setPref', (c) => require('../../lib/folderNotifyPrefs').setPref('lib', 'A', 'x@y.z', true, c)],
  ])('%s', async (_name, run) => {
    const c = q();
    await run(c);
    expect(c.calls.length).toBeGreaterThan(0);
  });
  test('and still work on the pool when no client is passed', async () => {
    const real = require('../../lib/db');
    const spy = jest.spyOn(real, 'queryOne').mockResolvedValue(null);
    await require('../../lib/libraries').managesLibrary({ id: 'u', role: 'contributor' }, '00000000-0000-4000-8000-000000000001');
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('the folder preview, in the small', () => {
  const preview = require('../../lib/folderPreview');
  const map = (o) => new Map(Object.entries(o));
  const people = new Map([
    ['a', { user_id: 'a', email: 'ana@x.test', name: 'Ana', is_admin: false }],
    ['b', { user_id: 'b', email: 'bo@x.test', name: 'Bo', is_admin: false }],
    ['c', { user_id: 'c', email: 'cy@x.test', name: 'Cy', is_admin: false }],
    ['adm', { user_id: 'adm', email: 'admin@x.test', name: 'Admin', is_admin: true }],
  ]);
  test('who loses, who gains, who changes level -- admins counted, never named', () => {
    const d = preview.diff(map({ a: 'write', b: 'read', adm: 'admin' }), map({ b: 'write', c: 'read', adm: 'admin' }), people);
    expect(d.lose.map(x => x.email)).toEqual(['ana@x.test']);
    expect(d.gain.map(x => x.email)).toEqual(['cy@x.test']);
    expect(d.changed).toEqual([{ email: 'bo@x.test', name: 'Bo', before: 'read', after: 'write' }]);
    expect(d.admins_unaffected).toBe(1);
    expect(JSON.stringify(d)).not.toContain('admin@x.test');
  });
  test('the best of several ways in wins when maps are merged', () => {
    expect(Object.fromEntries(preview.mergeLevels(map({ a: 'read' }), map({ a: 'write', b: 'read' })))).toEqual({ a: 'write', b: 'read' });
  });
  test('the fingerprint covers the answer, not just the paths', () => {
    const op = { op: 'reparent', libraryId: 'L', path: 'A', newPath: 'B/A', targetLibraryId: 'L' };
    const base = { before: map({ a: 'read' }), after: map({ a: 'read' }), carried: [{ id: 'g1', permission: 'read', folder_path: 'A' }], op };
    const same = preview.fingerprint(base);
    expect(preview.fingerprint(base)).toBe(same);
    expect(preview.fingerprint({ ...base, after: map({ a: 'read', z: 'read' }) })).not.toBe(same); // somebody new at the destination
    expect(preview.fingerprint({ ...base, carried: [{ id: 'g1', permission: 'write', folder_path: 'A' }] })).not.toBe(same);
    expect(preview.fingerprint({ ...base, op: { ...op, newPath: 'C/A' } })).not.toBe(same);
  });
});

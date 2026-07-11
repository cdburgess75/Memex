'use strict';
// Covers the Seafile client (auth, recursive walk, download) and the migration
// job (ingest via injected deps, folder-tree preservation, dedupe skip, counts).
const seafile = require('../../lib/seafileMigration');

const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; seafile._reset(); });

function json(obj) { return { ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) }; }
function bytes(buf) { return { ok: true, status: 200, arrayBuffer: async () => buf }; }

// A fake Seafile: root has folder "Sub" + file "a.txt"; Sub has "b.pdf".
function mockSeafile() {
  global.fetch = jest.fn(async (url) => {
    const u = String(url);
    if (u.includes('/auth-token/')) return json({ token: 'tok-1' });
    if (u.endsWith('/repos/REPO/')) return json({ name: 'Clients' });
    if (u.includes('/dir/?p=')) {
      const p = decodeURIComponent(u.split('p=')[1].split('&')[0]);
      if (p === '/') return json([{ type: 'dir', name: 'Sub' }, { type: 'file', name: 'a.txt', size: 3 }]);
      if (p === '/Sub') return json([{ type: 'file', name: 'b.pdf', size: 5 }]);
      return json([]);
    }
    if (u.includes('/file/?p=')) return { ok: true, status: 200, text: async () => JSON.stringify('https://dl.example/x') };
    if (u.startsWith('https://dl.example')) return bytes(Buffer.from('data'));
    throw new Error('unexpected url ' + u);
  });
}

const CONN = { url: 'https://depot.example.com', username: 'api@x.com', password: 'pw', repoId: 'REPO' };

async function waitDone() {
  for (let i = 0; i < 100; i++) { if (seafile.status().status !== 'running') return; await new Promise(r => setTimeout(r, 5)); }
}

describe('client', () => {
  test('authToken posts to /api2/auth-token/ and returns the token', async () => {
    mockSeafile();
    expect(await seafile.authToken(CONN.url, CONN.username, CONN.password)).toBe('tok-1');
    expect(global.fetch.mock.calls[0][0]).toBe('https://depot.example.com/api2/auth-token/');
  });
  test('walk recurses directories and returns files with full paths', async () => {
    mockSeafile();
    const files = await seafile.walk(CONN.url, 'tok-1', 'REPO', '/');
    expect(files.map(f => f.path).sort()).toEqual(['/Sub/b.pdf', '/a.txt']);
  });
  test('testConnection returns repo name + root entry count', async () => {
    mockSeafile();
    const r = await seafile.testConnection(CONN);
    expect(r).toEqual({ ok: true, repoName: 'Clients', topLevelEntries: 2 });
  });
  test('bad credentials throw', async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 400, json: async () => ({}) }));
    await expect(seafile.authToken(CONN.url, 'x', 'y')).rejects.toThrow(/auth failed/);
  });
});

describe('migration job', () => {
  function deps(existing = []) {
    return {
      storage: { upload: jest.fn().mockResolvedValue({}) },
      createDocumentRecord: jest.fn().mockResolvedValue({ doc: { id: 'd' } }),
      existingNames: jest.fn().mockResolvedValue(new Set(existing)),
    };
  }

  test('imports every file, preserving the tree, and reports done', async () => {
    mockSeafile();
    const d = deps();
    seafile.start({ ...CONN, targetLibraryId: 'lib-1', destFolder: '', user: { id: 'u', email: 'u@x.com' } }, d);
    await waitDone();
    const st = seafile.status();
    expect(st.status).toBe('done');
    expect(st.done).toBe(2); expect(st.failed).toBe(0); expect(st.skipped).toBe(0);
    const names = d.createDocumentRecord.mock.calls.map(c => c[0].displayName).sort();
    expect(names).toEqual(['Sub/b.pdf', 'a.txt']);
    expect(d.createDocumentRecord).toHaveBeenCalledWith(expect.objectContaining({ libraryId: 'lib-1', sourceDetail: 'migrated from Seafile' }));
    expect(d.storage.upload).toHaveBeenCalledTimes(2);
  });

  test('destFolder nests the whole tree under a prefix', async () => {
    mockSeafile();
    const d = deps();
    seafile.start({ ...CONN, targetLibraryId: 'lib-1', destFolder: 'Imports/Seafile', user: { id: 'u', email: 'u@x.com' } }, d);
    await waitDone();
    const names = d.createDocumentRecord.mock.calls.map(c => c[0].displayName).sort();
    expect(names).toEqual(['Imports/Seafile/Sub/b.pdf', 'Imports/Seafile/a.txt']);
  });

  test('skips files already present in the target library (idempotent re-run)', async () => {
    mockSeafile();
    const d = deps(['a.txt']); // already imported
    seafile.start({ ...CONN, targetLibraryId: 'lib-1', destFolder: '', user: { id: 'u', email: 'u@x.com' } }, d);
    await waitDone();
    const st = seafile.status();
    expect(st.done).toBe(1); expect(st.skipped).toBe(1);
    expect(d.createDocumentRecord).toHaveBeenCalledTimes(1);
  });

  test('a second start while running is rejected', async () => {
    mockSeafile();
    seafile.start({ ...CONN, targetLibraryId: 'lib-1', user: { id: 'u', email: 'u@x.com' } }, deps());
    expect(() => seafile.start({ ...CONN, targetLibraryId: 'lib-1', user: { id: 'u', email: 'u@x.com' } }, deps())).toThrow(/already running/);
    await waitDone();
  });

  test('status never leaks credentials', async () => {
    mockSeafile();
    seafile.start({ ...CONN, targetLibraryId: 'lib-1', user: { id: 'u', email: 'u@x.com' } }, deps());
    const st = seafile.status();
    expect(JSON.stringify(st)).not.toContain('pw');
    await waitDone();
  });
});

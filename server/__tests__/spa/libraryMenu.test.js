'use strict';
// The library menu (index.html): a plain list while it is short; past a handful of
// libraries, a search box, a Recent group, and folded groups for other people's own
// libraries and libraries that were put away. Each library is listed once.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '../../../index.html'), 'utf8');
const fnText = (name) => {
  const start = html.search(new RegExp(`^function ${name}\\(`, 'm'));
  if (start < 0) throw new Error(`${name} not found in index.html`);
  const end = html.indexOf('\n}\n', start);
  return html.slice(start, end + 3);
};
const section = (() => {
  const start = html.indexOf('// ---- Library menu ----');
  const end = html.indexOf('function libraryMenuSearch(');
  if (start < 0 || end < start) throw new Error('library menu section not found');
  return html.slice(start, end);
})();

function menu({ libraries, current = null, pinned = [], recent = [], role = 'admin' }) {
  const store = new Map([['memex_recent_libraries', JSON.stringify(recent)]]);
  const ctx = {
    librariesList: libraries, currentLibraryId: current, pinnedLibraryIds: new Set(pinned.map(String)),
    currentUser: { id: 'me', role },
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
    canShareLibrary: () => false, currentLibrary: () => libraries.find(l => String(l.id) === String(current)) || null,
    LIBRARY_PILL: { rw: 'Read-Write', r: 'Read-only', folders: 'Folders' },
    libraryMenuRow: (l) => `<button class="library-menu-item" data-row="${l.id}">${l.name}</button>`,
    store,
  };
  vm.runInNewContext(`${fnText('esc')}\n${fnText('escAttr')}\n${section}\n${fnText('libraryMenuInnerHtml')}
    this.inner = libraryMenuInnerHtml; this.list = libraryMenuListHtml; this.groups = libraryMenuGroups;
    this.note = noteRecentLibrary; this.setQuery = (q) => { libraryMenuQuery = q; }; this.open = (k) => libraryMenuOpenGroups.add(k);`, ctx);
  return ctx;
}
const rows = (out) => [...out.matchAll(/data-row="([^"]+)"/g)].map(m => m[1]);
const lib = (id, over = {}) => ({ id, name: `Library ${id}`, my_access: 'admin', personal: false, archived_at: null, ...over });

describe('a short list stays plain', () => {
  const libraries = [lib('a', { my_access: 'owner', personal: true, name: 'Mine' }), lib('b', { my_access: 'rw' }), lib('c')];
  test('no search box, no Recent, every library shown', () => {
    const m = menu({ libraries, recent: ['c'] });
    const out = m.inner();
    expect(out).not.toContain('library-menu-search');
    expect(out).not.toContain('>Recent<');
    expect(rows(out).sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('a long list', () => {
  const people = Array.from({ length: 12 }, (_, i) => lib(`p${i}`, { personal: true, name: `Person ${i}` }));
  const team = Array.from({ length: 6 }, (_, i) => lib(`t${i}`, { name: `Team ${i}` }));
  const libraries = [lib('mine', { my_access: 'owner', personal: true, name: 'My own' }), lib('sh', { my_access: 'r', name: 'Shared to me' }),
    ...team, ...people, lib('old', { archived_at: '2026-01-01', name: 'Old projects' })];

  test('gets a search box, and folds people\'s own libraries and put-away ones', () => {
    const m = menu({ libraries });
    const out = m.inner();
    expect(out).toContain('library-menu-search');
    expect(out).toContain('People’s own libraries');
    expect(out).toContain('>12<');
    expect(out).toContain('Put away');
    const shown = rows(out);
    expect(shown).toEqual(expect.arrayContaining(['mine', 'sh', 't0', 't5']));
    expect(shown.some(id => id.startsWith('p'))).toBe(false);
    expect(shown).not.toContain('old');
  });

  test('a folded group opens', () => {
    const m = menu({ libraries });
    m.open('people');
    expect(rows(m.list()).filter(id => id.startsWith('p'))).toHaveLength(12);
  });

  test('pinned first, then up to five recent, and nothing twice', () => {
    const m = menu({ libraries, pinned: ['t3'], recent: ['t3', 'p4', 't1', 'old', 'p0', 'p1', 'p2', 'p3'] });
    const g = m.groups();
    expect(g.pinned.map(l => l.id)).toEqual(['t3']);
    expect(g.recent.map(l => l.id)).toEqual(['p4', 't1', 'p0', 'p1', 'p2']);   // pinned and put-away ones skipped
    const all = rows(m.list());
    expect(new Set(all).size).toBe(all.length);
  });

  test('the library you are in stays listed even if it was put away', () => {
    const m = menu({ libraries, current: 'old' });
    expect(rows(m.list())).toContain('old');
  });

  test('search looks through everything, put-away and folded included, by name or owner', () => {
    const m = menu({ libraries: [...libraries, lib('x', { name: 'Accounts', owner_email: 'pat@acme.test', personal: true })] });
    m.setQuery('old');
    expect(rows(m.list())).toEqual(['old']);
    m.setQuery('PAT@');
    expect(rows(m.list())).toEqual(['x']);
    m.setQuery('zzz');
    expect(m.list()).toContain('No library matches');
  });

  test('a match name is escaped in the no-match line', () => {
    const m = menu({ libraries });
    m.setQuery('<b>');
    expect(m.list()).toContain('&lt;b&gt;');
  });

  test('recents are remembered newest first, without repeats', () => {
    const m = menu({ libraries, recent: ['t1', 't2'] });
    m.note('t2'); m.note('t5'); m.note('null');
    expect(JSON.parse(m.store.get('memex_recent_libraries'))).toEqual(['t5', 't2', 't1']);
  });
});

test('opening a library from anywhere records it as recent', () => {
  expect(fnText('switchLibrary')).toContain('noteRecentLibrary(');
  expect(html).toMatch(/async function openLibraryAt[\s\S]{0,200}noteRecentLibrary\(/);
});

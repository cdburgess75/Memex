'use strict';
// Folders in the type menu and in search results, sortable search results, and the Modified
// column reading a real modified time (index.html).
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const html = fs.readFileSync(path.join(__dirname, '../../../index.html'), 'utf8');
const fnText = (name) => {
  const start = html.search(new RegExp(`^(async )?function ${name}\\(`, 'm'));
  if (start < 0) throw new Error(`${name} not found in index.html`);
  return html.slice(start, html.indexOf('\n}\n', start) + 3);
};
const COLS = [
  { id: 'name', label: 'Name', always: true, sort: (a, b) => a.name.localeCompare(b.name) },
  { id: 'size', label: 'Size', align: 'right', sort: (a, b) => (a.size || 0) - (b.size || 0) },
  { id: 'modified', label: 'Modified', sort: (a, b) => new Date(a.modified_at || a.created_at || 0) - new Date(b.modified_at || b.created_at || 0) },
];
const load = (names, over = {}) => {
  const store = {};
  const ctx = { localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } }, store,
    FILE_COLUMN_DEFS: COLS, visibleFileColumns: () => COLS, JSON, console, Object, Array, Date, String, ...over };
  vm.runInNewContext(['esc', 'escAttr', ...names].map(fnText).join('\n') + "\nvar searchSort = null; var _contentSearch = null;", ctx); // var: visible on the context, where the assertions read it
  return ctx;
};

describe('the type menu', () => {
  test('has Folders right after All, and no file ever matches it', () => {
    const tabs = html.slice(html.indexOf('const FILE_TYPE_TABS = ['), html.indexOf('];', html.indexOf('const FILE_TYPE_TABS = [')));
    expect(tabs.indexOf("id: 'all'")).toBeLessThan(tabs.indexOf("id: 'folders', label: 'Folders'"));
    expect(tabs.indexOf("id: 'folders'")).toBeLessThan(tabs.indexOf("id: 'docs'"));
    const c = load(['fileMatchesType'], { FILE_TYPE_TABS: [{ id: 'all', exts: null }, { id: 'folders', exts: [] }, { id: 'docs', exts: ['docx'] }], fileExt: (n) => n.split('.').pop() });
    expect(c.fileMatchesType({ name: 'plan.docx' }, 'folders')).toBe(false);
    expect(c.fileMatchesType({ name: 'plan.docx' }, 'docs')).toBe(true);
    expect(c.fileMatchesType({ name: 'plan.docx' }, 'all')).toBe(true);
  });
  test('while browsing, a name search lists matching folders first and says where they live; Folders alone shows only folders', () => {
    const list = fnText('renderDocumentLibraryList');
    expect(list).toContain("const folders = flatView ? [] : q ? folderIndex.filter(f => f.name.toLowerCase().includes(q)).map(f => ({ ...f, where:");
    expect(list).toContain("emptyState('No folders here', 'Clear the type filter to see the files in this folder.')");
    expect(list).toContain("fileFilter === 'folders' ? 'No matching folders' : 'No matching files'");
    expect(fnText('folderLibraryRow')).toContain("${folder.where ? esc(folder.where) + ' · ' : ''}${folder.count} item");
    expect(fnText('setFileFilter')).toContain('if (_contentSearch && document.getElementById(\'file-library-view\')');
  });
});

describe('search results', () => {
  const rows = [
    { id: '1', name: 'Zeta/plan.docx', size: 30, created_at: '2026-01-03T00:00:00Z' },
    { id: '2', name: 'Alpha/notes.txt', size: 10, created_at: '2026-01-01T00:00:00Z', modified_at: '2026-02-01T00:00:00Z' },
    { id: '3', name: 'Mid/sheet.xlsx', size: 20, created_at: '2026-01-02T00:00:00Z' },
  ];
  const folders = [{ library_id: 'L1', library_name: 'Projects', path: 'Clients/Empire Roofing', name: 'Empire Roofing', folder: 'Clients', count: 12 }];
  const ctxFor = (filter = 'all') => {
    const el = { innerHTML: '' };
    const c = load(['setSearchSort', 'searchSortedRows', 'searchTableHeadHtml', 'searchFolderRow', 'renderContentSearchResults', 'fileMatchesType'], {
      document: { getElementById: (id) => (id === 'file-list' ? el : null) }, fileFilter: filter,
      FILE_TYPE_TABS: [{ id: 'all', exts: null }, { id: 'folders', exts: [] }, { id: 'docs', exts: ['docx'] }], fileExt: (n) => n.split('.').pop(),
      fileLibraryRow: (f) => `<tr data-file="${f.id}"></tr>`, rememberFiles: (x) => x, updateFileLibraryChrome: () => {}, emptyState: (t, d) => `<empty>${t}: ${d}</empty>`,
    });
    return { c, el };
  };
  test('best match first until a header is clicked; the click goes up, then down, then back; the choice is remembered', () => {
    const { c } = ctxFor();
    expect(c.searchSortedRows(rows).map(r => r.id)).toEqual(['1', '2', '3']);
    c.setSearchSort('name');
    expect(c.searchSort).toEqual({ col: 'name', dir: 1 }); expect(JSON.parse(c.store.memex_search_sort)).toEqual({ col: 'name', dir: 1 });
    expect(c.searchSortedRows(rows).map(r => r.id)).toEqual(['2', '3', '1']);
    c.setSearchSort('name');
    expect(c.searchSort).toEqual({ col: 'name', dir: -1 });
    expect(c.searchSortedRows(rows).map(r => r.id)).toEqual(['1', '3', '2']);
    c.setSearchSort('name');
    expect(c.searchSort).toBeNull(); expect('memex_search_sort' in c.store).toBe(false);
    c.setSearchSort('modified');
    expect(c.searchSortedRows(rows).map(r => r.id)).toEqual(['3', '1', '2']); // the real modified time wins over created
    c.setSearchSort('size');
    expect(c.searchSortedRows(rows).map(r => r.id)).toEqual(['2', '3', '1']);
  });
  test('the header row is buttons with arrows, and says what a click does', () => {
    const { c } = ctxFor();
    let head = c.searchTableHeadHtml();
    expect(head).toContain('<button class="file-col-sort" title="Sort by name" onclick="setSearchSort(\'name\')">Name</button>');
    expect(head).toContain('<th class="file-col-actions" style="text-align:right">Actions</th>');
    c.setSearchSort('modified'); head = c.searchTableHeadHtml();
    expect(head).toContain('<button class="file-col-sort active" title="Sort the other way" onclick="setSearchSort(\'modified\')">Modified ▲</button>');
    c.setSearchSort('modified'); head = c.searchTableHeadHtml();
    expect(head).toContain('title="Back to best match first" onclick="setSearchSort(\'modified\')">Modified ▼</button>');
  });
  test('matching folders come first, say where they live, and open there; the type menu narrows the results', () => {
    const { c, el } = ctxFor();
    c.renderContentSearchResults(rows, 'empire', folders);
    expect(el.innerHTML.indexOf('Empire Roofing')).toBeLessThan(el.innerHTML.indexOf('data-file="1"'));
    expect(el.innerHTML).toContain('data-lib="L1" data-folder="Clients/Empire Roofing" onclick="openLibraryAt(this.dataset.lib, this.dataset.folder)"');
    expect(el.innerHTML).toContain('<div class="file-row-sub">Projects › Clients · 12 items</div>');
    expect(c._contentSearch).toEqual({ rows, q: 'empire', folders });
    expect(c.lastRenderedFileIds).toEqual(['1', '2', '3']);
    const only = ctxFor('folders'); only.c.renderContentSearchResults(rows, 'empire', folders);
    expect(only.el.innerHTML).toContain('Empire Roofing'); expect(only.el.innerHTML).not.toContain('data-file=');
    const docs = ctxFor('docs'); docs.c.renderContentSearchResults(rows, 'plan', folders);
    expect(docs.el.innerHTML).not.toContain('Empire Roofing'); expect(docs.el.innerHTML).toContain('data-file="1"'); expect(docs.el.innerHTML).not.toContain('data-file="2"');
    const none = ctxFor('docs'); none.c.renderContentSearchResults([rows[1]], 'notes', []);
    expect(none.el.innerHTML).toContain('No matches'); expect(none.el.innerHTML).toContain('Nothing matched “notes” in names or contents for this type.');
  });
  test('a search asks for folders alongside files', () => {
    const run = fnText('runSearch');
    expect(run).toContain("apiGet('/files/search-folders?q=' + encodeURIComponent(q)).catch(() => [])");
    expect(run).toContain('renderContentSearchResults(Array.isArray(results) ? results : [], q, Array.isArray(folders) ? folders : [])');
  });
});

describe('the Modified column', () => {
  test('reads the real modified time, falling back to when the file was added', () => {
    expect(fnText('fileCellHtml')).toContain("if (colId === 'modified') return fileDate(f.modified_at || f.created_at);");
    expect(html).toContain("sort: (a, b) => new Date(a.modified_at || a.created_at || 0) - new Date(b.modified_at || b.created_at || 0)");
    expect(html).toContain("['Modified', fileDate(f.modified_at || f.created_at)],");
  });
});

describe('the blocked-types setting', () => {
  test('says that empty means nothing is refused', () => {
    expect(html).toContain('(extensions refused on upload; empty means nothing is refused)');
    expect(html).toContain('placeholder="Nothing is refused. To refuse types, list them: .exe .bat .msi"');
  });
});

test('every inline script still parses', () => {
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g; let m, n = 0;
  while ((m = re.exec(html))) { n++; expect(() => new vm.Script(m[1])).not.toThrow(); }
  expect(n).toBeGreaterThan(0);
});

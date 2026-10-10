'use strict';
// What the October 2026 interface review asked for (index.html): the rail keeps every item
// within reach, the library menu survives a long name, the tree's expand control is a real
// button, the library menu follows the menu-button pattern, and errors say what to do next.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const html = fs.readFileSync(path.join(__dirname, '../../../index.html'), 'utf8');
const fnText = (name) => {
  const start = html.search(new RegExp(`^(async )?function ${name}\\(`, 'm'));
  if (start < 0) throw new Error(`${name} not found in index.html`);
  return html.slice(start, html.indexOf('\n}\n', start) + 3);
};
const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));

describe('the rail', () => {
  test('the folder tree scrolls on its own, so the rest of the rail stays within reach', () => {
    expect(css).toMatch(/\.file-rail-tree \{[^}]*max-height: 40vh;[^}]*overflow-y: auto;/);
  });
  test('Workspace › Admin comes right after the main views, before Connections and Quick access', () => {
    const nav = fnText('fileHomeNav');
    const admin = nav.indexOf('<div class="file-rail-foot"><div class="file-nav-section">Workspace</div>'), conn = nav.indexOf('connMountsNavHtml()'), quick = nav.indexOf('>Quick access</div>');
    expect(admin).toBeGreaterThan(0);
    expect(admin).toBeLessThan(conn);
    expect(conn).toBeLessThan(quick);
    expect(css).toMatch(/\.file-rail-foot \{ position: fixed; left: 0; bottom: 0;/);
    expect(css).toMatch(/\.file-library-nav-body:has\(\.file-rail-foot\) \{ padding-bottom: 112px; \}/);
  });
});

describe('the folder tree', () => {
  const tree = (over = {}) => {
    const ctx = {
      folderIndex: [{ path: 'Clients', name: 'Clients', count: 3 }, { path: 'Clients/Acme', name: 'Acme', count: 1 }],
      folderChildren: new Map([['', [{ path: 'Clients', name: 'Clients', count: 3 }]], ['Clients', [{ path: 'Clients/Acme', name: 'Acme', count: 1 }]]]),
      currentFolderPath: 'Clients/Acme', railFindQuery: '', RAIL_FIND_MAX: 100,
      localStorage: { getItem: () => JSON.stringify(['Clients']), setItem: () => {} },
      FOLDER_SVG: '<i></i>', ICON_CARET: '<svg/>', ...over,
    };
    vm.runInNewContext(`${fnText('esc')}\n${fnText('normalizeFilePath')}\n${fnText('railExpanded')}\n${fnText('childFoldersFromIndex')}\n${fnText('railFindMatches')}\n${fnText('fileRailTreeHtml')}\nthis.html = fileRailTreeHtml();`, ctx);
    return ctx.html;
  };
  test('expand is a named button that says whether the branch is open', () => {
    const out = tree();
    expect(out).toMatch(/<button class="fc-caret" type="button" data-folder="Clients" aria-expanded="true" aria-label="Collapse Clients"/);
    expect(out).not.toMatch(/<span class="fc-caret"[^>]*onclick/);
    expect(out).toMatch(/<div class="fc-row active" style="padding-inline-start:15px">/);   // the open folder, one level in
  });
  test('a leaf keeps the column with an invisible spacer, and the open button keeps its drop target', () => {
    const out = tree();
    expect(out).toContain('<span class="fc-caret fc-caret-empty" aria-hidden="true"></span>');
    expect(out).toMatch(/<button class="file-commander-folder active" data-folder="Clients\/Acme"/);
  });
  test('the caret is 24px square with a focus ring', () => {
    expect(css).toMatch(/\.fc-caret \{[^}]*width: 24px; height: 24px;/);
    expect(css).toMatch(/\.fc-caret:focus-visible \{ outline: 2px solid var\(--accent\)/);
  });
  test('a redraw gives a focused caret or row back', () => {
    expect(fnText('refreshFileRailTree')).toMatch(/CSS\.escape\(focusKey\.folder\)[\s\S]*\?\.focus\(\)/);
  });
});

describe('the library menu', () => {
  test('a long name truncates instead of widening every row', () => {
    expect(css).toMatch(/\.library-menu-list \{[^}]*grid-template-columns: minmax\(0, 1fr\);/);
    expect(css).toMatch(/\.library-menu-item-name \{ display: block; flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; \}/);
    expect(fnText('libraryMenuRow')).toContain('title="${escAttr(l.name)}"');
  });
  test('the pin is the same star icon the rail uses, not a text glyph', () => {
    const row = fnText('libraryMenuRow');
    expect(row).toContain("navIcon('favorites', 'library-pin-ic')");
    expect(row).not.toMatch(/[★☆]/);
  });
  test('Escape closes it and the trigger says whether it is open', () => {
    expect(fnText('anyMenuOpen')).toContain('#library-menu.open');
    expect(fnText('toggleLibraryMenu')).toContain("setAttribute('aria-expanded', String(opening))");
    expect(fnText('closeLibraryMenu')).toMatch(/menu\.contains\(document\.activeElement\)\) heading\.focus\(\)/);
    expect(html).toMatch(/class="file-library-heading" type="button" onclick="toggleLibraryMenu\(event\)" aria-haspopup="true" aria-expanded="false" aria-controls="library-menu"/);
  });
  test('the folded groups meet the 24px floor', () => {
    expect(css).toMatch(/\.library-menu-fold \{[^}]*min-height: 24px;/);
  });
  test('the sign-in choice keeps one voice', () => {
    expect(html).toContain('Open “${esc(cur.name)}” when you sign in');
    expect(html).not.toContain('when I sign in</button>');
  });
});

describe('search boxes', () => {
  test('the declared sizes win over the global input rule, and placeholders use the faint-ink token', () => {
    expect(css).toMatch(/input\.file-rail-find \{[^}]*font: 500 14px var\(--ui\)/);
    expect(css).toMatch(/input\.library-menu-search \{[^}]*font: 500 14px var\(--ui\)/);
    expect(css).toMatch(/input\.admin-find \{[^}]*font: 13px var\(--ui\)/);
    expect(css).toMatch(/input\.file-rail-find::placeholder, input\.library-menu-search::placeholder, input\.admin-find::placeholder \{ color: var\(--ink-faint\); \}/);
  });
  test('a search with no match says how to get out', () => {
    expect(html).toContain('No library matches “${esc(libraryMenuQuery.trim())}”. Clear the box to see them all.');
    expect(html).toContain('No folder matches “${esc(railFindQuery.trim())}”. Clear the box to see every folder.');
  });
});

describe('errors say what to do next', () => {
  test.each([
    ['adminFilesNote', /Couldn't load the file list\. Refresh the page to try again\./],
    ['openFolder', /emptyState\('Could not open this folder', `Try again, or refresh the page[\s\S]*onclick="openFolder\(this\.dataset\.folder, false\)">Try again<\/button>/],
    ['renderDocumentLibrary', /emptyState\('Could not load files', `Try again, or refresh the page[\s\S]*onclick="renderDocumentLibrary\(this\.dataset\.view\)">Try again<\/button>/],
    ['loadAccessReview', /emptyState\('Could not load the users list', `Try again, or refresh the page[\s\S]*onclick="loadAccessReview\(\)">Try again<\/button>/],
    ['renderDocumentLibraryList', /emptyState\('Search failed', `Try again, or refresh the page[\s\S]*onclick="retryNameSearch\(\)">Try again<\/button>/],
  ])('%s', (fn, want) => expect(fnText(fn)).toMatch(want));
  test('a failed name search is remembered as failed, and retried on request', () => {
    expect(fnText('runNameSearch')).toMatch(/nameSearch = \{ key, rows: Array\.isArray\(rows\) \? rows : \[\], failed \};/);
    expect(fnText('retryNameSearch')).toContain("nameSearch = { key: '', rows: [] }");
  });
});

describe('the editor and the preview dialog', () => {
  test('autosave results are announced', () => {
    expect(html).toContain('<span id="code-ed-state" role="status"></span>');
  });
  test('both preview dialogs carry their file name as the accessible name', () => {
    expect(html.match(/openModal\(\{ id: 'file-preview-scrim'[^`]*labelledBy: 'fp-title'/g)).toHaveLength(2);
    expect(html.match(/<strong id="fp-title" title=/g)).toHaveLength(2);
  });
  test('the whole-library warning starts its sentence properly', () => {
    expect(html).toContain('`Everyone in ${groupName}`');
    expect(html).not.toContain("open the folder's ⋯ menu");
  });
});

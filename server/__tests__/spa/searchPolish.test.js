'use strict';
// The search box in the masthead and the two "Find…" boxes in the rail, after the October
// 2026 polish: searching (names and contents) is the default, the AI is a choice; the
// chosen scope is marked for everyone; the rail's rows share one set of insets (index.html).
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const html = fs.readFileSync(path.join(__dirname, '../../../index.html'), 'utf8');
const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
const fnText = (name) => {
  const start = html.search(new RegExp(`^(async )?function ${name}\\(`, 'm'));
  if (start < 0) throw new Error(`${name} not found in index.html`);
  return html.slice(start, html.indexOf('\n}\n', start) + 3);
};
// The scope code, run against a fake page: a label span, an input and a menu.
const load = ({ stored = null, ai = 'depot:assistant', models = [{ provider: 'depot', id: 'assistant', label: 'Assistant' }] } = {}) => {
  const store = stored ? { memex_search_scope_v3: stored } : {};
  const els = {
    'search-control-label': { textContent: '' },
    'global-search': { placeholder: '', value: '', focus() { this.focused = true; } },
    'search-control-menu': { classList: new Set(), innerHTML: '', contains: () => false },
    'search-control-btn': { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, focus() { this.focused = true; } },
  };
  els['search-control-menu'].classList.add = function (c) { Set.prototype.add.call(this, c); };
  els['search-control-menu'].classList.remove = function (c) { Set.prototype.delete.call(this, c); };
  els['search-control-menu'].classList.contains = function (c) { return Set.prototype.has.call(this, c); };
  const ctx = {
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    document: { getElementById: (id) => els[id] || null, activeElement: null },
    aiActive: ai, aiModels: models, currentUser: { role: 'contributor' },
    closeAllMenus() { ctx.closeSearchControlMenu(); }, runSearch() { ctx.ran = true; },
    store, els, String, Set, JSON,
  };
  vm.runInNewContext(['esc', 'aiOff', 'aiModelShortLabel', 'searchScopes', 'currentScope', 'renderSearchScope', 'searchControlMenuInnerHtml',
    'toggleSearchControlMenu', 'closeSearchControlMenu', 'pickSearchScope', 'aiModelMenuInnerHtml'].map(fnText).join('\n')
    + "\nvar searchScope = localStorage.getItem('memex_search_scope_v3') || 'contents';\nthis.scope = () => searchScope;", ctx);
  return ctx;
};

describe('what the search box does by default', () => {
  test('searching, not asking: the first visit has Contents chosen and the box says so', () => {
    const c = load();
    expect(c.scope()).toBe('contents');
    expect(html).toMatch(/let searchScope = localStorage\.getItem\('memex_search_scope_v3'\) \|\| 'contents';/);
    c.renderSearchScope();
    expect(c.els['search-control-label'].textContent).toBe('Contents');
    expect(c.els['global-search'].placeholder).toBe('Search files and folders…');
    // The page starts that way before any script runs, too.
    expect(html).toContain('<span id="search-control-label">Contents</span>');
    expect(html).toContain('placeholder="Search files and folders…"');
  });
  test('a choice is remembered under the new key, so an old "auto" does not come back', () => {
    const c = load();
    c.pickSearchScope('names');
    expect(c.store.memex_search_scope_v3).toBe('names');
    expect(c.store.memex_search_scope_v2).toBeUndefined();
    expect(load({ stored: 'names' }).scope()).toBe('names');
    expect(html).not.toContain("memex_search_scope_v2");
  });
  test('the chip names the scope only; the model in use is said inside the menu', () => {
    const c = load({ ai: 'anthropic:claude-haiku-4-5', models: [{ provider: 'anthropic', id: 'claude-haiku-4-5', label: 'claude-haiku-4-5' }] });
    c.renderSearchScope();
    expect(c.els['search-control-label'].textContent).toBe('Contents');
    expect(c.aiModelMenuInnerHtml()).toContain('In use: Haiku 4.5.');
  });
  test('each scope says where it looks', () => {
    const c = load();
    c.pickSearchScope('names');
    expect(c.els['global-search'].placeholder).toBe('Find by name in this library…');
    expect(c.searchScopes().map(s => s.hint)).toEqual([
      'Search, or ask when it reads like a question', 'File names and contents, in every library', 'File names only, in this library', 'An answer drawn from your files',
    ]);
  });
});

describe('the AI as a choice', () => {
  test('with AI off, Auto and Ask AI are not offered, and an old Ask choice falls back to Contents', () => {
    const c = load({ stored: 'ask', ai: 'off' });
    expect(c.searchScopes().map(s => s.id)).toEqual(['contents', 'names']);
    c.renderSearchScope();
    expect(c.scope()).toBe('contents');
  });
  test('a model id reads like a name', () => {
    const c = load();
    expect(c.aiModelShortLabel('anthropic:claude-haiku-4-5')).toBe('Haiku 4.5');
    expect(c.aiModelShortLabel('anthropic:claude-opus-4-8')).toBe('Opus 4.8');
    expect(c.aiModelShortLabel('openai:gpt-4o-mini')).toBe('gpt-4o-mini');
    expect(c.aiModelShortLabel('off')).toBe('AI off');
  });
});

describe('the scope menu', () => {
  test('the chosen scope carries a tick and aria-current, not colour alone', () => {
    const c = load();
    const menu = c.searchControlMenuInnerHtml();
    expect(menu).toMatch(/<button class="search-scope-item active" aria-current="true" onclick="pickSearchScope\('contents'\)"><span>Contents<\/span><span class="search-scope-check" aria-hidden="true">✓<\/span>/);
    expect((menu.match(/aria-current/g) || []).length).toBe(1);
    expect((menu.match(/search-scope-check/g) || []).length).toBe(1);
  });
  test('the button says whether the menu is open, and gets focus back when it closes', () => {
    const c = load();
    c.toggleSearchControlMenu();
    expect(c.els['search-control-btn'].attrs['aria-expanded']).toBe('true');
    expect(c.els['search-control-menu'].classList.contains('open')).toBe(true);
    c.els['search-control-menu'].contains = () => true;   // focus is on an item
    c.closeSearchControlMenu();
    expect(c.els['search-control-btn'].attrs['aria-expanded']).toBe('false');
    expect(c.els['search-control-btn'].focused).toBe(true);
    expect(html).toMatch(/id="search-control-btn"[^>]*aria-haspopup="true" aria-expanded="false" aria-controls="search-control-menu"><span class="sr-only">Search scope: <\/span>/);
    expect(html).toMatch(/<span class="chev" aria-hidden="true">⌄<\/span><\/button>\n\s*<div class="search-scope-menu" id="search-control-menu">/);
  });
  test('the masthead search has no sparkle and names itself plainly', () => {
    expect(html).not.toContain('search-spark');
    expect(html).toContain('id="global-search" type="search" placeholder="Search files and folders…" oninput="globalSearch(this.value)" onkeydown="if(event.key===\'Enter\')runSearch()" autocomplete="off" aria-label="Search"');
    expect(css).toMatch(/\.masthead-search input::placeholder \{ color: var\(--ink-faint\); opacity: 1; \}/);
  });
});

describe('the rail lines up', () => {
  test('Find a folder is a row of the rail: magnifier where the nav icons sit, hidden as a whole', () => {
    const nav = fnText('fileHomeNav');
    expect(nav).toContain(`<div class="rail-find" id="file-rail-find-wrap"\${railFindWanted() ? '' : ' hidden'}>\${navIcon('search', 'rail-find-ic')}<input type="search" class="file-rail-find" id="file-rail-find"`);
    expect(fnText('refreshFileRailTree')).toContain("document.getElementById('file-rail-find-wrap');");
    expect(fnText('railFind')).toContain("document.getElementById('file-rail-find-wrap');");
    expect(css).toMatch(/\.rail-find \{[^}]*min-height: 38px;[^}]*padding: 0 11px;[^}]*border: 1px solid transparent;/);
    expect(css).toMatch(/\.rail-find\[hidden\] \{ display: none; \}/);
    expect(css).toMatch(/\.rail-find:focus-within \{ background: var\(--surface\); border-color: var\(--accent\);/);
    expect(css).toMatch(/\.file-nav-section, \.file-quick-list, \.file-pinned-section, \.file-rail-tree, \.rail-find \{ display: none; \}/);
  });
  test('tree rows, section labels, the pinned header and quick access share the nav rows\' inset', () => {
    expect(css).toMatch(/\.file-rail-tree \{[^}]*margin: 0 0 4px;/);
    expect(css).toMatch(/\.file-nav-section \{ margin: 8px 12px 0;/);
    expect(css).toMatch(/\.file-pinned-header \{[^}]*padding: 6px 12px 2px;/);
    expect(css).toMatch(/\.file-quick-pill \{[^}]*padding: 7px 12px;/);
    expect(css).toMatch(/\.file-quick-group \{[^}]*padding: 11px 12px 3px; \}/);
    expect(css).toMatch(/\.file-library-heading \{[^}]*padding: 9px 11px;/);
    expect(css).toMatch(/\.file-rail-note \{ padding: 6px 12px 6px 38px;/);
  });
  test('the library menu: labels on the items\' line, the same find box, and the access under the name', () => {
    expect(css).toMatch(/\.library-menu-label \{[^}]*padding: 6px 10px 4px; \}/);
    expect(fnText('libraryMenuInnerHtml')).toContain(`<div class="menu-find" onclick="event.stopPropagation()">\${navIcon('search', 'rail-find-ic')}<input type="search" class="library-menu-search" id="library-menu-search"`);
    expect(fnText('libraryMenuRow')).toContain('<span class="library-menu-item-sub">${LIBRARY_PILL[l.my_access]}</span>');
    expect(css).toMatch(/\.library-menu-item-wrap \.library-menu-item \{[^}]*flex-direction: column; align-items: stretch;/);
  });
});

'use strict';
// The foot of the library menu (index.html, libraryMenuActionsHtml): the library you are in is
// named once, as a heading nothing can focus, and the rows under it are the file row menu's
// verbs. "Open at sign-in" is a setting that says whether it is on. Putting a library away sits
// last, past a rule, in the danger colour. "New library" belongs to the list, not to this library.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '../../../index.html'), 'utf8');
const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
const fnSource = (name) => {
  const start = html.search(new RegExp(`^(async )?function ${name}\\(`, 'm'));
  if (start < 0) throw new Error(`${name} not found in index.html`);
  const open = html.indexOf('{', start);
  let depth = 0;
  for (let j = open; j < html.length; j++) { if (html[j] === '{') depth++; else if (html[j] === '}' && --depth === 0) return html.slice(start, j + 1); }
  throw new Error(name);
};
// Everything from the section comment to the search handler: the helpers, the new function
// and libraryMenuInnerHtml itself, the way the other menu tests load it.
const section = html.slice(html.indexOf('// ---- Library menu ----'), html.indexOf('function libraryMenuSearch('));

const LIB = (over = {}) => ({ id: 'L1', name: 'Dave Burgess', my_access: 'owner', can_manage: true, owner_id: 'u1', archived_at: null, ...over });
function menu({ library = LIB(), role = 'contributor', start = null, others = [] } = {}) {
  const libraries = [...(library ? [library] : []), ...others];
  const ctx = {
    librariesList: libraries, currentLibraryId: library ? library.id : null, pinnedLibraryIds: new Set(), startLibraryId: start,
    currentUser: { id: 'me', role }, navIcon: () => '', ICON_SHARE: '', LIBRARY_PILL: {},
    localStorage: { getItem: () => null, setItem: () => {} },
    currentLibrary: () => libraries.find(l => String(l.id) === String(library && library.id)) || null,
  };
  vm.runInNewContext(['esc', 'escAttr', 'canShareLibrary', 'libraryMenuRow'].map(fnSource).join('\n') + '\n' + section + '\nthis.out = libraryMenuInnerHtml();', ctx);
  return ctx.out;
}
const foot = (out) => out.slice(out.indexOf('<div class="library-menu-actions"'));
const buttonsIn = (part) => [...part.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map(m => m[1].replace(/<[^>]+>/g, ''));

describe('the library you are in, at the foot of the menu', () => {
  test('is named once, as a heading nothing can focus, and the rows under it are verbs', () => {
    const out = menu();
    const f = foot(out);
    expect(f).toContain('<div class="library-menu-for" id="library-menu-for" title="Dave Burgess">Dave Burgess</div>');
    expect(f.split('Dave Burgess').length - 1).toBe(2);             // the heading's text and its tooltip, nowhere else
    expect(buttonsIn(f)).toEqual(['Share…', 'Who has access…', 'Rename…', 'Open at sign-in']);
    expect(f).not.toMatch(/library-menu-for[^>]*(tabindex|role="button"|onclick)/);
    expect(html).not.toContain('when you sign in</button>');
    expect(html).not.toContain('Who has access to “${esc(cur.name)}”');
  });
  test('the rows sit in a group the heading labels, so a screen reader hears the name once', () => {
    expect(foot(menu())).toMatch(/^<div class="library-menu-actions" role="group" aria-labelledby="library-menu-for">/);
  });
  test('the heading escapes the name in its text and its tooltip', () => {
    const f = foot(menu({ library: LIB({ name: 'Odd & <name>' }) }));
    expect(f).toContain('title="Odd &amp; &lt;name&gt;">Odd &amp; &lt;name&gt;</div>');
    expect(f).not.toContain('<name>');
  });
  test('reads top to bottom: the list, New library, a rule, then this library', () => {
    const out = menu({ role: 'admin' });
    const at = (s) => { const i = out.indexOf(s); if (i < 0) throw new Error('missing ' + s); return i; };
    const order = ['id="library-menu-list"', '＋ New library', '<div class="library-menu-sep"></div>', 'library-menu-for', '>Share…<', '>Who has access…<', '>Rename…<', 'Open at sign-in', '>Put away…<'];
    expect(order.map(at)).toEqual([...order.map(at)].sort((a, b) => a - b));
    expect(out.indexOf('library-menu-sep')).toBeGreaterThan(out.indexOf('＋ New library'));
  });
});

describe('Open at sign-in is a setting', () => {
  test('off: a plain row that turns it on for this library', () => {
    const f = foot(menu({ start: null }));
    expect(f).toContain('<button class="library-menu-item library-menu-toggle" type="button" aria-pressed="false" data-lib="L1" onclick="setStartLibrary(this.dataset.lib)" title="Open this library each time you sign in"><span>Open at sign-in</span></button>');
    expect(f).not.toContain('library-menu-check');
  });
  test('on: the same words, pressed, with a check, and selecting it turns it off', () => {
    const f = foot(menu({ start: 'L1' }));
    expect(f).toContain('aria-pressed="true" onclick="setStartLibrary(null)" title="On: this library opens each time you sign in. Select to turn that off."><span>Open at sign-in</span><span class="library-menu-check" aria-hidden="true">✓</span></button>');
    expect(f).not.toContain('aria-pressed="false"');
  });
  test('another library opening at sign-in leaves this one off', () => {
    expect(foot(menu({ start: 'L9' }))).toContain('aria-pressed="false"');
  });
});

describe('putting a library away', () => {
  test('sits last, past its own rule, in the danger colour, for administrators only', () => {
    const f = foot(menu({ role: 'admin' }));
    expect(f).toMatch(/<\/button><div class="library-menu-sep"><\/div><button class="library-menu-item danger" type="button" data-lib="L1" data-away="1" onclick="closeLibraryMenu\(\);setLibraryArchived\(this\.dataset\.lib, !!this\.dataset\.away\)">Put away…<\/button><\/div>$/);
    expect(f.split('library-menu-sep').length - 1).toBe(1);
    expect(foot(menu({ role: 'contributor' }))).not.toContain('setLibraryArchived');
  });
  test('a library already put away offers Bring back, which is not a danger', () => {
    const f = foot(menu({ role: 'admin', library: LIB({ archived_at: '2026-10-09T00:00:00Z' }) }));
    expect(f).toContain('<button class="library-menu-item" type="button" data-lib="L1" data-away="" onclick="closeLibraryMenu();setLibraryArchived(this.dataset.lib, !!this.dataset.away)">Bring back</button>');
    expect(f).not.toContain('danger');
  });
});

describe('who sees which rows', () => {
  test('a viewer in a read-only library: your access and the sign-in setting, nothing to change', () => {
    const out = menu({ role: 'viewer', library: LIB({ my_access: 'r', can_manage: false, owner_id: 'u2' }) });
    expect(buttonsIn(foot(out))).toEqual(['Your access…', 'Open at sign-in']);
    expect(out).not.toContain('New library');
  });
  test('a contributor in a library shared Read-Write: the same two rows, and New library above', () => {
    const out = menu({ role: 'contributor', library: LIB({ my_access: 'rw', can_manage: false, owner_id: 'u2' }) });
    expect(buttonsIn(foot(out))).toEqual(['Your access…', 'Open at sign-in']);
    expect(out.indexOf('＋ New library')).toBeLessThan(out.indexOf('library-menu-for'));
  });
  test('an administrator who manages it: every row', () => {
    expect(buttonsIn(foot(menu({ role: 'admin' })))).toEqual(['Share…', 'Who has access…', 'Rename…', 'Open at sign-in', 'Put away…']);
  });
  test('a library with no owner yet cannot be shared, as before', () => {
    expect(buttonsIn(foot(menu({ role: 'admin', library: LIB({ my_access: 'admin', owner_id: null }) })))).toEqual(['Who has access…', 'Rename…', 'Open at sign-in', 'Put away…']);
  });
  test('no library open: the list and New library, with no rule left dangling', () => {
    const out = menu({ library: null, role: 'admin', others: [LIB({ id: 'L2', name: 'Clients' })] });
    expect(out).not.toContain('library-menu-actions');
    expect(out).not.toContain('library-menu-sep');
    expect(out).toContain('＋ New library');
  });
});

describe('the wiring is the one the old rows had', () => {
  test('ids travel in data attributes, never spliced into a handler', () => {
    const f = foot(menu({ role: 'admin', library: LIB({ id: 'x"y' }) }));
    expect(f).toContain('data-share-lib="x&quot;y"');
    expect(f).toContain('data-access-lib="x&quot;y"');
    expect(f).toContain('data-lib="x&quot;y" onclick="closeLibraryMenu();renameLibrary(this.dataset.lib)">Rename…');
    expect(f).not.toMatch(/onclick="[^"]*x&quot;y/);
  });
  test('the toast and the preference logic are untouched', () => {
    const set = fnSource('setStartLibrary');
    expect(set).toContain("toast(startLibraryId ? `“${lib?.name || 'This library'}” will open when you sign in` : 'Sign-in will open the library you used last')");
    expect(set).toContain('syncPreferencesToServer();');
  });
});

describe('the styles', () => {
  test('the rail block and the menu are one column that can shrink, so a long name never sets their width', () => {
    // A grid track whose minimum is auto takes the widest nowrap text as its floor: the heading's name
    // and relation line, the menu's heading. minmax(0, 1fr) lets them truncate instead.
    expect(css).toMatch(/\.file-library-nav \{ display: grid; grid-template-columns: minmax\(0, 1fr\); gap: 16px; \}/);
    expect(css).toMatch(/\.library-menu\.open \{ display: grid; grid-template-columns: minmax\(0, 1fr\); gap: 2px; \}/);
    expect(css).toMatch(/\.library-menu-actions \{ display: grid; grid-template-columns: minmax\(0, 1fr\); gap: 2px; \}/);
  });
  test('the heading truncates with an ellipsis and keeps the full name in its tooltip', () => {
    expect(css).toMatch(/\.library-menu-for \{[^}]*overflow: hidden; text-overflow: ellipsis; white-space: nowrap; \}/);
    expect(css).toMatch(/\.library-menu-for \{[^}]*font: 600 12px var\(--ui\); color: var\(--ink-soft\);/);
  });
  test('the danger row and the check use the tokens the row menu and the scope menu use', () => {
    expect(css).toMatch(/\.library-menu-item\.danger \{ color: var\(--danger\); \}/);
    expect(css).toMatch(/\.library-menu-check \{[^}]*color: var\(--accent\); \}/);
    expect(css).toMatch(/\.library-menu-toggle \{ display: flex; align-items: center; justify-content: space-between;/);
  });
});

'use strict';
// The rail's library block (index.html): the library you are in on top, the other pinned
// libraries as quiet rows under it, no stars and no "Pinned" header; a folder tree that
// says when it continues; one "you are here" mark; labels a weight below their rows.
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

function pins({ libraries, current, pinned }) {
  const ctx = { librariesList: libraries, currentLibraryId: current, pinnedLibraryIds: new Set(pinned.map(String)) };
  vm.runInNewContext(`${fnText('esc')}\n${fnText('escAttr')}\n${fnText('filePinnedSectionHtml')}\nthis.out = filePinnedSectionHtml();`, ctx);
  return ctx.out;
}
const lib = (id, name) => ({ id, name });
const EMPTY = '<div class="file-library-pins" id="file-pinned-section" hidden></div>';

describe('the library block', () => {
  const libraries = [lib('c', 'Clients'), lib('p', 'ParaTech IT'), lib('x', 'Odd & <name>')];
  test('lists the other pinned libraries, not the one you are in, each with its glyph and full name', () => {
    const out = pins({ libraries, current: 'c', pinned: ['c', 'p'] });
    expect(out).toContain('<div class="file-library-pins" id="file-pinned-section" role="group" aria-label="Pinned libraries">');
    expect(out).toContain('<span class="file-library-glyph file-library-glyph-sm" aria-hidden="true">P</span><span class="file-library-pin-name">ParaTech IT</span>');
    expect(out).toContain(`title="ParaTech IT" onclick="switchLibrary('p')"`);
    expect(out).not.toContain('Clients');
    expect(out).not.toMatch(/[★☆]|file-pin-star|file-pinned-header|togglePinnedSection/);
  });
  test('keeps an empty, hidden holder when nothing else is pinned, so a pin from the menu can fill it', () => {
    expect(pins({ libraries, current: 'c', pinned: ['c'] })).toBe(EMPTY);
    expect(pins({ libraries, current: 'c', pinned: [] })).toBe(EMPTY);
    expect(fnText('refreshPinnedSection')).toContain("document.getElementById('file-pinned-section')");
  });
  test('escapes a library name in the row and in its tooltip', () => {
    const out = pins({ libraries, current: 'c', pinned: ['x'] });
    expect(out).toContain('Odd &amp; &lt;name&gt;');
    expect(out).not.toContain('<name>');
  });
  test('the heading and the pinned rows share one bordered block, with the menu hanging off it', () => {
    const nav = fnText('fileHomeNav');
    expect(nav).toContain('<div class="library-switch-wrap file-library-block">');
    expect(nav.indexOf('class="file-library-heading"')).toBeLessThan(nav.indexOf('${filePinnedSectionHtml()}'));
    expect(nav.indexOf('${filePinnedSectionHtml()}')).toBeLessThan(nav.indexOf('<div class="library-menu" id="library-menu">'));
    expect(nav).toContain('<span class="file-library-heading-name" title="${escAttr(currentLibraryName())}">');
    expect(css).toMatch(/\.file-library-block \{ border: 1px solid var\(--rule\); border-radius: 10px; background: var\(--surface\);/);
    expect(css).toMatch(/html\.dark \.file-library-block \{ background: var\(--surface-raised\);/);
    expect(css).toMatch(/\.file-library-pins \{[^}]*border-top: 1px solid var\(--rule-soft\);/);
    expect(css).not.toMatch(/\.file-pinned-|\.file-pin-star/);
    expect(html).not.toContain('togglePinnedSection');
    expect(html).not.toContain('memex_pinned_collapsed');
  });
  test('on tablets and phones the block flattens to the chip and the pinned rows go back to the menu', () => {
    expect(css).toMatch(/\.file-library-block \{ border: 0; border-radius: 0; background: transparent; box-shadow: none; \}/);
    // the desktop :has() rule that squares the heading's bottom corners above the pinned rows outranks the pill, so the pill restates itself with it
    expect(css).toMatch(/\.file-library-block \.file-library-heading, \.file-library-block:has\(\.file-library-pins:not\(\[hidden\]\)\) \.file-library-heading \{ border: 1px solid var\(--rule\); border-radius: 999px;/);
    expect(css).toMatch(/\.file-nav-section, \.file-quick-list, \.file-library-pins, \.file-rail-tree, \.rail-find \{ display: none; \}/);
  });
});

describe('the folder tree', () => {
  test('fades at its foot while more folders sit below, and the fade lifts at the end', () => {
    expect(css).toMatch(/\.file-rail-tree\.has-more \{[^}]*mask-image: linear-gradient\(to bottom, #000 calc\(100% - 36px\), transparent\);/);
    expect(fnText('railTreeCue')).toContain("classList.toggle('has-more', tree.scrollHeight - tree.scrollTop - tree.clientHeight > 6)");
    expect(fnText('refreshFileRailTree')).toContain('railTreeCue();');
    expect(fnText('railFind')).toContain('railTreeCue();');
  });
  test('counts wait for hover or focus, so names keep the full width at rest', () => {
    expect(css).toMatch(/\.file-rail-tree \.file-commander-folder \{ grid-template-columns: 22px minmax\(0, 1fr\); position: relative;/);
    expect(css).toMatch(/\.file-rail-tree \.file-commander-count \{ position: absolute;[^}]*opacity: 0;/);
    expect(css).toMatch(/\.file-rail-tree \.file-commander-folder:hover \.file-commander-count, \.file-rail-tree \.file-commander-folder:focus-visible \.file-commander-count \{ opacity: 1; \}/);
  });
  test('the folder being viewed is the raised row, not an accent wash, and Files then keeps only its weight', () => {
    expect(css).toMatch(/\.file-rail-tree \.fc-row\.active \{ background: var\(--surface\); box-shadow: 0 1px 2px rgba\(0,0,0,\.05\), 0 0 0 1px var\(--rule\); \}/);
    expect(css).toMatch(/html\.dark \.file-rail-tree \.fc-row\.active \{ background: var\(--surface-raised\);/);
    expect(css).toMatch(/\.file-nav-link\.current \{ color: var\(--ink\); font-weight: 600; \}/);
    expect(fnText('markRailLocation')).toContain("files.classList.toggle('active', !currentFolderPath)");
    expect(fnText('refreshFileRailTree')).toContain('markRailLocation();');
    expect(fnText('fileHomeNav')).toContain("activeWorkspace === 'files' && activeFile === 'files' && !inFolder, inFolder ? 'current' : ''");
    expect(css).toMatch(/\.file-nav-link\.active, \.file-nav-link\.current \{ background: var\(--surface-2\); border-color: var\(--line-strong\);/);
  });
});

describe('the rail labels', () => {
  test('are sentence case at a weight below the rows they label', () => {
    expect(css).toMatch(/\.file-nav-section \{ margin: 8px 12px 0; font-size: 12px; font-weight: 600; color: var\(--ink-faint\); \}/);
    expect(css).toMatch(/\.file-quick-group \{ font-size: 12px; font-weight: 600; color: var\(--ink-faint\); padding: 11px 12px 3px; \}/);
    expect(css).not.toMatch(/html\.dark \.file-nav-section,/);
  });
});

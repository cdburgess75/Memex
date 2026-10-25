'use strict';
// The rail's edge (index.html): a grip you can see at rest, a separator a keyboard can move,
// one width setter for drag and keys; and the nav says "Links", not "My links".
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
const consts = html.match(/^const RAIL_MIN = .*$/m)[0];

function rig(startWidth = 0) {
  const store = new Map();
  const vars = {};
  const resizer = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
  const shell = { style: { setProperty: (k, v) => { vars[k] = v; } }, querySelector: () => resizer };
  const ctx = {
    railWidth: startWidth,
    document: { getElementById: (id) => (id === 'file-home-shell' ? shell : null) },
    localStorage: { setItem: (k, v) => store.set(k, v), getItem: (k) => store.get(k) ?? null },
    vars, store, resizer,
  };
  vm.runInNewContext(`${consts}\n${fnText('setRailWidth')}\n${fnText('railResizeKey')}\nthis.set = setRailWidth; this.key = railResizeKey; this.width = () => railWidth;`, ctx);
  return ctx;
}
const key = (k, shiftKey = false) => ({ key: k, shiftKey, preventDefault() { this.prevented = true; } });

describe('setRailWidth', () => {
  test('clamps to the rail\'s range, sets the custom property, the separator value and the memory', () => {
    const r = rig();
    r.set(300);
    expect(r.width()).toBe(300);
    expect(r.vars['--memex-rail-w']).toBe('300px');
    expect(r.resizer.attrs['aria-valuenow']).toBe('300');
    expect(r.store.get('memex_rail_w')).toBe('300');
    r.set(100); expect(r.width()).toBe(190);
    r.set(900); expect(r.width()).toBe(460);
    r.set('nonsense'); expect(r.width()).toBe(248);
  });
  test('a drag in progress updates the width without writing the memory each move', () => {
    const r = rig();
    r.set(321, false);
    expect(r.vars['--memex-rail-w']).toBe('321px');
    expect(r.store.has('memex_rail_w')).toBe(false);
  });
});

describe('the keyboard', () => {
  test('arrows move 16px, Shift+arrows 48px, Home and End to the ends, Enter back to the default', () => {
    const r = rig(248);
    const right = key('ArrowRight'); r.key(right); expect(r.width()).toBe(264); expect(right.prevented).toBe(true);
    r.key(key('ArrowLeft', true)); expect(r.width()).toBe(216);
    r.key(key('Home')); expect(r.width()).toBe(190);
    r.key(key('End')); expect(r.width()).toBe(460);
    r.key(key('Enter')); expect(r.width()).toBe(248);
    r.key(key(' ')); expect(r.width()).toBe(248);
  });
  test('any other key is left alone', () => {
    const r = rig(248);
    const tab = key('Tab'); r.key(tab);
    expect(r.width()).toBe(248);
    expect(tab.prevented).toBeUndefined();
  });
});

describe('the markup and the look', () => {
  test('the edge is a vertical separator with a name, a range and a current value', () => {
    expect(fnText('fileHomeShell')).toContain('<div class="rail-resizer" role="separator" aria-orientation="vertical" aria-label="Rail width" aria-valuemin="190" aria-valuemax="460" aria-valuenow="${railWidth || 248}" tabindex="0" onmousedown="startRailResize(event)" onkeydown="railResizeKey(event)" title="Drag to resize"></div>');
  });
  test('a grip shows at rest and the edge lights on hover, drag and keyboard focus', () => {
    expect(css).toMatch(/\.rail-resizer::after \{ content: ''; display: block; position: sticky; top: calc\(50vh - 16px\);[^}]*background: var\(--ink-faint\); opacity: 0\.6; \}/);
    expect(css).toMatch(/\.rail-resizer:hover::before, \.rail-resizer\.active::before, \.rail-resizer:focus-visible::before \{ background: var\(--accent\);/);
    expect(css).toMatch(/\.rail-resizer:hover::after, \.rail-resizer\.active::after, \.rail-resizer:focus-visible::after \{ background: var\(--accent\); opacity: 1; \}/);
    expect(css).toMatch(/\.rail-resizer \{ display: none; \}/);   // no edge on touch layouts
  });
  test('the drag goes through the same setter', () => {
    expect(fnText('startRailResize')).toContain('const move = ev => setRailWidth(ev.clientX - shell.getBoundingClientRect().left, false);');
  });
});

describe('Links', () => {
  test('the rail says Links, the page is titled Links, and admins keep their My / All switch', () => {
    expect(fnText('fileHomeNav')).toContain("fileNavButton('Links', 'links'");
    expect(html).toContain('<h2 class="file-home-title">Links</h2>');
    expect(html).toContain('data-links-scope="mine">My links</button>');
    expect(html).toContain('data-links-scope="all">All links (admin)</button>');
    expect(fnText('fileHomeNav')).not.toContain("'My links'");
  });
});

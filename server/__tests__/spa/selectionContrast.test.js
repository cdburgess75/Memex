'use strict';
// Selected text must be unmistakable in every scheme, light and dark (index.html). Each of the
// 18 palette blocks declares --selection and --selection-ink; the selection stands at least
// 3:1 from the surface it sits on (WCAG 1.4.11), the text on it reads at 4.5:1 or better
// (WCAG 1.4.3), and it stays 3:1 clear of --accent-wash, the tint that marks a selected row
// and the editor's current line, so the two never look alike. The ::selection rule itself
// takes both tokens, with no dark-mode override that could drift on its own.
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '../../../index.html'), 'utf8');

const SCHEMES = ['ledger', 'graphite', 'linen', 'harbor', 'ember', 'crest', 'iris', 'tide', 'dune'];

// The palette blocks sit at the top of the stylesheet, before the reset rule.
function palettes() {
  const head = html.slice(0, html.indexOf('* { box-sizing'));
  const re = /^(:root|html\.dark|html\[data-scheme="(\w+)"\](\.dark)?)[^{]*\{([\s\S]*?)\}/gm;
  const out = [];
  let m;
  while ((m = re.exec(head))) {
    const tokens = {};
    const body = m[4].replace(/\/\*[\s\S]*?\*\//g, ''); // comments mention tokens by name
    for (const t of body.matchAll(/--([\w-]+):\s*([^;]+);/g)) tokens[t[1]] = t[2].trim();
    out.push({ name: `${m[2] || 'ledger'} ${m[1] === 'html.dark' || m[3] ? 'dark' : 'light'}`, tokens });
  }
  return out;
}

// WCAG 2 relative luminance and contrast ratio, from a #RRGGBB value.
const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const HEX = /^#[0-9A-Fa-f]{6}$/;

describe('the selection tokens', () => {
  const all = palettes();

  test('every scheme has a light and a dark palette', () => {
    expect(all.map((p) => p.name).sort()).toEqual(SCHEMES.flatMap((s) => [`${s} dark`, `${s} light`]).sort());
  });

  test.each(all.map((p) => [p.name, p.tokens]))('%s declares --selection and --selection-ink as plain hex', (_name, t) => {
    expect(t.selection).toMatch(HEX);
    expect(t['selection-ink']).toMatch(HEX);
    expect(t.surface).toMatch(HEX);
    expect(t['accent-wash']).toMatch(HEX);
  });

  test.each(all.map((p) => [p.name, p.tokens]))('%s: the selection stands 3:1 from its surface', (_name, t) => {
    expect(contrast(t.selection, t.surface)).toBeGreaterThanOrEqual(3);
  });

  test.each(all.map((p) => [p.name, p.tokens]))('%s: text on the selection reads at 4.5:1', (_name, t) => {
    expect(contrast(t['selection-ink'], t.selection)).toBeGreaterThanOrEqual(4.5);
  });

  test.each(all.map((p) => [p.name, p.tokens]))('%s: the selection is 3:1 clear of the row and current-line tint', (_name, t) => {
    expect(contrast(t.selection, t['accent-wash'])).toBeGreaterThanOrEqual(3);
  });
});

describe('the ::selection rule', () => {
  const rules = [...html.matchAll(/^([^\n{]*::selection[^\n{]*)\{([^}]*)\}/gm)].map((m) => ({ selector: m[1].trim(), body: m[2] }));

  test('is one rule that takes both tokens', () => {
    expect(rules).toHaveLength(1);
    expect(rules[0].selector).toBe('::selection');
    expect(rules[0].body).toMatch(/background:\s*var\(--selection\)/);
    expect(rules[0].body).toMatch(/color:\s*var\(--selection-ink\)/);
  });
});

'use strict';
// The compliance window was 34 controls in two narrow columns of 12px text, each one's state
// a bare coloured square. It is read one framework at a time now; these keep what makes it
// readable from quietly going back.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const html = fs.readFileSync(path.join(__dirname, '../../../index.html'), 'utf8');
const block = (name) => { const s = html.search(new RegExp(`\\n(?:async )?function ${name}\\(`)); let d = 0; const i = html.indexOf('{', s); for (let j = i; ; j++) { if (html[j] === '{') d++; else if (html[j] === '}' && --d === 0) return html.slice(s, j + 1); } };
const between = (a, b) => html.slice(html.indexOf(a), html.indexOf(b));

const DATA = { disclaimer: 'd', probes: {}, frameworks: [
  { id: 'soc2', name: 'SOC 2', enabled: false, scope: 's', controls: [{ id: 'a', label: 'A', ready: true, evidence: 'e' }] },
  { id: 'hipaa', name: 'HIPAA', enabled: true, scope: 's', controls: [
    { id: 'x"><img src=x onerror=alert(1)>', label: 'Access <b>control</b>', ready: false, evidence: 'ev', gap: 'Turn on MFA', manual: true },
    { id: 'b', label: 'Backups', ready: null, evidence: 'ev2', gap: 'Test a restore' }, { id: 'c', label: 'Logging', ready: true, evidence: 'ev3', gap: 'never shown' }] }] };
const render = ({ role = 'admin', sel = null, gapsOnly = false } = {}) => {
  const modal = { innerHTML: '' };
  const ctx = { document: { querySelector: () => modal, getElementById: () => null }, currentUser: { role }, complianceData: null, modal };
  const esc = html.match(/^function esc\(.*$/m)[0], escAttr = html.match(/^function escAttr\(.*$/m)[0];
  vm.runInNewContext(`${esc}\n${escAttr}\n${between('let _cmpSel = null', 'function renderComplianceModal(')}\n${block('renderComplianceModal')}\n_cmpSel = ${JSON.stringify(sel)}; _cmpGapsOnly = ${gapsOnly}; renderComplianceModal(${JSON.stringify(DATA)});`, ctx);
  return modal.innerHTML;
};

test('opens on the first framework that is switched ON, not merely the first', () => expect(render()).toMatch(/<h3>HIPAA<\/h3>/));
test('every state is said in a word, with an icon: never colour alone', () => {
  const out = render();
  for (const w of ['Ready', 'Partly', 'Gap']) expect(out).toMatch(new RegExp(`<span class="cmp-state (ok|partial|no)"><svg[\\s\\S]*?</svg>${w}</span>`));
});
test('what is missing is shown for anything not ready, and only for those', () => {
  const out = render();
  expect(out).toContain('Turn on MFA'); expect(out).toContain('Test a restore'); expect(out).not.toContain('never shown');
});
test('"only what is not ready" hides the ready ones and says how many are left', () => {
  const out = render({ gapsOnly: true });
  expect(out).not.toContain('Logging'); expect(out).toContain('Backups'); expect(out).toContain('(2)');
});
test("a control's id never becomes script: it travels in a data attribute, escaped", () => {
  const out = render();
  expect(out).not.toContain('<img src=x'); expect(out).not.toContain('<b>control</b>');
  expect(out).toMatch(/data-control="x&quot;&gt;&lt;img[^"]*" data-met="1" onclick="attestControl\(this\.dataset\.control, this\.dataset\.met === '1'\)"/);
  expect(block('renderComplianceModal')).not.toMatch(/attestControl\('\$\{/);
});
test('someone who is not an admin can read it but is offered nothing they cannot do', () => {
  const out = render({ role: 'contributor' });
  expect(out).not.toContain('Mark as met'); expect(out).not.toContain('Run live checks'); expect(out).toContain('Control report');
});
test('there is always a way out that a phone can reach', () => expect(render()).toMatch(/class="cmp-x" aria-label="Close"/));
test('nothing in the window is set smaller than 12px, and reading text is 14px or more', () => {
  const css = between('.cmp-modal {', '.cmp-toggle-inline');
  const sizes = [...css.matchAll(/(?:font:[^;]*?|font-size:\s*)(\d+)px/g)].map(m => Number(m[1]));
  expect(Math.min(...sizes)).toBeGreaterThanOrEqual(12);
  for (const sel of ['.cmp-check-ev', '.cmp-check-gap', '.cmp-scope', '.cmp-att-btn']) { const rule = css.match(new RegExp(`\\${sel} \\{([^}]*)\\}`))[1]; expect(Number(rule.match(/(?:font:[^;]*?|font-size:\s*)(\d+)px/)[1])).toBeGreaterThanOrEqual(14); }
});
test('Admin: a framework is a full-width row that opens the window on ITSELF, not a squeezed card of controls', () => {
  const admin = block('complianceHtml');
  expect(admin).toContain('_cmpSel = this.dataset.fw'); expect(admin).not.toContain('compliance-control-row'); expect(admin).not.toContain('<details');
});

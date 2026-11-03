'use strict';
// Reports on any basis, inside the existing Compliance window and Admin tab: a download
// for any tracked framework, past reports under it, and the schedule in the Advanced fold.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const html = fs.readFileSync(path.join(__dirname, '../../../index.html'), 'utf8');
const block = (name) => { const s = html.search(new RegExp(`\\n(?:async )?function ${name}\\(`)); if (s < 0) throw new Error(`${name} not found`); let d = 0; const i = html.indexOf('{', s); for (let j = i; ; j++) { if (html[j] === '{') d++; else if (html[j] === '}' && --d === 0) return html.slice(s, j + 1); } };
const between = (a, b) => html.slice(html.indexOf(a), html.indexOf(b));

const REPORTS = [
  { id: '7', framework: 'hipaa', generated_at: '2026-11-01T06:00:00Z', generated_by: 'schedule', status: 'to do', ready: 5, total: 8, file_name: 'clinic-hipaa-report-2026-11-01.html' },
  { id: '3', framework: 'soc2', generated_at: '2026-10-02T15:00:00Z', generated_by: 'ann@x.com', status: 'ready', ready: 4, total: 4, file_name: 'clinic-soc2-report-2026-10-02.html' },
];
const data = ({ enabled = ['hipaa'], reports = REPORTS, schedule = { schedule: 'monthly', email: 'owner@x.com', lastRun: 1793160000000 } } = {}) => ({
  disclaimer: 'd', probes: {}, reports, reportSchedule: schedule,
  frameworks: [
    { id: 'soc2', name: 'SOC 2', short: 'SOC 2', enabled: enabled.includes('soc2'), scope: 's', controls: [{ id: 'a', label: 'A', ready: true, evidence: 'e' }] },
    { id: 'hipaa', name: 'HIPAA', short: 'HIPAA', enabled: enabled.includes('hipaa'), scope: 's', controls: [{ id: 'b', label: 'B', ready: false, evidence: 'e', gap: 'g' }] },
  ],
});
const render = (d, { role = 'admin' } = {}) => {
  const modal = { innerHTML: '', classList: { toggle() {} } };
  const ctx = { document: { querySelector: () => modal, getElementById: () => null }, currentUser: { role }, complianceData: null, modal };
  const esc = html.match(/^function esc\(.*$/m)[0], escAttr = html.match(/^function escAttr\(.*$/m)[0];
  vm.runInNewContext(`${esc}\n${escAttr}\n${between('let _cmpSel = null', 'function renderComplianceModal(')}\n${block('renderComplianceModal')}\nrenderComplianceModal(${JSON.stringify(d)});`, ctx);
  return modal.innerHTML;
};

describe('one tracked framework', () => {
  test('the download names the framework and keeps the report; past reports sit under it', () => {
    const out = render(data());
    expect(out).toMatch(/data-fw="hipaa" onclick="downloadComplianceReport\(this, this\.dataset\.fw\)">Download your HIPAA packet</);
    expect(out).toContain('<h4 class="cmp-h4">Past reports</h4>');
    expect(out).toContain('Ran on schedule · 3 to do');
    expect(out).toContain('Downloaded by ann@x.com · Ready');
    expect(out).toMatch(/data-id="7" onclick="downloadPastReport\(this, this\.dataset\.id\)"/);
    expect(out.indexOf('Past reports')).toBeGreaterThan(out.indexOf('Download your HIPAA packet'));
  });
  test('the schedule lives in the Advanced fold, as a sentence with two fields', () => {
    const out = render(data());
    const adv = out.slice(out.indexOf('<details class="cmp-adv"'));
    expect(adv).toContain('Run a report every:');
    expect(adv).toMatch(/<option value="monthly" selected>Month<\/option>/);
    expect(adv).toContain('send it to:');
    expect(adv).toContain('value="owner@x.com"');
    expect(adv).toContain('saveComplianceReportSchedule(this)');
    expect(out.slice(0, out.indexOf('<details'))).not.toContain('Run a report every');
  });
  test('says when there is nothing yet', () => {
    expect(render(data({ reports: [] }))).toContain('None yet. Each download is kept here.');
  });
});

describe('two tracked frameworks', () => {
  test('a Reports area with a picker of the tracked frameworks and the same list', () => {
    const out = render(data({ enabled: ['hipaa', 'soc2'] }));
    expect(out).toContain('cmp-overall');
    expect(out).toContain('<details class="cmp-adv cmp-reports-fold"');
    expect(out).toMatch(/<select id="cmp-report-fw"><option value="soc2">SOC 2<\/option><option value="hipaa">HIPAA<\/option><\/select>/);
    expect(out).toContain("downloadComplianceReport(this, document.getElementById('cmp-report-fw').value)");
    expect(out).toContain('Past reports');
    expect(out).toContain('Run a report every:');
  });
});

test('someone who is not an admin sees the list but no download or schedule', () => {
  const out = render(data(), { role: 'contributor' });
  expect(out).toContain('Past reports');
  expect(out).not.toContain('downloadPastReport');
  expect(out).not.toContain('Run a report every');
});

test('Admin › Compliance shows the schedule and last run beside the cards, and no new panel', () => {
  const ctx = {};
  const esc = html.match(/^function esc\(.*$/m)[0], escAttr = html.match(/^function escAttr\(.*$/m)[0];
  vm.runInNewContext(`${esc}\n${escAttr}\n${block('cmpBar')}\n${block('cmpScheduleLine')}\n${block('complianceHtml')}\nout = complianceHtml(${JSON.stringify(data())}); off = cmpScheduleLine(${JSON.stringify(data({ schedule: { schedule: 'off', email: '' } }))});`, ctx);
  expect(ctx.out).toContain('Reports run every month, sent to owner@x.com (2 kept). Last run ' + new Date(1793160000000).toLocaleDateString() + '.');
  expect(ctx.out.indexOf('cmp-sched-line')).toBeLessThan(ctx.out.indexOf('compliance-grid'));
  expect(ctx.off).toMatch(/^Reports run when you download one/);
  expect(html).not.toMatch(/\['reports', 'Reports'/);   // no new admin tab or settings panel
});

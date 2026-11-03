'use strict';
// Settings › Users & access (index.html): the second-step column, the sign-off button next
// to the list it reviews, and "last reviewed" from the history; and in the compliance
// window, a control's `action` drawn as a button on its row. No browser: the functions are
// lifted out of index.html and run against a stub DOM, as spa/accessList.test.js does.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '../../../index.html'), 'utf8');
const block = (name) => { const s = html.search(new RegExp(`\\n(?:async )?function ${name}\\(`)); if (s < 0) throw new Error(`${name} not found`); let d = 0; const i = html.indexOf('{', s); for (let j = i; ; j++) { if (html[j] === '{') d++; else if (html[j] === '}' && --d === 0) return html.slice(s, j + 1); } };
const line = (re) => { const m = html.match(re); if (!m) throw new Error(`${re} not found`); return m[0]; };
const between = (a, b) => html.slice(html.indexOf(a), html.indexOf(b));

const REVIEW = { generatedAt: '2026-11-03T10:00:00Z', userCount: 3, openLibraries: [], pendingShares: [], users: [
  { email: 'dave@x.com', name: 'Dave', role: 'admin', owns: ['Clients'], libraryAccess: [], folderAccess: [], groups: [], libraries: ['all (admin)'], directShares: 0, lastActivity: null, mfa: 'enrolled' },
  { email: 'sam@x.com', name: '', role: 'contributor', owns: [], libraryAccess: ['Clients (Read-Write, direct)'], folderAccess: [], groups: [], libraries: [], directShares: 1, lastActivity: '2026-11-01T09:00:00Z', mfa: 'federated' },
  { email: 'lee@x.com', name: '<b>Lee</b>', role: 'viewer', owns: [], libraryAccess: [], folderAccess: [], groups: [], libraries: [], directShares: 0, lastActivity: null, mfa: 'none' },
] };

function sandbox() {
  const ctx = { esc: null, document: { getElementById: () => null } };
  vm.runInNewContext(`${line(/^function esc\(.*$/m)}\n${line(/^function escAttr\(.*$/m)}\n${line(/^function accessWhen\(.*$/m)}\n${between('const AR_MFA = {', 'function renderAccessReview(')}\n${block('renderAccessReview')}\n${block('accessReviewHistoryHtml')}\n${block('accessSettingsHtml')}\nfunction emptyState(t) { return t; }`, ctx);
  return ctx;
}

describe('the users list', () => {
  test('has a second-step column, one plain word per person, warning when there is none', () => {
    const out = sandbox().renderAccessReview(REVIEW);
    expect(out).toMatch(/<th[^>]*>Second step<\/th>/);
    const rows = out.split('<tr>').slice(2);
    expect(rows[0]).toContain('<td><span class="pill ok">Authenticator set up</span></td>');
    expect(rows[1]).toContain('<td><span class="pill ok">Through their identity provider</span></td>');
    expect(rows[2]).toContain('<td><span class="pill warn">None</span></td>');
    expect(out).not.toContain('<b>Lee</b>');
  });
  test('says when the second step could not be checked, and never guesses', () => {
    const out = sandbox().renderAccessReview({ ...REVIEW, mfaError: 'connect ECONNREFUSED', users: REVIEW.users.map(u => ({ ...u, mfa: 'unknown' })) });
    expect(out).toContain('Second step at sign-in could not be checked: connect ECONNREFUSED');
    expect(out).toContain('<span class="pill">Could not check</span>');
  });
  test('the sign-off button sits with the list it reviews, and the last review is said above it', () => {
    const tab = sandbox().accessSettingsHtml();
    expect(tab).toContain('onclick="recordAccessReview()">Record that this list was reviewed</button>');
    expect(tab.indexOf('recordAccessReview()')).toBeLessThan(tab.indexOf('id="access-review"'));
    expect(tab).toContain('id="access-review-last"');
    const s = sandbox();
    expect(s.accessReviewHistoryHtml([])).toMatch(/No review has been recorded yet/);
    const out = s.accessReviewHistoryHtml([
      { reviewed_at: '2026-11-03T10:00:00Z', reviewed_by_email: 'dave@x.com', user_count: 3, note: 'Removed <a leaver>' },
      { reviewed_at: '2026-08-01T10:00:00Z', reviewed_by_email: 'dave@x.com', user_count: 4, note: null }]);
    expect(out).toMatch(/^Last reviewed .* by dave@x\.com \(3 people on the list\) · Removed &lt;a leaver&gt;\./);
    expect(out).toContain('<summary>Earlier reviews</summary>');
  });
  test('recording asks for an optional note, posts it, and refreshes the history and the compliance light', () => {
    const fn = block('recordAccessReview');
    expect(fn).toContain("apiPost('/admin/access-review/signoff', { note: note || '' })");
    expect(fn).toContain('if (note === null) return;');
    expect(fn).toContain('loadAccessReviewHistory();');
    expect(fn).toContain('loadComplianceSummary();');
    expect(block('loadAccessReview')).toContain('loadAccessReviewHistory();');
  });
  test('the activity feed has words for the sign-in events and shows no "(deleted file)" for them', () => {
    const labels = between('const ACTIVITY_LABELS = {', 'function activityLabel(');
    for (const w of ["signed_in: 'Signed in'", "sign_in_failed: 'Sign-in failed'", "signed_out: 'Signed out'", "access_reviewed: 'Access list reviewed'"]) expect(labels).toContain(w);
    expect(block('loadActivity')).toContain("e.document_id ? '<em>(deleted file)</em>' : '<span class=\"cell-empty\">—</span>'");
  });
});

describe('a control with an action, in the compliance window', () => {
  const CONTROL = { id: 'access_review', label: 'Who has access is reviewed every quarter', ready: false, evidence: 'No review has been recorded yet.', gap: 'Look through the list', why: 'w', action: { label: 'Record that this list was reviewed', api: '/admin/access-review/signoff' } };
  const render = (role, controls) => {
    const modal = { innerHTML: '', classList: { toggle() {} } };
    const ctx = { document: { querySelector: () => modal, getElementById: () => null }, currentUser: { role }, complianceData: null, modal };
    vm.runInNewContext(`${line(/^function esc\(.*$/m)}\n${line(/^function escAttr\(.*$/m)}\n${between('let _cmpSel = null', 'function renderComplianceModal(')}\n${block('renderComplianceModal')}\nrenderComplianceModal(${JSON.stringify({ frameworks: [{ id: 'soc2', name: 'SOC 2', enabled: true, controls }, { id: 'hipaa', name: 'HIPAA', enabled: true, controls: [] }] })});`, ctx);
    return modal.innerHTML;
  };
  test('an admin gets the button on the row, its api and label in data attributes, never spliced into the handler', () => {
    const out = render('admin', [CONTROL, { ...CONTROL, id: 'done', ready: true, evidence: 'Last reviewed November 3, 2026 by dave@x.com.' }]);
    expect(out).toMatch(/data-api="\/admin\/access-review\/signoff" data-label="Record that this list was reviewed" onclick="cmpAction\(this\.dataset\.api, this\.dataset\.label\)">Record that this list was reviewed<\/button>/);
    expect(out).toContain('Last reviewed November 3, 2026 by dave@x.com.');
    // on the ready row too: a review is recorded again next quarter from the same place
    expect(out.match(/onclick="cmpAction\(/g)).toHaveLength(2);
    expect(block('cmpActionBtn')).not.toMatch(/cmpAction\('\$\{/);
  });
  test('someone who is not an admin sees the row without the button', () => {
    const out = render('viewer', [CONTROL]);
    expect(out).toContain('Who has access is reviewed every quarter');
    expect(out).not.toContain('cmpAction(');
  });
  test('the simple view draws it on a To do row as well', () => {
    expect(block('cmpSimpleHtml')).toContain('${cmpActionBtn(c, isAdmin)}');
  });
  test('the action posts with an optional note and redraws the window from the server', () => {
    const fn = block('cmpAction');
    expect(fn).toContain("apiPost(api, { note: note || '' })");
    expect(fn).toContain("renderComplianceModal(data)");
    expect(fn).toContain('loadAccessReviewHistory();');
  });
});

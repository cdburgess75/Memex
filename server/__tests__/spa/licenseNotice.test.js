'use strict';
// The license banner administrators see (index.html): its wording per state, the
// dismiss key, the update modal's license line, and that the banner is drawn
// whenever the status is loaded.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const html = fs.readFileSync(path.join(__dirname, '../../../index.html'), 'utf8');
const fnText = (name) => {
  const start = html.search(new RegExp(`^(async )?function ${name}\\(`, 'm'));
  if (start < 0) throw new Error(`${name} not found in index.html`);
  return html.slice(start, html.indexOf('\n}\n', start) + 3);
};
const load = (names, over = {}) => { const ctx = { String, Number, Object, ...over }; vm.runInNewContext(['esc', 'escAttr', ...names].map(fnText).join('\n'), ctx); return ctx; };

const c = load(['licenseProblem', 'licenseNoticeText', 'licenseNoticeKey', 'licenseSummary', 'showAccountRefused'], { DEPOT_MARK: '<svg></svg>', signOut: () => {}, document: { documentElement: { classList: { remove() {} } }, getElementById: () => null, body: { insertAdjacentHTML() {} } } });
const v2 = (over = {}) => ({ configured: true, present: true, valid: true, accepted: true, version: 2, state: 'ok', stateReason: 'ok', customer: 'Acme Corp', plan: 'care', type: 'standard', expires: '2027-01-01', updatesUntil: '2027-01-01', graceEnds: '2027-01-31T23:59:59.999Z', daysLeft: 200, updatesEntitled: true, seats: { licensed: 25, used: 12 }, ...over });

describe('the banner text', () => {
  test('counts down to the end of the term', () => {
    expect(c.licenseNoticeText(v2({ state: 'expiring', daysLeft: 12 }))).toBe("Depot's license term ends in 12 days (2027-01-01). Renew to keep updates and new accounts.");
    expect(c.licenseNoticeText(v2({ state: 'expiring', daysLeft: 1 }))).toContain('ends in 1 day (');
    expect(c.licenseNoticeText(v2({ state: 'expiring', daysLeft: 0 }))).toContain('ends today (');
  });
  test('names the dates for a lapsed term and an ended grace period', () => {
    expect(c.licenseNoticeText(v2({ state: 'lapsed' }))).toBe("Depot's license term ended 2027-01-01. Renew before 2027-01-31.");
    expect(c.licenseNoticeText(v2({ state: 'readonly' }))).toBe('Depot is read-only: the license grace period ended 2027-01-31. Renew the license.');
  });
  test('says what is wrong with an unaccepted license', () => {
    expect(c.licenseNoticeText({ state: 'unlicensed', stateReason: 'domain_mismatch' })).toBe("Depot has no valid license on this server. The license was issued for a different address than this server's.");
    expect(c.licenseNoticeText({ state: 'unlicensed', stateReason: 'no_license' })).toContain('No license file is installed');
    expect(c.licenseNoticeText({ state: 'unlicensed', stateReason: 'whatever' })).toContain('signature is not valid');
  });
  test('says nothing in good standing', () => {
    expect(c.licenseNoticeText(v2())).toBe('');
  });
  test('escapes what came from the server', () => {
    expect(c.licenseNoticeText(v2({ state: 'expiring', daysLeft: 3, expires: '<b>x</b>' }))).toContain('&lt;b&gt;x&lt;/b&gt;');
  });
  test('the dismiss key changes with the state, the reason and the day', () => {
    expect(c.licenseNoticeKey(v2({ state: 'expiring', daysLeft: 12 }))).toBe('expiring:ok:12');
    expect(c.licenseNoticeKey({ state: 'unlicensed', stateReason: 'no_license', daysLeft: null })).toBe('unlicensed:no_license:');
    expect(c.licenseNoticeKey(null)).toBe('');
  });
});

describe('the update modal line', () => {
  test('describes a version 2 license in good standing', () => {
    expect(c.licenseSummary(v2())).toBe('Licensed to Acme Corp · care · term through 2027-01-01 · updates through 2027-01-01 · 12 of 25 seats.');
  });
  test('adds what needs doing', () => {
    expect(c.licenseSummary(v2({ state: 'expiring', daysLeft: 12 }))).toMatch(/ The term ends in 12 days\.$/);
    expect(c.licenseSummary(v2({ state: 'lapsed', updatesEntitled: false }))).toMatch(/term ended 2027-01-01 .* New accounts and updates are off; read-only from 2027-01-31 unless renewed\.$/);
    expect(c.licenseSummary(v2({ state: 'readonly', updatesEntitled: false }))).toMatch(/ This server is read-only until the license is renewed\.$/);
    expect(c.licenseSummary(v2({ type: 'trial' }))).toContain(' · trial · ');
  });
  test('explains an unaccepted license and keeps the version 1 wording', () => {
    expect(c.licenseSummary(v2({ valid: true, accepted: false, stateReason: 'serial_regressed' }))).toBe('The license is older than one this server has already seen.');
    expect(c.licenseSummary({ configured: true, present: true, valid: true, version: 1, customer: 'Acme', plan: 'care', updatesUntil: '2027-07-12', updatesEntitled: true })).toBe('Licensed to Acme · care · updates through 2027-07-12.');
    expect(c.licenseSummary({ configured: false })).toBe('No license is configured on this server.');
  });
});

describe('wiring', () => {
  test('loading the status draws the banner: everything for administrators, read-only for everyone else', () => {
    const load = fnText('loadLicenseStatus');
    expect(load).toContain('licenseNoticeRefresh();');
    expect(load).not.toContain("role !== 'admin'");                       // fetched for everyone now
    const refresh = fnText('licenseNoticeRefresh');
    expect(refresh).toContain("isAdmin ? !['expiring', 'lapsed', 'readonly', 'unlicensed'].includes(lic.state) : !lic.readOnly");
    expect(refresh).toContain('isAdmin ? licenseNoticeText(lic) : LICENSE_READONLY_NOTICE');
    expect(refresh).toContain("const details = isAdmin ? '<button class=\"run-btn\" type=\"button\" onclick=\"openSettingsAt(\\'license\\')\">Details</button>' : ''"); // straight to Settings > License
    expect(refresh).toContain('onclick="dismissLicenseNotice()"');
    expect(refresh).toContain('role="status"');
    expect(html).toContain("const LICENSE_READONLY_NOTICE = 'Depot is read-only until its license is renewed. You can still view and download files.';");
    expect(fnText('openUpdateModal')).toContain('licenseNoticeRefresh();');
  });
  test('a refused sign-in is explained on the sign-in card, and only for the codes that mean it', () => {
    const refused = (status, code, message) => c.showAccountRefused({ status, body: { code }, message });
    expect(refused(403, 'ACCOUNT_DISABLED', 'off')).toBe(true);
    expect(refused(403, 'LICENSE_SEAT_FREEZE', 'no seat')).toBe(true);
    expect(refused(403, 'SEAT_LIMIT', 'full')).toBe(true);
    expect(refused(403, 'SOMETHING_ELSE', 'x')).toBe(false);
    expect(refused(500, 'SEAT_LIMIT', 'x')).toBe(false);
    expect(c.showAccountRefused(null)).toBe(false);
    expect(fnText('_afterLogin')).toContain("catch (e) { if (showAccountRefused(e)) return; throw e; }");
    const fn = fnText('showAccountRefused');
    expect(fn).toContain('${esc(e.message || \'\')}');
    expect(fn).toContain('onclick="signOut()"');
  });
});

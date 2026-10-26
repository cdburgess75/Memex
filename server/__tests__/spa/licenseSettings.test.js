'use strict';
// Settings > License (index.html): only administrators see it, it shows what the
// server is licensed for, and installing a renewal posts it to POST /api/license and
// says plainly why one was refused.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const html = fs.readFileSync(path.join(__dirname, '../../../index.html'), 'utf8');
const fnText = (name) => {
  const start = html.search(new RegExp(`^(async )?function ${name}\\(`, 'm'));
  if (start < 0) throw new Error(`${name} not found in index.html`);
  return html.slice(start, html.indexOf('\n}\n', start) + 3);
};
const constText = (name) => { const m = html.match(new RegExp(`^const ${name} = \\{[\\s\\S]*?^\\};`, 'm')); if (!m) throw new Error(`${name} not found`); return m[0]; };
const load = (names, over = {}) => {
  const ctx = { String, Number, Object, ...over };
  vm.runInNewContext([constText('LICENSE_REFUSALS'), ...['esc', 'escAttr', ...names].map(fnText)].join('\n') + '\nthis.LICENSE_REFUSALS = LICENSE_REFUSALS;', ctx);
  return ctx;
};
const v2 = (over = {}) => ({ configured: true, present: true, valid: true, accepted: true, version: 2, state: 'ok', stateReason: 'ok', customer: 'Acme Corp', serial: 'acme-0004', domain: 'docs.acme.com', plan: 'care', type: 'standard', expires: '2027-01-01', updatesUntil: '2027-01-01', graceEnds: '2027-01-31T23:59:59.999Z', daysLeft: 200, updatesEntitled: true, seats: { licensed: 25, used: 12 }, features: ['updates', 'editor', 'api'], source: 'upload', ...over });

describe('the tab', () => {
  test('sits in the Server group, for administrators only', () => {
    const list = (role) => load(['settingsTabsList'], { currentUser: { role } }).settingsTabsList().map(t => t.id).filter(Boolean);
    expect(list('admin')).toEqual(expect.arrayContaining(['storage', 'server', 'license', 'activity']));
    expect(list('admin').indexOf('license')).toBe(list('admin').indexOf('server') + 1);
    expect(list('contributor')).not.toContain('license');
    expect(list('viewer')).not.toContain('license');
  });
  test('is drawn and loaded by switchSettingsTab, and only for an administrator', () => {
    expect(fnText('switchSettingsTab')).toContain("else if (tab === 'license' && admin) { body.innerHTML = licenseSettingsHtml(licenseStatus); loadLicenseSettings(); }");
  });
  test('the Software update window links to it', () => {
    expect(fnText('renderUpdateModal')).toContain("openSettingsAt('license')");
  });
});

describe('what it shows', () => {
  const c = load(['licenseProblem', 'licenseSummary', 'licenseFactsHtml', 'licenseSettingsHtml']);
  test('the facts of a version 2 license, in words', () => {
    const out = c.licenseFactsHtml(v2());
    for (const want of ['<dt>Licensed to</dt><dd>Acme Corp</dd>', '<dt>Serial</dt><dd>acme-0004</dd>', '<dt>Issued for</dt><dd>docs.acme.com</dd>', '<dt>Term</dt><dd>through 2027-01-01</dd>', '<dt>Seats</dt><dd>12 of 25 in use</dd>', '<dt>Includes</dt><dd>updates, in-browser editing, the API</dd>', '<dt>Installed</dt><dd>here, in Settings</dd>']) expect(out).toContain(want);
  });
  test('an ended term names the read-only day; unlimited seats and an unbound license say so', () => {
    const out = c.licenseFactsHtml(v2({ state: 'lapsed', seats: { licensed: null, used: 40 }, domain: '*', source: 'file' }));
    expect(out).toContain('<dd>ended 2027-01-01; read-only from 2027-01-31</dd>');
    expect(c.licenseFactsHtml(v2({ state: 'readonly' }))).toContain('<dd>ended 2027-01-01; read-only since 2027-01-31</dd>');
    expect(c.licenseFactsHtml(v2({ expires: null }))).toContain('<dt>Term</dt><dd>no end date</dd>');
    expect(out).toContain('<dd>40 in use, no limit</dd>');
    expect(out).toContain('<dd>any address</dd>');
    expect(out).toContain('<dd>with the server</dd>');
  });
  test('nothing to list without a version 2 license', () => {
    expect(c.licenseFactsHtml(null)).toBe('');
    expect(c.licenseFactsHtml({ present: false })).toBe('');
    expect(c.licenseFactsHtml(v2({ version: 1 }))).toBe('');
  });
  test('escapes what came from the server', () => {
    expect(c.licenseFactsHtml(v2({ customer: '<img src=x onerror=alert(1)>' }))).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
  test('the page has a labelled paste box, a file picker, an install button and a live result line', () => {
    const page = c.licenseSettingsHtml(v2({ readOnly: true, state: 'readonly' }));
    expect(page).toContain('<label for="license-paste">');
    expect(page).toContain('id="license-file" accept=".json');
    expect(page).toContain('onclick="installLicense()"');
    expect(page).toMatch(/id="license-install-result" role="status" aria-live="polite"/);
    expect(page).toContain('security-status-card danger');
  });
});

describe('a refusal, in plain words', () => {
  const c = load(['licenseProblem', 'licenseRefusal']);
  test.each([
    ['not_a_license', 'That is not a license file.'],
    ['not_v2', 'older kind of license'],
    ['no_public_key', 'trusts no license key'],
    ['domain_mismatch', "This license was issued for a different address than this server's."],
    ['serial_regressed', 'This license is older than one this server has already seen.'],
    ['serial_mismatch', 'This license belongs to a different installation.'],
    ['unknown_kid', 'This license was signed with a key this server does not trust.'],
    ['bad_signature', 'This license signature is not valid.'],
  ])('%s', (reason, words) => expect(c.licenseRefusal(reason)).toContain(words));
});

describe('installing', () => {
  const page = () => {
    const els = {
      'license-paste': { value: '', focus: jest.fn() },
      'license-install-result': { textContent: '' },
      'license-install-btn': { disabled: false },
    };
    return els;
  };
  const run = async (els, apiPost) => {
    const calls = { toast: [], refreshed: 0 };
    const c = load(['licenseProblem', 'licenseRefusal', 'installLicense'], {
      document: { getElementById: (id) => els[id] || null },
      apiPost, toast: (m) => calls.toast.push(m), licenseNoticeRefresh: () => calls.refreshed++, updateCtaRefresh() {}, loadLicenseSettings() {},
      latestUpdateInfo: null, licenseStatus: null, sessionStorage: { removeItem() {} },
    });
    await c.installLicense();
    return { c, calls };
  };
  test('posts what was pasted, clears the box and says it is in use', async () => {
    const els = page(); els['license-paste'].value = '  {"payload":{}}  ';
    const apiPost = jest.fn(async () => v2());
    const { c, calls } = await run(els, apiPost);
    expect(apiPost).toHaveBeenCalledWith('/license', { license: '{"payload":{}}' });
    expect(els['license-paste'].value).toBe('');
    expect(els['license-install-result'].textContent).toBe('Installed. acme-0004 is now in use, term through 2027-01-01.');
    expect(c.licenseStatus).toMatchObject({ serial: 'acme-0004' });
    expect(calls).toMatchObject({ toast: ['License installed'], refreshed: 1 });
    expect(els['license-install-btn'].disabled).toBe(false);
  });
  test('a refusal keeps the text and says why', async () => {
    const els = page(); els['license-paste'].value = 'x';
    const err = Object.assign(new Error('That license cannot be installed on this server.'), { body: { code: 'LICENSE_REFUSED', reason: 'domain_mismatch' } });
    const { calls } = await run(els, jest.fn(async () => { throw err; }));
    expect(els['license-paste'].value).toBe('x');
    expect(els['license-install-result'].textContent).toContain('different address');
    expect(calls.toast).toEqual([]);
  });
  test('nothing pasted asks for the file and sends nothing', async () => {
    const els = page();
    const apiPost = jest.fn();
    await run(els, apiPost);
    expect(apiPost).not.toHaveBeenCalled();
    expect(els['license-install-result'].textContent).toContain('Choose the license file');
    expect(els['license-paste'].focus).toHaveBeenCalled();
  });
});

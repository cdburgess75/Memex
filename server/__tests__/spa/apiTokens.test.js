'use strict';
// Settings › You › API tokens (index.html): who gets the tab, what the screen shows, the
// one-time reveal of a new token, and the administrator's list under Users & access.
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
const ctxFor = (over = {}) => {
  const body = { innerHTML: '' };
  const ctx = { currentUser: { role: 'contributor' }, apiTokensList: [], apiTokenJustMade: null, document: { getElementById: (id) => id === 'api-tokens-body' ? body : null }, body, ...over };
  vm.runInNewContext(['esc', 'escAttr', 'settingsTabsList', 'tokensSettingsHtml', 'apiTokenWhen', 'apiTokenScopeText', 'apiTokenRowHtml', 'renderApiTokens', 'accessSettingsHtml', 'emptyState'].map(fnText).join('\n'), ctx);
  return ctx;
};
const token = { id: '11111111-1111-4111-8111-111111111111', name: 'Nightly report', prefix: 'depot_abcdef', scope: 'read', created_at: '2026-10-12T10:00:00Z', expires_at: '2027-10-12T10:00:00Z', last_used_at: null, revoked_at: null };

describe('the tab', () => {
  test('contributors and admins get API tokens under You; viewers do not', () => {
    const ids = (role) => ctxFor({ currentUser: { role } }).settingsTabsList().filter(t => t.id).map(t => t.id);
    expect(ids('contributor')).toEqual(['profile', 'notifications', 'groups', 'tokens']);
    expect(ids('admin')).toContain('tokens');
    expect(ids('viewer')).not.toContain('tokens');
    expect(fnText('switchSettingsTab')).toContain("else if (tab === 'tokens' && currentUser?.role !== 'viewer') { body.innerHTML = tokensSettingsHtml(); loadApiTokens(); }");
  });
  test('the intro says what a token can do, links the reference, and offers admin scope only to an admin', () => {
    const c = ctxFor().tokensSettingsHtml();
    expect(c).toContain('href="/api/docs"');
    expect(c).toMatch(/read only.*read and write/);
    expect(c).not.toContain('<strong>admin</strong>');
    expect(ctxFor({ currentUser: { role: 'admin' } }).tokensSettingsHtml()).toContain('<strong>admin</strong> also does what the Admin page does');
  });
});

describe('the screen', () => {
  test('the form names every control, defaults to read only and one year, and admin scope is for admins', () => {
    const c = ctxFor(); c.renderApiTokens();
    const out = c.body.innerHTML;
    expect(out).toMatch(/<input type="text" id="token-new-name" maxlength="80"[^>]*aria-label="Token name"/);
    expect(out).toMatch(/<select id="token-new-scope" aria-label="Scope"><option value="read">Read only<\/option><option value="write">Read and write<\/option><\/select>/);
    expect(out).toMatch(/<option value="365" selected>Expires in 1 year<\/option><option value="">Never expires<\/option>/);
    expect(out).toContain('<button class="run-btn" type="button" onclick="createApiToken()">Create token</button>');
    expect(out).toContain('You have no tokens yet.');
    const a = ctxFor({ currentUser: { role: 'admin' } }); a.renderApiTokens();
    expect(a.body.innerHTML).toContain('<option value="admin">Admin</option>');
  });
  test('a row says the scope in words, the prefix, when it was made, used and expires, and can be revoked', () => {
    const c = ctxFor({ apiTokensList: [token, { ...token, id: '22222222-2222-4222-8222-222222222222', name: 'Old <importer>', scope: 'write', expires_at: '2020-01-01T00:00:00Z', last_used_at: '2026-10-11T09:00:00Z' }] });
    c.renderApiTokens();
    const out = c.body.innerHTML;
    expect(out).toContain('<div class="conn-name">Nightly report</div>');
    expect(out).toMatch(/read only · depot_abcdef… · made [A-Z][a-z]{2} \d{1,2}, 2026 · never used · expires [A-Z][a-z]{2} \d{1,2}, 2027/);
    expect(out).toContain('Old &lt;importer&gt;');
    expect(out).toMatch(/read and write · depot_abcdef… · made .* · last used .* · <strong>expired<\/strong>/);
    expect(out).toContain(`<button class="ghost-btn" type="button" data-tid="${token.id}" onclick="revokeApiToken(this.dataset.tid)">Revoke</button>`);
  });
  test('a token just made is shown once, with Copy and Done, above the form', () => {
    const shown = 'depot_' + 'abcdef0123456789'.repeat(3).slice(0, 43); // built here, so nothing token-shaped sits in the file
    const c = ctxFor({ apiTokensList: [token], apiTokenJustMade: { ...token, token: shown } });
    c.renderApiTokens();
    const out = c.body.innerHTML;
    expect(out).toMatch(/^<div class="token-reveal" role="status">/);
    expect(out).toContain('Your new token, "Nightly report"');
    expect(out).toContain('Depot does not keep it and cannot show it again.');
    expect(out).toContain(`<code id="token-reveal-value">${shown}</code>`);
    expect(out).toContain(`onclick="copyText(document.getElementById('token-reveal-value').textContent)">Copy</button>`);
    expect(out).toContain('onclick="apiTokenJustMade = null; renderApiTokens()">Done</button>');
    expect(out.indexOf('token-reveal')).toBeLessThan(out.indexOf('token-create'));
    expect(css).toMatch(/\.token-reveal-row code \{[^}]*user-select: all;/);
  });
  test('revoking asks first, as a destructive action, and the create path sends the expiry only when there is one', () => {
    const revoke = fnText('revokeApiToken');
    expect(revoke).toMatch(/askConfirm\(`Revoke "\$\{t\.name\}"\? Anything still using it stops working at once\.`, \{ okLabel: 'Revoke', danger: true/);
    expect(revoke).toContain("apiDelete(`/tokens/${encodeURIComponent(id)}`)");
    const create = fnText('createApiToken');
    expect(create).toContain("apiPost('/tokens', { name, scope, ...(days ? { expires_in_days: Number(days) } : {}) })");
    expect(create).toContain('apiTokenJustMade = made;');
  });
});

describe('the administrator', () => {
  test('Users & access lists every live token with its owner, and revokes through the admin route', () => {
    const c = ctxFor({ currentUser: { role: 'admin' } });
    expect(c.accessSettingsHtml()).toContain('<div id="admin-tokens">');
    expect(fnText('switchSettingsTab')).toContain("body.innerHTML = accessSettingsHtml(); loadAccessReview(); loadAdminTokens();");
    const row = c.apiTokenRowHtml({ ...token, user_email: 'dave@corp.test' }, { admin: true });
    expect(row).toContain('<div class="conn-name">Nightly report<span class="conn-meta">dave@corp.test</span></div>');
    expect(row).toContain('onclick="revokeAnyApiToken(this.dataset.tid)">Revoke</button>');
    expect(fnText('loadAdminTokens')).toContain("apiGet('/tokens/all')");
    expect(fnText('revokeAnyApiToken')).toContain("apiDelete(`/tokens/all/${encodeURIComponent(id)}`)");
  });
  test('the per-token limit sits with the other limits and is saved with them', () => {
    expect(html).toMatch(/<label for="cfg-api-token-rate">API requests per token \(per 15 minutes\)<\/label>\n\s*<input type="number" id="cfg-api-token-rate" value="\$\{esc\(s\.api_token_rate_limit\|\|'6000'\)\}" min="60"/);
    expect(fnText('saveNetworkSettings')).toContain("api_token_rate_limit: document.getElementById('cfg-api-token-rate')?.value || '6000',");
  });
});

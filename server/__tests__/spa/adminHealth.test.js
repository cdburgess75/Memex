'use strict';
// Admin › Health (index.html): a tab of its own, filled from /admin/health when the Admin page
// opens; the verdict is a word as well as a colour; a window of a day or a week.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const html = fs.readFileSync(path.join(__dirname, '../../../index.html'), 'utf8');
const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
const fnText = (name) => {
  const start = html.search(new RegExp(`^(async )?function ${name}\\(`, 'm'));
  if (start < 0) throw new Error(`${name} not found in index.html`);
  return html.slice(start, html.indexOf('\n}\n', start) + 3);
};

test('the Admin page has a Health tab, second, filled when the page opens', () => {
  const admin = fnText('renderAdmin');
  expect(admin).toContain(`['health', 'Health', '<div id="admin-health"><p class="wdash-empty">Checking…</p></div>']`);
  expect(admin.indexOf("['overview'")).toBeLessThan(admin.indexOf("['health'"));
  expect(admin.indexOf("['health'")).toBeLessThan(admin.indexOf("['people'"));
  expect(admin).toContain("    loadAdminHealth(1);\n  } catch (e) {");
  expect(css).toMatch(/\.health-ok strong \{ color: var\(--success\); \} \.health-attention strong \{ color: var\(--warning\); \} \.health-problem strong \{ color: var\(--danger\); \}/);
});

describe('loadAdminHealth', () => {
  const SUMMARY = {
    status: 'attention', reasons: ['2 requests could not be finished.'], version: 'v2026.10.21.003', uptime_seconds: 93600,
    errors: { count: 2, recent: [{ at: '2026-10-21T10:00:00Z', status: 500, method: 'POST', path: '/api/files/upload-stream', message: 'write EPIPE', actor_email: 'priya@acme.example' }] },
    refusals: { count: 1, by_status: { 413: 1 }, recent: [] },
    signins: { signins: 14, failed: 3, worst_address: ['203.0.113.9', 2], recent_failed: [{ at: '2026-10-21T09:30:00Z', username: 'sam', ip: '203.0.113.9', error: 'invalid_user_credentials' }] },
    activity: { actions: 61, by_type: [{ type: 'uploaded', n: 31 }], active_people: 5 },
    stored: { files: 45, bytes: 199700000000, people: 6, people_active: 6, database_bytes: 412000000 },
    disk: { path: '/data/files', free_bytes: 288000000000, total_bytes: 515000000000 }, license: { state: 'ok' },
  };
  const run = async (answer, days) => {
    const el = { innerHTML: '' };
    const urls = [];
    const ctx = {
      document: { getElementById: (id) => (id === 'admin-health' ? el : null) },
      apiGet: async (u) => { urls.push(u); if (answer instanceof Error) throw answer; return answer; },
      esc: (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
      adminStat: (label, value, sub) => `[${label}=${value}|${sub}]`,
      adminCard: (title, body) => `<section>${title}${body}</section>`,
      fmtBytes: (n) => `${Math.round(n / 2 ** 30)} GB`,
      Number, String, Date, Math, Error, console,
    };
    vm.runInNewContext(`${fnText('fmtUptime')}\n${fnText('loadAdminHealth')}\nthis.load = loadAdminHealth;`, ctx);
    await ctx.load(days);
    return { el, urls };
  };
  test('renders the verdict as a word, the reasons, the six numbers and the four tables', async () => {
    const { el, urls } = await run(SUMMARY, 1);
    expect(urls).toEqual(['/admin/health?days=1']);
    expect(el.innerHTML).toContain('<div class="health-status health-attention" role="status"><strong>Worth a look</strong> · the last 24 hours · version v2026.10.21.003 · up 1 day 2 h<ul class="health-reasons"><li>2 requests could not be finished.</li></ul></div>');
    expect(el.innerHTML).toContain('[Could not finish=2|requests the server failed on]');
    expect(el.innerHTML).toContain('[Failed sign-ins=3|14 signed in]');
    expect(el.innerHTML).toContain('[Disk free=268 GB|of 480 GB on the file store]');
    expect(el.innerHTML).toContain('<td title="sam">sam</td><td title="203.0.113.9">203.0.113.9</td><td title="invalid user credentials">invalid user credentials</td>');
    expect(el.innerHTML).toContain('<td title="POST /api/files/upload-stream">POST /api/files/upload-stream</td><td title="write EPIPE">write EPIPE</td>');
    expect(el.innerHTML).toContain('aria-pressed="true" disabled onclick="loadAdminHealth(1)"');
    expect(el.innerHTML).toContain('onclick="loadAdminHealth(7)">Last 7 days');
  });
  test('a quiet server says so, and sign-ins that are not available say so too', async () => {
    const { el } = await run({ ...SUMMARY, status: 'ok', reasons: [], signins: null, errors: { count: 0, recent: [] }, disk: null }, 7);
    expect(el.innerHTML).toContain('<strong>Fine</strong> · the last 7 days');
    expect(el.innerHTML).toContain('<p>Nothing is wrong that Depot can see.</p>');
    expect(el.innerHTML).toContain('[Failed sign-ins=—|not available]');
    expect(el.innerHTML).toContain("[Disk free=—|files are not on this server's disk]");
    expect(el.innerHTML).toContain('Not available on this server.');
  });
  test('a failed check is said plainly', async () => {
    const { el } = await run(new Error('Internal error'), 1);
    expect(el.innerHTML).toBe('<p class="wdash-empty">Could not check: Internal error</p>');
  });
});

test('new installs keep sign-in records from the first start', () => {
  const realm = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../keycloak/memex-realm.json'), 'utf8'));
  expect(realm.eventsEnabled).toBe(true);
  expect(realm.enabledEventTypes).toEqual(['LOGIN', 'LOGIN_ERROR']);
  expect(realm.eventsExpiration).toBe(2592000);
});

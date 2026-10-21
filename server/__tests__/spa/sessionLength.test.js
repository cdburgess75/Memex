'use strict';
// Settings › Sign-in methods › "How long a sign-in lasts" (index.html): its own settings
// section, loaded from Keycloak when the tab opens, saved through /setup/session-length.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const html = fs.readFileSync(path.join(__dirname, '../../../index.html'), 'utf8');
const fnText = (name) => {
  const start = html.search(new RegExp(`^(async )?function ${name}\\(`, 'm'));
  if (start < 0) throw new Error(`${name} not found in index.html`);
  return html.slice(start, html.indexOf('\n}\n', start) + 3);
};

test('the section exists, with a labelled select and a Save button', () => {
  expect(html).toContain('<div class="settings-sub" style="margin-top:20px">How long a sign-in lasts</div>');
  expect(html).toContain('<label for="cfg-session-hours">Sign in again after</label>');
  expect(html).toContain('<select id="cfg-session-hours" disabled><option value="">Loading…</option></select>');
  expect(html).toContain('onclick="saveSessionLength()"');
  expect(html).toMatch(/sign in again after this long, on every computer and phone/);
});

test('the Sign-in tab renders both sections and loads the current length', () => {
  expect(fnText('switchSettingsTab')).toContain("{ body.innerHTML = systemSections('Sign-in methods', 'How long a sign-in lasts'); loadSessionLength(); }");
});

describe('loadSessionLength', () => {
  const run = async (answer) => {
    const sel = { innerHTML: '', disabled: true };
    const results = [];
    const ctx = {
      document: { getElementById: (id) => (id === 'cfg-session-hours' ? sel : null) },
      apiGet: async () => answer, esc: (s) => String(s),
      _signinResult: (id, ok, msg) => results.push({ id, ok, msg }),
      Number, String, Error, console,
    };
    vm.runInNewContext(`${html.slice(html.indexOf('const SESSION_HOUR_CHOICES'), html.indexOf('\nfunction sessionHoursLabel'))}\n${fnText('sessionHoursLabel')}\n${fnText('loadSessionLength')}\nthis.load = loadSessionLength;`, ctx);
    await ctx.load();
    return { sel, results };
  };
  test('offers the five lengths with the current one selected', async () => {
    const { sel } = await run({ ok: true, hours: 10, idleHours: 10, choices: [10, 24, 168, 336, 720] });
    expect(sel.disabled).toBe(false);
    expect(sel.innerHTML).toBe('<option value="10" selected>10 hours</option><option value="24">1 day</option><option value="168">1 week</option><option value="336">2 weeks</option><option value="720">30 days</option>');
  });
  test('a length set another way is shown as it is, ahead of the list', async () => {
    const { sel } = await run({ ok: true, hours: 48 });
    expect(sel.innerHTML.startsWith('<option value="48" selected>2 days (set in Keycloak)</option><option value="10">10 hours</option>')).toBe(true);
  });
  test('when Keycloak cannot be read, the select says so and the reason is shown', async () => {
    const { sel, results } = await run({ ok: false, error: 'Keycloak realm read failed (502).' });
    expect(sel.innerHTML).toBe('<option value="">Not available</option>');
    expect(results).toEqual([{ id: 'cfg-session-result', ok: false, msg: 'Keycloak realm read failed (502).' }]);
  });
});

test('new installs start at ten hours, idle and maximum alike', () => {
  const realm = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../keycloak/memex-realm.json'), 'utf8'));
  expect(realm.ssoSessionIdleTimeout).toBe(36000);
  expect(realm.ssoSessionMaxLifespan).toBe(36000);
  expect(realm.rememberMe).toBeUndefined();
});

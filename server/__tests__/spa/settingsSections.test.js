'use strict';
// Settings (index.html): who has access has its own section, not a footnote under Activity.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const html = fs.readFileSync(path.join(__dirname, '../../../index.html'), 'utf8');
const fnText = (name) => {
  const start = html.search(new RegExp(`^function ${name}\\(`, 'm'));
  if (start < 0) throw new Error(`${name} not found in index.html`);
  return html.slice(start, html.indexOf('\n}\n', start) + 3);
};

test('admins get a Users & access section in the side list', () => {
  const ctx = { currentUser: { role: 'admin' } };
  vm.runInNewContext(`${fnText('settingsTabsList')}\nthis.tabs = settingsTabsList;`, ctx);
  const ids = ctx.tabs().filter(t => t.id).map(t => t.id);
  expect(ids).toContain('access');
  expect(ids.indexOf('access')).toBeLessThan(ids.indexOf('activity'));
  ctx.currentUser = { role: 'contributor' };
  expect(ctx.tabs().some(t => t.id === 'access')).toBe(false);
});

test('the section holds the access review, and Activity no longer does', () => {
  expect(fnText('accessSettingsHtml')).toContain('id="access-review"');
  expect(fnText('activitySettingsHtml')).not.toContain('access-review');
  const sw = fnText('switchSettingsTab');
  expect(sw).toMatch(/tab === 'access' && admin\) \{ body\.innerHTML = accessSettingsHtml\(\); loadAccessReview\(\); \}/);
  expect(sw).not.toMatch(/activitySettingsHtml\(\); loadActivity\(true\); loadAccessReview/);
});

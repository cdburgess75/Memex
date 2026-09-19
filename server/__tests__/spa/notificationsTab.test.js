'use strict';
// Settings -> Notifications told everyone who was not an admin that email was "coming soon --
// it needs a mail server". It was hard-coded; email had worked for months. The tab now says
// what is true for this workspace and this person.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const html = fs.readFileSync(path.join(__dirname, '../../../index.html'), 'utf8');
const block = (name) => { const s = html.search(new RegExp(`\\nfunction ${name}\\(`)); let d = 0; const i = html.indexOf('{', s); for (let j = i; ; j++) { if (html[j] === '{') d++; else if (html[j] === '}' && --d === 0) return html.slice(s, j + 1); } };
const words = html.slice(html.indexOf('const EMAIL_EVENT_WORDS = ['), html.indexOf('let notifEmail = null;'));
const fnLine = (name) => html.match(new RegExp(`^function ${name}\\(.*$`, 'm'))[0];
const tab = (notifEmail, role = 'contributor') => {
  const ctx = { currentUser: { email: 'dave@ptechllc.com', role } };
  vm.runInNewContext(`${fnLine('esc')}\n${words}\nlet notifEmail = ${JSON.stringify(notifEmail)};\n${block('emailNoticeHtml')}\nthis.out = emailNoticeHtml();`, ctx);
  return ctx.out;
};
const ALL = { share_granted: true, share_opened: true, share_downloaded: true, upload_received: true, document_edited: false };

test('the stale promise is gone from the app', () => expect(html).not.toMatch(/Email delivery[^<]*coming soon/));
test('email set up: says what this person is emailed about, at their address, and who decides', () => {
  const out = tab({ configured: true, events: ALL });
  expect(out).toContain('dave@ptechllc.com');
  expect(out).toContain('someone shares a file, folder or library with you');
  expect(out).toContain('someone opens something you shared');
  expect(out).not.toContain('a file you follow is edited'); // off for this workspace, so not promised
  expect(out).toContain('chosen for the whole workspace by an administrator');
});
test('an admin is pointed at the switches instead', () => expect(tab({ configured: true, events: ALL }, 'admin')).toMatch(/under <a [^>]*data-tab="email"[^>]*>Email<\/a>/));
test('email not set up: says so, and that the bell still works', () => {
  const out = tab({ configured: false, events: ALL });
  expect(out).toMatch(/isn't set up for this workspace yet/);
  expect(out).toContain('bell menu');
  expect(out).not.toContain('<li>');
});
test('everything switched off: does not promise email', () => expect(tab({ configured: true, events: {} })).toMatch(/every email notice is switched off/));
test('could not tell: says that, rather than guessing', () => expect(tab(null)).toMatch(/Couldn't check/));

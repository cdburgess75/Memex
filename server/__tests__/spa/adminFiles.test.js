'use strict';
// Admin's Files tab (index.html): the newest files from the server, a note on how many
// more there are, and search that asks the server. It no longer gets every file.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '../../../index.html'), 'utf8');
const fnText = (name) => {
  const start = html.search(new RegExp(`^function ${name}\\(`, 'm'));
  if (start < 0) throw new Error(`${name} not found in index.html`);
  return html.slice(start, html.indexOf('\n}\n', start) + 3);
};
const ctx = { fmtBytes: (n) => `${n} B` };
vm.runInNewContext(`${fnText('esc')}\n${fnText('escAttr')}\n${fnText('adminFileRows')}\n${fnText('adminFilesNote')}
  this.rows = adminFileRows; this.note = adminFilesNote;`, ctx);

test('Admin asks for the admin file list, not every file', () => {
  const renderAdmin = html.slice(html.indexOf('async function renderAdmin()'), html.indexOf('async function renderAdmin()') + 1200);
  expect(renderAdmin).toContain("apiGet('/admin/files')");
  expect(renderAdmin).not.toContain("apiGet('/files')");
});

test('Home asks for the summary, not every file', () => {
  const start = html.indexOf('async function renderHome()');
  const body = html.slice(start, html.indexOf('\n}\n', start));
  expect(body).toContain("apiGet('/files/summary'");
  expect(body).not.toMatch(/apiGet\('\/files'\)/);
});

test('rows escape names and carry the delete button', () => {
  const out = ctx.rows([{ id: 'a1', name: 'Q1/<b>x</b>.pdf', size: 5, uploaded_by_email: 'p@x.test', created_at: '2026-10-01T00:00:00Z' }]);
  expect(out).toContain('Q1/&lt;b&gt;x&lt;/b&gt;.pdf');
  expect(out).not.toContain('<b>x</b>');
  expect(out).toContain('data-fid="a1"');
  expect(ctx.rows([])).toContain('No files.');
});

test('the note says when there is more than is shown, and what a search found', () => {
  expect(ctx.note({ files: new Array(200), matched: 80848 }, '')).toBe('Showing the newest 200. Search to find any other file.');
  expect(ctx.note({ files: new Array(3), matched: 3 }, '')).toBe('');
  expect(ctx.note({ files: new Array(200), matched: 512 }, 'pdf')).toBe('Showing the newest 200 of 512 matches.');
  expect(ctx.note({ files: [{}], matched: 1 }, 'x')).toBe('1 match.');
  expect(ctx.note({ files: [], matched: 0 }, 'zzz')).toBe('No file matches that.');
  expect(ctx.note(null, '')).toBe("Couldn't load the file list. Refresh the page to try again.");
});

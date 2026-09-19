'use strict';
// Links from share emails (#/open/...). They arrive from OUTSIDE -- an email, a chat, anyone
// who can get you to click -- and each segment is decoded AFTER the split, so it can carry
// anything at all. An id is a UUID and a token is base64url; whatever is not exactly that is
// not a link. The file preview, which builds inline handlers from the id it is given, refuses
// anything else on its own account too.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '../../../index.html'), 'utf8');
const block = (name) => { const s = html.search(new RegExp(`\\n(async )?function ${name}\\(`)); let d = 0; const i = html.indexOf('{', s); for (let j = i; ; j++) { if (html[j] === '{') d++; else if (html[j] === '}' && --d === 0) return html.slice(s, j + 1); } };
const consts = html.match(/^const OPEN_ID = .*$/m)[0] + '\n' + html.match(/^const OPEN_TOKEN = .*$/m)[0];

const ctx = {};
vm.runInNewContext(`${consts}\n${block('hashToNav')}\nObject.assign(this, { hashToNav, OPEN_ID });`, ctx);
const { hashToNav } = ctx;
const ID = '3f2b8c1e-9a4d-4e6f-8b7a-0c1d2e3f4a5b';

describe('what counts as a link', () => {
  test('a file, a library, a folder in a library, a share, a sign-in token', () => {
    expect(hashToNav(`#/open/file/${ID}`).open).toEqual({ file: ID });
    expect(hashToNav(`#/open/lib/${ID}`).open).toEqual({ lib: ID, folder: '' });
    expect(hashToNav(`#/open/lib/${ID}/Clients/Smith%20%26%20Co`).open).toEqual({ lib: ID, folder: 'Clients/Smith & Co' });
    expect(hashToNav(`#/open/share/${ID}`).open).toEqual({ share: ID });
    expect(hashToNav('#/open/link/aB3_-xyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ab').open).toEqual({ link: 'aB3_-xyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ab' });
    expect(hashToNav('#/open/flink/aB3_-xyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ab').open).toEqual({ flink: 'aB3_-xyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ab' });
  });
  test('the ordinary routes are untouched', () => {
    expect(hashToNav('#/files/Clients')).toMatchObject({ view: 'active', folder: 'Clients' });
    expect(hashToNav('#/admin')).toMatchObject({ tab: 'admin' });
  });
  test.each([
    ['markup smuggled in an encoded segment', `#/open/file/${ID}%2Furl%3Fa%3D%22%3E%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E`],
    ['a quote that would close an inline handler', `#/open/file/${ID}')%3Balert(1)%2F%2F`],
    ['a path that walks the API', '#/open/file/..%2F..%2Fadmin%2Fusers'],
    ['a library that is not an id', '#/open/lib/1%20OR%201%3D1'],
    ['a token with anything but base64url in it', '#/open/link/abcdefghijklmnop%22%3E%3Cscript%3E'],
    ['a token too short to be one', '#/open/link/abc'],
    ['a folder-link token with markup in it', '#/open/flink/abcdefghijklmnop%22%3E%3Cscript%3E'],
    ['an unknown kind', `#/open/admin/${ID}`],
    ['nothing after the kind', '#/open/file/'],
  ])('%s is not a link', (_label, hash) => expect(hashToNav(hash)).toBeNull());
});

describe('the file preview', () => {
  // previewFile is too large to lift out whole; its opening lines are what matter: the id
  // is checked BEFORE it is recorded, fetched, or written into the dialog's inline handlers.
  const start = html.indexOf('async function previewFile(fileId, opts = {}) {');
  const head = html.slice(start, html.indexOf("const f = filesList.find", start));
  const run = async (fileId) => {
    const seen = { toast: null, recorded: false };
    const c = { toast: (m) => { seen.toast = m; }, recordOpen: () => { seen.recorded = true; } };
    vm.runInNewContext(`${consts}\n${head}\n return 'went ahead'; }\nthis.previewFile = previewFile;`, c);
    const result = await c.previewFile(fileId); // before the spread: `seen` is filled in by the call
    return { ...seen, result };
  };
  test('never gets as far as its dialog with an id that is not one', async () => {
    expect(await run(`${ID}/url?a="><img src=x onerror=alert(1)>`)).toEqual({ toast: 'That file could not be opened.', recorded: false, result: undefined });
    expect(await run(undefined)).toMatchObject({ recorded: false, result: undefined });
  });
  test('goes ahead for a real id', async () => {
    expect(await run(ID)).toEqual({ toast: null, recorded: true, result: 'went ahead' });
  });
});

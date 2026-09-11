'use strict';
// The app's half of folder scoping (index.html). A folder is a name prefix and the same
// name can exist in several libraries, so every folder request names the library the
// folder is in. No browser here: the two helpers are lifted out of index.html and run
// in a sandbox, and the call sites are checked by reading the source.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '../../../index.html'), 'utf8');

function helpers(currentLibraryId) {
  const src = ['inFolderLib', 'folderLibQuery'].map(name => {
    const m = html.match(new RegExp(`^function ${name}\\(.*$`, 'm'));
    if (!m) throw new Error(`${name} not found in index.html`);
    return m[0];
  }).join('\n');
  const ctx = { currentLibraryId };
  vm.runInNewContext(`${src}\nthis.inFolderLib = inFolderLib; this.folderLibQuery = folderLibQuery;`, ctx);
  return ctx;
}

// The body of `function name(...) { ... }` in index.html, by brace matching.
function body(name) {
  const start = html.search(new RegExp(`(async )?function ${name}\\(`));
  if (start < 0) throw new Error(`${name} not found in index.html`);
  let i = html.indexOf('{', start), depth = 0;
  for (let j = i; j < html.length; j++) {
    if (html[j] === '{') depth++;
    else if (html[j] === '}' && --depth === 0) return html.slice(i, j + 1);
  }
  throw new Error(`unbalanced ${name}`);
}

describe('the helpers', () => {
  const LIB = '3f2b8a1e-0000-4000-8000-000000000001';
  test('add the library being viewed as the SOURCE, leaving library_id (the destination) alone', () => {
    const { inFolderLib } = helpers(LIB);
    expect(inFolderLib({ path: 'Clients', library_id: 'dest' })).toEqual({ path: 'Clients', library_id: 'dest', source_library_id: LIB });
  });
  test('a library passed in wins over the one being viewed now', () => {
    const { inFolderLib, folderLibQuery } = helpers('the-one-switched-to');
    expect(inFolderLib({ path: 'a' }, LIB).source_library_id).toBe(LIB);
    expect(folderLibQuery(LIB)).toBe('&source_library_id=' + LIB);
  });
  test('viewing all libraries sends none, so the server infers it', () => {
    const { inFolderLib, folderLibQuery } = helpers(null);
    expect(inFolderLib({ path: 'a' })).toEqual({ path: 'a' });
    expect(folderLibQuery()).toBe('');
  });
  test('the query form is encoded', () => {
    expect(helpers('a&b=c').folderLibQuery()).toBe('&source_library_id=a%26b%3Dc');
  });
});

describe('every folder request names its library', () => {
  const lines = html.split('\n').map((text, i) => ({ text, n: i + 1 }))
    .filter(({ text }) => /['"`]\/(api\/)?files\/folder\/(rename|delete|reparent|move|copy|links|members|zip)\b/.test(text));

  test('there are folder requests to check', () => expect(lines.length).toBeGreaterThanOrEqual(14));

  test.each(lines.map(l => [l.n, l.text.trim().slice(0, 90), l.text]))('index.html:%i %s', (_n, _short, text) => {
    // revoking a link by its id needs no folder at all
    if (/\/files\/folder\/links\/' \+ id/.test(text)) return;
    expect(text).toMatch(/inFolderLib\(|folderLibQuery\(/);
  });
});

// A loop awaits between requests, and the rail stays clickable; the library it started
// in is captured once, so switching library halfway can't send the rest elsewhere.
describe('multi-folder loops keep the library they started in', () => {
  test.each([
    ['moveItemsIntoFolder', /const lib = currentLibraryId;/, /inFolderLib\(\{ path: p, target: targetPath \}, lib\)/],
    ['deleteSelectedItems', /const lib = currentLibraryId;/, /inFolderLib\(\{ path: p \}, lib\)/],
    ['downloadSelectedItems', /const lib = currentLibraryId;/, /downloadFolderZip\(p, lib\)/],
    ['openLibraryTransfer', /const srcLib = currentLibraryId;/, /inFolderLib\(\{ path: p, library_id: b\.dataset\.lib \}, srcLib\)/],
  ])('%s', (name, capture, use) => {
    const b = body(name);
    expect(b).toMatch(capture);
    expect(b).toMatch(use);
    expect(b.search(capture)).toBeLessThan(b.search(use));
  });

  test('the folder share dialog keeps the library it was opened in', () => {
    expect(body('openFolderShare')).toMatch(/folderShareLib = currentLibraryId;/);
    for (const fn of ['loadFolderShareLinks', 'createFolderShareLink', 'loadFolderAccess']) {
      expect(body(fn)).toMatch(/folderShareLib\)/);
    }
  });
});

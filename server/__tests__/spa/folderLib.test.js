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

  test('there are folder requests to check', () => expect(lines.length).toBeGreaterThanOrEqual(11));

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
    for (const fn of ['loadFolderShareLinks', 'createFolderShareLink']) {
      expect(body(fn)).toMatch(/folderShareLib\)/);
    }
  });
});

// Moves report what the server did, not what was selected (files the caller can only
// view are skipped by the server and stay put).
describe('the move summary', () => {
  const fnSource = (name) => {
    const start = html.search(new RegExp(`function ${name}\\(`));
    const open = html.indexOf('{', start);
    let depth = 0;
    for (let j = open; j < html.length; j++) {
      if (html[j] === '{') depth++;
      else if (html[j] === '}' && --depth === 0) return html.slice(start, j + 1);
    }
    throw new Error(name);
  };
  const ctx = {};
  vm.runInNewContext(`${fnSource('transferSummary')}\nthis.transferSummary = transferSummary;`, ctx);
  test.each([
    ['move', 3, 0, 'Moved 3 items to Clients'],
    ['move', 1, 0, 'Moved 1 item to Clients'],
    ['move', 2, 1, 'Moved 2 items to Clients · 1 file you can only view stayed where it was'],
    ['move', 0, 2, 'Nothing was moved: 2 files you can only view stayed where they were'],
    ['copy', 0, 0, 'Nothing was copied'],
  ])('%s: %i done, %i skipped', (mode, done, skipped, want) => {
    expect(ctx.transferSummary(mode, done, skipped, 'Clients')).toBe(want);
  });
  test('files kept behind as library content are explained', () => {
    expect(ctx.transferSummary('move', 1, 0, 'Clients', 2)).toBe("Moved 1 item to Clients · 2 files that belong to the library stayed where they were (only the library's owner can move them to another library)");
    expect(ctx.transferSummary('move', 0, 1, 'Clients', 1)).toBe("Nothing was moved: 1 file you can only view stayed where it was · 1 file that belongs to the library stayed where it was (only the library's owner can move it to another library)");
  });
  test('the library-transfer dialog and the folder move use the server counts', () => {
    const b = body('openLibraryTransfer');
    expect(b).toMatch(/done \+= Number\(r\?\.count/);
    expect(b).toMatch(/skipped \+= Number\(r\?\.skipped/);
    expect(b).toMatch(/kept \+= Number\(r\?\.kept/);
    expect(b).toMatch(/toast\(transferSummary\(mode, done, skipped, [^)]*, kept\)\)/);
    expect(body('moveFolderToLibrary')).toMatch(/transferSummary\('move', Number\(r\.count\)/);
  });
  test('a large upload names its library when it starts, and finishes in the same one', () => {
    const b = body('uploadFileResumable');
    expect(b).toMatch(/const lib = currentLibraryId;/);
    expect(b).toMatch(/getOrCreateUploadSession\(file, displayName, lib\)/);
    expect(b).toMatch(/\/complete', \{ libraryId: lib \}/);
    expect(body('getOrCreateUploadSession')).toMatch(/apiPost\('\/files\/uploads', \{\s*displayName,\s*libraryId,/);
  });
});

// Sharing in the app: what each person is shown, from what the server said about them
// (GET /api/libraries). The server decides; this only must not show what it would refuse.
describe('library relationships and where you can add files', () => {
  const fnSource = (name) => {
    const start = html.search(new RegExp(`function ${name}\\(`));
    const open = html.indexOf('{', start);
    let depth = 0;
    for (let j = open; j < html.length; j++) {
      if (html[j] === '{') depth++;
      else if (html[j] === '}' && --depth === 0) return html.slice(start, j + 1);
    }
    throw new Error(name);
  };
  const run = (ctx) => {
    vm.runInNewContext(['currentLibrary', 'libraryRelation', 'canWriteHere', 'canChangeFile', 'folderIsShared', 'canShareLibrary', 'libraryMenuRow', 'libraryMenuInnerHtml'].map(fnSource).join('\n')
      + `\nconst LIBRARY_PILL = { rw: 'Read-Write', r: 'Read-only', folders: 'Folders' };`
      + `\nthis.api = { currentLibrary, libraryRelation, canWriteHere, canChangeFile, folderIsShared, canShareLibrary, libraryMenuInnerHtml };`, ctx);
    return ctx.api;
  };
  const base = (over) => ({
    esc: (x) => String(x), escAttr: (x) => String(x), ICON_SHARE: '<svg/>', pinnedLibraryIds: new Set(),
    currentUser: { role: 'contributor' }, currentLibraryId: 'L1', librariesList: [], ...over,
  });

  test.each([
    [{ my_access: 'owner' }, 'Owned by you'],
    [{ my_access: 'rw' }, 'Shared with you · Read-Write'],
    [{ my_access: 'r' }, 'Shared with you · Read-only'],
    [{ my_access: 'folders' }, 'Folders in it are shared with you'],
    [{ my_access: 'listed', add_right: 'legacy' }, 'Not shared · files you add stay private to you'],
    [{ my_access: 'listed', add_right: null }, 'You see only files shared with you'],
    [{ my_access: 'admin', owner_email: 'dave@x.com' }, 'Owned by dave@x.com'],
  ])('%j reads "%s"', (lib, want) => expect(run(base()).libraryRelation(lib)).toBe(want));

  test.each([
    ['the owner, anywhere', { add_right: 'owner' }, 'Deep/Down', 'contributor', true],
    ['a Read-only share', { my_access: 'r', add_right: null }, '', 'contributor', false],
    ['a Read-Write folder share, in it', { my_access: 'folders', add_right: null, my_folders: [{ path: 'Team', level: 'rw' }] }, 'Team/Sub', 'contributor', true],
    ['... not in a look-alike folder', { my_access: 'folders', add_right: null, my_folders: [{ path: 'Team', level: 'rw' }] }, 'Team2', 'contributor', false],
    ['... not above it', { my_access: 'folders', add_right: null, my_folders: [{ path: 'Team', level: 'rw' }] }, '', 'contributor', false],
    ['a Read-only folder share', { my_access: 'folders', add_right: null, my_folders: [{ path: 'Team', level: 'r' }] }, 'Team', 'contributor', false],
    ['a viewer, whatever the library says', { add_right: 'admin' }, '', 'viewer', false],
  ])('canWriteHere: %s', (_l, lib, path, role, want) => {
    const api = run(base({ currentUser: { role }, librariesList: [{ id: 'L1', name: 'Clients', ...lib }] }));
    expect(api.canWriteHere(path)).toBe(want);
  });

  test('the switcher groups libraries by relationship, and offers Share only where you manage', () => {
    const api = run(base({ librariesList: [
      { id: 'L1', name: 'Mine', my_access: 'owner', can_manage: true, owner_id: 'u1' },
      { id: 'L2', name: 'Theirs', my_access: 'rw', can_manage: false },
      { id: 'L3', name: 'Open', my_access: 'listed', can_manage: false },
    ] }));
    const menu = api.libraryMenuInnerHtml();
    expect(menu.indexOf('My libraries')).toBeLessThan(menu.indexOf('Shared with me'));
    expect(menu.indexOf('Shared with me')).toBeLessThan(menu.indexOf('Other libraries'));
    expect(menu).toContain("setFileView('shared')\">See everything shared with you");
    expect((menu.match(/data-share-lib="L1"/g) || []).length).toBe(2); // the row, and "Share “Mine”…"
    expect(menu).not.toMatch(/data-share-lib="L2"/);
    expect(menu).toMatch(/Theirs<\/span><span class="pill">Read-Write<\/span>/);
    expect(menu).not.toMatch(/Manage members/);
  });

  test('a viewer is not offered a new library', () => {
    const api = run(base({ currentUser: { role: 'viewer' }, librariesList: [{ id: 'L1', name: 'Open', my_access: 'listed' }] }));
    expect(api.libraryMenuInnerHtml()).not.toMatch(/New library/);
  });

  test('the share dialog never splices ids into inline handlers', () => {
    expect(fnSource('mountLibraryShare')).not.toMatch(/onclick=/);
  });

  test('the old copy-a-grant-onto-every-file folder form is gone; its grants stay listed and revocable', () => {
    expect(html).not.toMatch(/apiPost\('\/files\/folder\/members'/);
    expect(html).not.toMatch(/function grantFolderAccess/);
    const b = fnSource('loadFolderFileGrants');
    expect(b).toMatch(/apiGet\('\/files\/folder\/members\?path='/);
    expect(b).toMatch(/apiDelete\('\/files\/folder\/members', inFolderLib\(\{ path, email \}, lib\)\)/);
  });

  test("an ownerless library (the one seeded at install) offers no Share", () => {
    const api = run(base({ currentUser: { role: 'admin' }, librariesList: [{ id: 'L1', name: 'Ptech Workspace', my_access: 'admin', can_manage: true, owner_id: null }] }));
    expect(api.libraryMenuInnerHtml()).not.toMatch(/data-share-lib/);
  });

  test.each([
    ["your own personal file, in a library shared without you", { name: 'Old/mine.pdf', uploaded_by: 'me', library_scoped: false }, true],
    ["someone else's file there", { name: 'Old/theirs.pdf', uploaded_by: 'you', library_scoped: false }, false],
    ["your own upload that became library content", { name: 'Old/added.pdf', uploaded_by: 'me', library_scoped: true }, false],
  ])('canChangeFile: %s', (_l, f, want) => {
    const api = run(base({ currentUser: { id: 'me', role: 'contributor' }, librariesList: [{ id: 'L1', name: 'Clients', my_access: 'listed', add_right: null, my_folders: [] }] }));
    expect(api.canChangeFile(f)).toBe(want);
  });

  test('a shared folder, or one with a shared folder inside, reads as shared -- not a look-alike', () => {
    const api = run(base({ librariesList: [{ id: 'L1', name: 'Clients', add_right: 'owner', shared_folders: ['Clients/Acme'], my_folders: [{ path: 'Team', level: 'rw' }] }] }));
    expect(['Clients', 'Clients/Acme', 'Team', 'Clients/Acme2', 'Teams', 'Other'].map(p => api.folderIsShared(p))).toEqual([true, true, true, false, false, false]);
  });

  test('uploads land in the folder being viewed', () => {
    expect(fnSource('handleFilePickerChange')).toMatch(/intoFolder\(dest, file\.webkitRelativePath \|\| file\.name\)/);
    expect(fnSource('handleFolderPickerChange')).toMatch(/const dest = uploadDestination\(\);/);
    expect(fnSource('handleFileHomeDrop')).toMatch(/if \(!canWriteHere\(dest\)\)/);
  });
});

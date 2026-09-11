'use strict';
// The app's "Who has access" lists (index.html). No browser here: the section is lifted
// out of index.html and run in a sandbox against a stub DOM, and the call sites are
// checked by reading the source. The server decides every level and every impact; these
// tests pin down the words the app puts on them, and that hostile names stay text.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '../../../index.html'), 'utf8');
const fnLine = (name) => html.match(new RegExp(`^function ${name}\\(.*$`, 'm'))[0];
const section = (() => {
  const start = html.indexOf('// ---- Who has access (piece 3) ----');
  const end = html.indexOf('async function renderShareLinks() {');
  if (start < 0 || end < start) throw new Error('Who has access section not found');
  return html.slice(start, end);
})();
// The body of `function name(...) { ... }` in index.html, by brace matching.
function body(name) {
  const start = html.search(new RegExp(`(async )?function ${name}\\(`));
  if (start < 0) throw new Error(`${name} not found in index.html`);
  let i = html.indexOf('{', html.indexOf(')', start)), depth = 0;
  for (let j = i; j < html.length; j++) {
    if (html[j] === '{') depth++;
    else if (html[j] === '}' && --depth === 0) return html.slice(i, j + 1);
  }
  throw new Error(`unbalanced ${name}`);
}

function sandbox({ me = 'me@acme.test', answer = null } = {}) {
  const calls = [];
  const ctx = {
    currentUser: { email: me, role: 'contributor' },
    fileDate: (d) => `on ${d}`,
    apiGet: async (u) => { calls.push(u); if (answer instanceof Error) throw answer; return answer; },
    askConfirm: async (msg, opts) => { calls.push({ msg, opts }); return true; },
    toast: () => {}, loadLibraries: async () => {}, closeLibraryMenu: () => {}, groupErr: (e, m) => m,
    librariesList: [], inFolderLib: (b) => b, openLibraryShare: () => {}, openModal: () => ({ el: { querySelectorAll: () => [], querySelector: () => null } }),
    Date, calls,
  };
  vm.runInNewContext(`${fnLine('esc')}\n${fnLine('escAttr')}\n${section}
    Object.assign(this, { accessReasonText, accessLevelPill, accessRemovalWords, accessLinkWords, renderYourAccess, mountAccessList, accessUrl, accHeadline });`, ctx);
  return ctx;
}

const LIBDOOR = { kind: 'library', library: { id: 'L', name: 'Clients', owner: { email: 'owner@acme.test', name: 'Olive' } }, path: '', name: 'Clients' };
const FOLDERDOOR = { ...LIBDOOR, kind: 'folder', path: 'Mender/2025', name: '2025' };
const FILEDOOR = { kind: 'file', file: { id: 'F', name: 'Q1.pdf', folder: 'Mender', library: { id: 'L', name: 'Clients', owner_email: 'owner@acme.test' }, library_content: true, added_by: { email: 'up@acme.test', name: null } } };
const tom = { email: 'tom@acme.test', name: 'Tom' };
const meP = { email: 'me@acme.test', name: 'Me' };

describe('reasons, in words', () => {
  const { accessReasonText: t } = sandbox();
  test.each([
    ['owner at the library', { kind: 'owner', level: 'admin' }, LIBDOOR, 'them', 'Owns this library'],
    ['owner at a folder', { kind: 'owner', level: 'admin' }, FOLDERDOOR, 'them', 'Owns “Clients”, the library this folder is in'],
    ['owner at a file', { kind: 'owner', level: 'admin' }, FILEDOOR, 'them', 'Owns “Clients”, the library this file belongs to'],
    ['you own it', { kind: 'owner', level: 'admin' }, LIBDOOR, 'you', 'You own this library'],
    ['admin', { kind: 'admin', level: 'admin' }, LIBDOOR, 'them', 'Admin: can open everything in Depot'],
    ['admin, you', { kind: 'admin', level: 'admin' }, LIBDOOR, 'you', "You're an admin, so you can open everything in Depot"],
    ['library share, direct', { kind: 'library_share', level: 'read', granted_by: tom }, LIBDOOR, 'them', 'Tom shared this library with them · Read-only'],
    ['library share you made', { kind: 'library_share', level: 'write', granted_by: meP }, LIBDOOR, 'them', 'You shared this library with them · Read-Write'],
    ['library share from a folder', { kind: 'library_share', level: 'write', granted_by: tom }, FOLDERDOOR, 'them', 'Tom shared the whole library with them · Read-Write'],
    ['library share by group', { kind: 'library_share', level: 'write', via_group: { name: 'Accounting' } }, LIBDOOR, 'them', 'Member of Accounting, which has Read-Write on this library'],
    ['library share by group, you', { kind: 'library_share', level: 'read', via_group: { name: 'Accounting' } }, FOLDERDOOR, 'you', "You're in the Accounting group, which has Read-only on the whole library"],
    ['no recorded sharer', { kind: 'library_share', level: 'read' }, LIBDOOR, 'them', 'Shared with them · Read-only'],
    ['folder share at the door', { kind: 'folder_share', relation: 'at', level: 'read', folder_path: 'Mender/2025', granted_by: tom }, FOLDERDOOR, 'them', 'Tom shared this folder with them · Read-only'],
    ['folder share above', { kind: 'folder_share', relation: 'above', level: 'read', folder_path: 'Mender', granted_by: tom }, FOLDERDOOR, 'them', 'Tom shared “Mender”, the folder this one is in, with them · Read-only'],
    ['group share above', { kind: 'folder_share', relation: 'above', level: 'write', folder_path: 'Mender', via_group: { name: 'Mender LLC' } }, FOLDERDOOR, 'them', 'Member of Mender LLC, which has Read-Write on “Mender”, which contains this folder'],
    ['folder share above a file', { kind: 'folder_share', relation: 'above', level: 'read', folder_path: 'Mender', granted_by: tom }, FILEDOOR, 'them', 'Tom shared the folder “Mender” this file is in with them · Read-only'],
    ['inside', { kind: 'folder_share', relation: 'inside', level: 'write', folder_path: 'Clients/Mender', granted_by: tom }, LIBDOOR, 'them', 'Only the folder “Clients/Mender” · Read-Write · shared by Tom'],
    ['inside, by group', { kind: 'folder_share', relation: 'inside', level: 'read', folder_path: 'A/B', via_group: { name: 'G' } }, LIBDOOR, 'them', 'Only the folder “A/B”: member of G, which has Read-only there'],
    ['file given directly', { kind: 'file_grant', level: 'write', granted_by: tom }, FILEDOOR, 'them', 'Given this file directly by Tom · Can edit'],
    ['file given to you', { kind: 'file_grant', level: 'read', granted_by: tom }, FILEDOOR, 'you', 'Tom gave you this file directly · Can view'],
    ['files given inside', { kind: 'file_grants', level: 'write', permission: 'mixed', files: { count: 3 } }, FOLDERDOOR, 'them', 'Given 3 files in here directly · mixed'],
    ['one file given inside', { kind: 'file_grants', level: 'admin', permission: 'admin', files: { count: 1 } }, FOLDERDOOR, 'them', 'Given 1 file in here directly · Can manage'],
    ['uploader', { kind: 'uploader', level: 'admin' }, FILEDOOR, 'them', "Added this file · it's their own file, not the library's"],
    ['drift', { kind: 'unexplained', level: 'read' }, LIBDOOR, 'them', "Can open this for a reason this list can't show. Please tell your Depot admin."],
  ])('%s', (_n, r, door, who, want) => expect(t(r, door, who)).toBe(want));
});

describe('the level pill', () => {
  const { accessLevelPill: pill } = sandbox();
  const p = (over) => ({ level: 'read', effective: 'read', is_owner: false, reasons: [], ...over });
  test('library and folder doors speak in shares; a file in what you can do with it', () => {
    expect(pill(p({ is_owner: true, level: 'admin', effective: 'admin' }), 'library')).toBe('Owner');
    expect(pill(p({ level: 'admin', effective: 'admin', reasons: [{ kind: 'admin' }] }), 'folder')).toBe('Admin');
    expect(pill(p({ level: 'write', effective: 'write' }), 'library')).toBe('Read-Write');
    expect(pill(p({ level: 'write', effective: 'read' }), 'library')).toBe('Read-only');
    expect(pill(p({ level: null, effective: null, reasons: [{ kind: 'folder_share' }] }), 'library')).toBe('Some folders');
    expect(pill(p({ level: null, effective: null, reasons: [{ kind: 'file_grants' }] }), 'library')).toBe('Some files');
    expect(pill(p({ level: 'admin', effective: 'admin' }), 'file')).toBe('Can manage');
  });
});

describe('what removing a key does, in words', () => {
  const { accessRemovalWords: w, accessLinkWords } = sandbox();
  const person = (ref, name, reasons) => ({ ref, name, email: `${name.toLowerCase()}@acme.test`, level: 'write', reasons });
  const resp = (people, keys = [], links = []) => ({ door: LIBDOOR, people, keys, links });
  const share = (over = {}) => ({ ref: 'ls:1', kind: 'library_share', id: '1', folder_path: '', relation: 'door', permission: 'write',
    subject: { type: 'user', email: 'tom@acme.test' }, impact: { lose: [], keep: [], unknown: [], admins_unaffected: 0 }, waiting_count: 0, ...over });
  test('a direct share someone has no other way around', () => {
    const k = share({ impact: { lose: ['u:t'], keep: [], unknown: [], admins_unaffected: 0 } });
    const out = w(k, resp([person('u:t', 'Tom', [{ key: 'ls:1', kind: 'library_share', level: 'write' }])], [k],
      [{ state: 'active', created_by: { user_id: 't' } }, { state: 'paused', created_by: { user_id: 't' } }]));
    expect(out.title).toBe("Remove tom@acme.test's share?");
    expect(out.lines).toEqual([
      'tom@acme.test will lose Read-Write on “Clients”.',
      "They won't be able to open anything in “Clients” any more.",
      "Shares of folders inside, and files given one by one, aren't affected.",
      '1 public link they made here will stop working unless they can still edit those files another way.',
    ]);
    expect(out.ok).toBe('Remove share');
  });
  test('…and one they can still get in without, named by the way in', () => {
    const k = share({ impact: { lose: [], keep: [{ ref: 'u:t', before: 'write', after: 'read', via: ['ls:2'] }], unknown: [], admins_unaffected: 0 } });
    const out = w(k, resp([person('u:t', 'Tom', [{ key: 'ls:1', kind: 'library_share', level: 'write' }, { key: 'ls:2', kind: 'library_share', level: 'read', via_group: { name: 'Accounting' } }])], [k]));
    expect(out.lines[1]).toBe('They can still get in: Member of Accounting, which has Read-only on this library.');
  });
  test('a group share: who loses, who keeps, who is still waiting, and admins', () => {
    const k = share({ subject: { type: 'group', name: 'Accounting', member_count: 6 }, waiting_count: 2,
      impact: { lose: ['u:a', 'u:b', 'u:c', 'u:d'], keep: [{ ref: 'u:e', after: 'read', via: ['owner'] }], unknown: [], admins_unaffected: 1 } });
    const people = ['a', 'b', 'c', 'd'].map(x => person(`u:${x}`, x.toUpperCase(), []));
    people.push(person('u:e', 'Eve', [{ key: 'owner', kind: 'owner', level: 'admin' }]));
    const out = w(k, resp(people, [k]));
    expect(out.title).toBe("Remove the Accounting group's share?");
    expect(out.lines).toEqual([
      '4 of its 6 members will lose access to “Clients”: A, B, C and 1 more.',
      '1 keeps another way in: Eve (Owns this library).',
      "2 members haven't signed in or verified their email, so nothing changes for them today.",
      'Depot admins can open everything anyway.',
    ]);
  });
  test('a group share nobody depends on', () => {
    const k = share({ subject: { type: 'group', name: 'G', member_count: 1 }, impact: { lose: [], keep: [{ ref: 'u:e', after: 'write', via: ['ls:9'] }], unknown: [], admins_unaffected: 0 } });
    expect(w(k, resp([person('u:e', 'Eve', [])], [k])).lines).toContain('Nobody loses access: everyone this share lets in has another way in.');
  });
  test('lowering to Read-only', () => {
    const k = share({ impact_if_read: { lose: [], keep: [{ ref: 'u:t', after: 'read', via: [] }], unknown: [], admins_unaffected: 0 } });
    const out = w(k, resp([person('u:t', 'Tom', [])], [k]), { lower: true });
    expect(out.title).toBe('Change tom@acme.test to Read-only?');
    expect(out.lines[0]).toBe("They'll still open and download files here, but can't add, change or delete them, or make public links.");
    const k2 = share({ impact_if_read: { lose: [], keep: [{ ref: 'u:t', after: 'write', via: ['fs:3'] }], unknown: [], admins_unaffected: 0 } });
    const out2 = w(k2, resp([person('u:t', 'Tom', [{ key: 'fs:3', kind: 'folder_share', relation: 'above', level: 'write', folder_path: 'Mender', granted_by: tom }])], [k2]), { lower: true });
    expect(out2.lines[0]).toBe('They still have Read-Write another way (Tom shared “Mender”, the folder this one is in, with them · Read-Write), so nothing changes for them yet.');
  });
  test('a file given directly', () => {
    const base = { ref: 'fg:1', kind: 'file_grant', subject: { type: 'user', email: 'tom@acme.test' } };
    const fileResp = (people, extra = {}) => ({ door: FILEDOOR, people, keys: [], links: [], ...extra });
    expect(w({ ...base, impact: { lose: ['u:t'], keep: [], unknown: [] } }, fileResp([])).lines).toEqual(["They won't be able to open it any more."]);
    const keep = { ...base, impact: { lose: [], keep: [{ ref: 'u:t', after: 'write', via: ['ls:1'] }], unknown: [] } };
    expect(w(keep, fileResp([person('u:t', 'Tom', [{ key: 'ls:1', kind: 'library_share', level: 'write', granted_by: tom }])])).lines)
      .toEqual(["They'll still be able to edit it: Tom shared the whole library with them · Read-Write."]);
    expect(w({ ...base, impact: { lose: [], keep: [], unknown: ['u:t'] } }, fileResp([], { library_detail: 'hidden' })).lines)
      .toEqual(["They may still be able to open it through the library's sharing."]);
    expect(w(keep, fileResp([])).title).toBe("Revoke tom@acme.test's access to “Q1.pdf”?");
  });
  test('files given one by one in a folder', () => {
    const k = (open) => ({ ref: 'fgs:tom@acme.test', kind: 'file_grants', subject: { type: 'user', email: 'tom@acme.test' }, files_impact: { files: 5, still_open: open } });
    expect(w(k(0), resp([])).lines).toEqual(["They won't be able to open these any more."]);
    expect(w(k(2), resp([])).lines).toEqual(["2 of these stay open to them another way; the other 3 won't."]);
    expect(w(k(5), resp([])).lines).toEqual(['They keep access to all of them another way.']);
    expect(w(k(0), resp([])).title).toBe('Revoke the 5 files given to tom@acme.test one by one here?');
  });
  test('a link', () => {
    expect(accessLinkWords({ name: 'Q1.pdf' }).lines[0]).toBe("Anyone who has it won't be able to download “Q1.pdf” any more. People signed in to Depot keep whatever access they have.");
  });
});

describe('your access', () => {
  const el = () => ({ innerHTML: '' });
  test('someone a library is shared with sees how, and who can see the rest', () => {
    const { renderYourAccess } = sandbox();
    const e = el();
    renderYourAccess(e, { can_see_keys: false, door: LIBDOOR, you: { level: 'write', effective: 'write', view_only: false, owner: { email: 'owner@acme.test', name: 'Olive' },
      reasons: [{ kind: 'library_share', level: 'write', granted_by: tom }], inside: { folders: [], files: 0 } } });
    expect(e.innerHTML).toContain('You can edit this');
    expect(e.innerHTML).toContain('Tom shared this library with you · Read-Write');
    expect(e.innerHTML).toContain('Only Olive (the library owner) or an admin can see who else has access.');
  });
  test('listed only by the old rules, and view-only', () => {
    const { renderYourAccess } = sandbox();
    const e = el();
    renderYourAccess(e, { can_see_keys: false, door: LIBDOOR, you: { level: null, reasons: [], inside: { folders: [{ path: 'A', level: 'read' }], files: 2 }, listed_because: null, owner: null } });
    expect(e.innerHTML).toContain("You can&#39;t open this library as a whole");
    expect(e.innerHTML).toContain('You have Read-only on the folder “A” inside');
    expect(e.innerHTML).toContain('2 files here were given to you directly');
    renderYourAccess(e, { can_see_keys: false, door: LIBDOOR, you: { level: null, reasons: [], inside: { folders: [], files: 0 }, listed_because: 'open', owner: null } });
    expect(e.innerHTML).toContain('it isn&#39;t shared with anyone yet');
    renderYourAccess(e, { can_see_keys: false, door: LIBDOOR, you: { level: 'read', effective: 'read', view_only: true, reasons: [], inside: { folders: [], files: 0 } } });
    expect(e.innerHTML).toContain('<li>Your account can only view files.</li>');
  });
  test("you added a library file: it's the library's now", () => {
    const { renderYourAccess } = sandbox({ me: 'up@acme.test' });
    const e = el();
    renderYourAccess(e, { can_see_keys: false, door: FILEDOOR, you: { level: 'read', effective: 'read', reasons: [{ kind: 'library_share', level: 'read', granted_by: tom }] } });
    expect(e.innerHTML).toContain('You added this file. It belongs to the library now, so your access comes from the library.');
  });
});

describe('the list', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const resp = (people, extra = {}) => ({
    door: LIBDOOR, can_see_keys: true, generated_at: '2026-09-11T10:00:00Z', you: {},
    people, keys: [], links: [], admins: { count: 2 }, ...extra,
  });
  const person = (i, over = {}) => ({ ref: `u:${i}`, user_id: String(i), email: `p${i}@acme.test`, name: `P${i}`, level: 'read', effective: 'read',
    view_only: false, is_owner: false, same_address_accounts: 1, partial: false, ways_in: 1, reasons: [{ key: `ls:${i}`, kind: 'library_share', relation: 'door', level: 'read' }], ...over });
  async function mounted(answer) {
    const ctx = sandbox({ answer });
    const root = { innerHTML: '', addEventListener: () => {} };
    ctx.mountAccessList(root, { kind: 'library', libraryId: 'L' });
    await new Promise(r => setImmediate(r));
    return { root, ctx };
  }
  test('asks the server for the door, with the folder encoded', () => {
    const { accessUrl } = sandbox();
    expect(accessUrl({ kind: 'library', libraryId: 'L' })).toBe('/access/libraries/L');
    expect(accessUrl({ kind: 'folder', libraryId: 'L', path: 'Tax & Co/50%' })).toBe('/access/libraries/L?folder=Tax%20%26%20Co%2F50%25');
    expect(accessUrl({ kind: 'file', fileId: 'F/1' })).toBe('/access/files/F%2F1');
  });
  test('people, the admins row, who is waiting, the links, and the footer', async () => {
    const key = { ref: 'ls:9', kind: 'library_share', permission: 'write', waiting_count: 1, waiting: [{ email: 'new@x.test', why: 'no_account' }], can_remove: true, change_here: true };
    const { root } = await mounted(resp([person(1, { name: 'Tom Baudier', is_owner: true, level: 'admin', effective: 'admin', reasons: [{ key: 'owner', kind: 'owner', relation: 'door', level: 'admin' }] })], {
      keys: [key], links: [{ ref: 'lk:1', kind: 'file', name: 'Q1.pdf', created_by: { email: 'tom@acme.test', name: 'Tom' }, state: 'paused', paused_reason: 'creator_view_only', can_revoke: true, access_count: 2, expires_at: null }],
    }));
    expect(root.innerHTML).toContain('1 person can open everything in “Clients” · 1 public link');
    expect(root.innerHTML).toContain('Tom Baudier');
    expect(root.innerHTML).toContain('>Owner<');
    expect(root.innerHTML).toContain('Depot admins (2) · can open everything in Depot');
    expect(root.innerHTML).toContain('new@x.test · Hasn&#39;t signed in yet. Gets Read-Write once they sign in with this address.');
    expect(root.innerHTML).toContain('Anyone with a link (1)');
    expect(root.innerHTML).toContain('Tom&#39;s account can only view files');
    expect(root.innerHTML).toContain('Removing a key stops new access at once');
  });
  test('filter chips appear past eight people', async () => {
    const eight = await mounted(resp(Array.from({ length: 8 }, (_, i) => person(i))));
    expect(eight.root.innerHTML).not.toContain('acc-chip');
    const nine = await mounted(resp(Array.from({ length: 9 }, (_, i) => person(i))));
    expect(nine.root.innerHTML).toContain('Everyone (9)');
  });
  test('names from other people stay text', async () => {
    const { root } = await mounted(resp([person(1, { name: evil, email: `${evil}@x.test`, reasons: [{ key: 'ls:1', kind: 'library_share', relation: 'door', level: 'read', via_group: { name: evil } }] })], {
      door: { ...LIBDOOR, library: { ...LIBDOOR.library, name: evil } },
    }));
    expect(root.innerHTML).not.toContain('<img');
  });
  test("someone who can't see the list gets their own access", async () => {
    const { root } = await mounted({ can_see_keys: false, door: LIBDOOR, you: { level: 'read', effective: 'read', reasons: [], inside: { folders: [], files: 0 } } });
    expect(root.innerHTML).toContain('You can view this');
  });
  test('a failure offers Try again; a missing folder says so', async () => {
    const failed = await mounted(Object.assign(new Error('x'), { status: 500 }));
    expect(failed.root.innerHTML).toContain('Couldn&#39;t load who has access.');
    expect(failed.root.innerHTML).toContain('data-acc-retry');
    const gone = await mounted(Object.assign(new Error('x'), { status: 404, body: { error: 'Folder not found in this library' } }));
    expect(gone.root.innerHTML).toContain('Folder not found in this library.');
  });
});

describe('the call sites', () => {
  test('the list does no access arithmetic of its own', () => {
    expect(section).not.toMatch(/\bRANK\b|maxLevel|condition\(/);
  });
  test("the file dialog's who-gets-it toggle only touches its own buttons", () => {
    expect(body('shareSetWho')).toContain("#file-share-scrim .share-seg-opt[data-who]");
  });
  test('Share and Who has access sit side by side in the library and folder dialogs', () => {
    expect(body('openLibraryShare')).toContain('wireAccessTabs(');
    expect(body('openFolderShare')).toContain('wireAccessTabs(');
    expect(body('openFolderShare')).toContain('mountAccessList(');
  });
  test('the old guesses are gone: the grant list and the folder access line', () => {
    expect(html).not.toMatch(/function loadFileAccess\(|function folderAccessLine\(/);
    expect(body('openShareSelected')).toContain("mountAccessList(document.getElementById('file-access-list')");
  });
  test('removals ask with what the server says will happen', () => {
    const share = html.slice(html.indexOf('function mountLibraryShare('), html.indexOf('function openLibraryTransfer('));
    expect(share).toMatch(/async function remove\(shareId, who\) \{[\s\S]*?removalWords\(shareId\)/);
    expect(share).toMatch(/if \(permission === 'read'\) \{[\s\S]*?removalWords\(shareId, \{ lower: true \}\)/);
    expect(body('loadFolderFileGrants')).toContain('accessRemovalWords(key, resp)');
  });
  test('menus and the switcher offer the list', () => {
    expect(body('openFileMenu')).toContain('openFileAccess(');
    expect(body('openFolderMenu')).toContain('openLibraryAccess(');
    expect(body('libraryMenuInnerHtml')).toContain('data-access-lib=');
  });
});

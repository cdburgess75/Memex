'use strict';
// What the app offers for a folder, now that a rename or a move carries its shares.
//
// The rule the menu follows: renaming a folder, or moving it within the library, needs
// the right where the folder SITS -- in the folder above it. Read-Write ON a folder is
// the right to fill and reorganise what is in it, not to pick the folder up. Deleting it,
// or taking it to another library, ENDS the sharing, so those belong to whoever manages
// the library. And a shared folder says so, wherever it is listed.
//
// No browser: the helpers are lifted out of index.html and run in a sandbox, and the call
// sites are checked by reading the source.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '../../../index.html'), 'utf8');

// The whole of `function name(...) { ... }`. The parameter list is skipped by matching
// parentheses first: a destructured parameter ({ libraryId, folderPath }) opens a brace
// that has nothing to do with the body, and counting from it stops after one line.
const fn = (name) => {
  const start = html.search(new RegExp(`(async )?function ${name}\\(`));
  if (start < 0) throw new Error(`${name} not found in index.html`);
  let i = html.indexOf('(', start);
  for (let depth = 0; i < html.length; i++) {
    if (html[i] === '(') depth++;
    else if (html[i] === ')' && --depth === 0) { i++; break; }
  }
  let depth = 0;
  for (let j = html.indexOf('{', i); j < html.length; j++) {
    if (html[j] === '{') depth++;
    else if (html[j] === '}' && --depth === 0) return html.slice(start, j + 1);
  }
  throw new Error(`unbalanced ${name}`);
};

// The four gates, over a stand-in library.
function gates(library, user = { role: 'contributor' }) {
  const names = ['canWriteHere', 'folderIsShared', 'folderIsSharedHere', 'canChangeFolder', 'canDeleteFolder', 'folderSharedTag'];
  const ctx = {
    currentUser: user,
    currentLibrary: () => library,
    escAttr: (v) => String(v).replace(/"/g, '&quot;'),
  };
  vm.runInNewContext(`${names.map(fn).join('\n')}\n${names.map(n => `this.${n} = ${n};`).join('')}`, ctx);
  return ctx;
}

const OWNED = { id: 'L1', name: 'Clients', add_right: 'owner', can_manage: true, shared_folders: ['Clients/Mender'], my_folders: [] };
const GRANTED = { id: 'L1', name: 'Clients', can_manage: false, my_folders: [{ path: 'Clients/Mender', level: 'rw' }, { path: 'Team', level: 'r' }] };

describe('what the menu offers for a folder', () => {
  test('the right that counts is where the folder sits, not inside it', () => {
    // Ben holds Read-Write ON 'Clients/Mender' and nothing above it
    const g = gates(GRANTED);
    expect(g.canChangeFolder('Clients/Mender')).toBe(false);      // its name and place are not his
    expect(g.canChangeFolder('Clients/Mender/Deep')).toBe(true);  // but inside it, he is free
    expect(g.canWriteHere('Clients/Mender')).toBe(true);          // he can still add files to it
  });

  test('a Read-only folder is not his to reorganise at all', () => {
    const g = gates(GRANTED);
    expect([g.canChangeFolder('Team/Sub'), g.canDeleteFolder('Team/Sub')]).toEqual([false, false]);
  });

  test('the owner may rename and move a shared folder -- that is the point of this piece', () => {
    const g = gates(OWNED);
    expect(g.canChangeFolder('Clients/Mender')).toBe(true);
    expect(g.canDeleteFolder('Clients/Mender')).toBe(true);       // and they manage it, so they may end it
  });

  test('ending somebody else\'s sharing is only for whoever manages the library', () => {
    // a contributor with Read-Write above the folder: may rename and move it, may not delete it
    const g = gates({ id: 'L1', can_manage: false, my_folders: [{ path: 'Clients', level: 'rw' }], shared_folders: undefined });
    expect(g.canChangeFolder('Clients/Mender')).toBe(true);
    expect(g.folderIsShared('Clients/Mender')).toBe(false);       // a non-manager is not told what else is shared
    const shown = gates({ id: 'L1', can_manage: false, my_folders: [{ path: 'Clients', level: 'rw' }, { path: 'Clients/Mender', level: 'r' }] });
    expect([shown.canChangeFolder('Clients/Mender'), shown.canDeleteFolder('Clients/Mender')]).toEqual([true, false]);
  });

  test('a viewer is offered nothing', () => {
    const g = gates(OWNED, { role: 'viewer' });
    expect([g.canChangeFolder('Clients/Mender'), g.canDeleteFolder('Clients/Mender')]).toEqual([false, false]);
  });
});

describe('a shared folder says so', () => {
  test('the marker is on the folder that is shared, not on everything above it', () => {
    const g = gates(OWNED);
    expect(g.folderSharedTag('Clients/Mender')).toContain('Shared');
    expect(g.folderSharedTag('Clients')).toBe('');            // something inside it is shared, it is not
    expect(g.folderSharedTag('Clients/Other')).toBe('');
  });

  test('it says which way, and never leaks a name', () => {
    const g = gates(GRANTED);
    expect(g.folderSharedTag('Clients/Mender')).toContain('Shared with you (Read-Write)');
    expect(g.folderSharedTag('Team')).toContain('Read-only');
    expect(g.folderSharedTag('Clients/Mender')).not.toMatch(/@/);
  });

  test('a non-manager sees no marker on folders shared with other people', () => {
    // shared_folders is a manager-only field; without it nothing is marked
    const g = gates({ id: 'L1', can_manage: false, my_folders: [] });
    expect(g.folderSharedTag('Clients/Mender')).toBe('');
  });
});

describe('the menu and the command bar use them', () => {
  const menu = fn('openFolderMenu');
  const bar = fn('fileLibraryCommandBarHtml');

  test('nothing still asks the old question', () => {
    expect(menu).not.toMatch(/!folderIsShared/);
    expect(bar).not.toMatch(/!folderIsShared/);
    // and the sentence that said a shared folder could not be renamed is gone
    expect(html).not.toMatch(/can't be renamed, moved or deleted/);
  });

  test('rename and move-within-the-library are offered on the change right', () => {
    for (const verb of ['renameFolder', 'moveFolderToParent']) {
      expect(menu).toMatch(new RegExp(`canChange \\? [^\\n]*${verb}`));
    }
  });

  test('delete and move-to-library are offered only when the sharing may be ended', () => {
    for (const verb of ['moveFolderToLibrary', 'deleteFolder']) {
      expect(menu).toMatch(new RegExp(`canEnd \\? [^\\n]*${verb}`));
    }
    expect(bar).toMatch(/canEnd \? [^\n]*deleteSelectedItems/);
    expect(bar).toMatch(/canEnd \? [^\n]*openLibraryTransfer\('move'\)/);
  });

  test('and the folder that cannot be deleted explains why', () => {
    expect(menu).toMatch(/canChange && !canEnd \?/);
    expect(menu).toMatch(/deleting it would end it/);
  });
});

describe('a move asks who it affects, and says what it was told', () => {
  const move = fn('moveItemsIntoFolder');
  const confirm = fn('confirmFolderMove');

  test('the preview is fetched for the whole batch and confirmed once', () => {
    expect(move).toMatch(/folderMovePreview\(moving, targetPath\)/);
    expect(move).toMatch(/if \(!await confirmFolderMove\(moving, targetPath, previews\)\) return;/);
    expect(fn('folderMovePreview')).toMatch(/const ops = paths\.map/);
  });

  test('the answer it was shown goes back with the move', () => {
    expect(move).toMatch(/fingerprint: prints\.get\(p\)/);
    expect(fn('moveFolderToParent')).toMatch(/fingerprint: prints\.get\(path\)/);
  });

  test('a withheld half is described without naming anyone', () => {
    expect(confirm).toMatch(/gain_visible === false/);
    expect(confirm).toMatch(/Anyone the folder you are moving it into is shared with/);
  });

  test('nothing changing for anybody asks nothing', () => {
    expect(confirm).toMatch(/if \(!lines\.length\) return true;/);
  });

  test('a preview that cannot be fetched never blocks the move', () => {
    expect(fn('folderMovePreview')).toMatch(/catch \{ return \{ previews: \[\], prints: new Map\(\) \}; \}/);
  });
});

describe('deleting a folder', () => {
  const del = fn('deleteFolder');
  const words = fn('folderDeleteWords');
  const undoFn = fn('undoFolderDelete');

  test('the dialog says whose access it ends, from the preview', () => {
    expect(words).toMatch(/op: 'delete'/);
    expect(words).toMatch(/shares_ending/);
    expect(words).toMatch(/lose access/);
    expect(del).toMatch(/detailLines/);
    expect(del).toMatch(/okLabel: 'Move to Trash'/);
  });

  test('a manager who is not shown names still gets the truth', () => {
    expect(words).toMatch(/lose_visible === false/);
    expect(words).toMatch(/This folder is shared\. Deleting it ends that sharing\./);
  });

  test('the toast offers Undo, and Undo restores from the operation alone', () => {
    expect(del).toMatch(/toastUndo\(/);
    expect(del).toMatch(/undoFolderDelete\(r\.op_id\)/);
    expect(undoFn).toMatch(/'\/files\/folder\/restore', \{ op_id: opId \}/);
    expect(undoFn).toMatch(/shares_restored/);
    expect(undoFn).toMatch(/could not be/);
  });

  test('a multi-select delete asks the same question and offers one Undo for the lot', () => {
    const many = fn('deleteSelectedItems');
    expect(many).toMatch(/folderDeleteWords\(p\)/);
    expect(many).toMatch(/toastUndo\(`\$\{label\} moved to Trash`/);
  });

  test('the Share panel offers the sharing back after the toast has gone', () => {
    expect(fn('mountLibraryShare')).toMatch(/ended_shares/);
    expect(fn('mountLibraryShare')).toMatch(/Sharing ended when this folder was deleted/);
    expect(fn('mountLibraryShare')).toMatch(/data-ls-again/);
  });
});

describe('after a folder operation', () => {
  test('the library shape is refreshed too, not just the file list', () => {
    expect(fn('afterFolderChange')).toMatch(/loadLibraries\(\)\.catch/);
    for (const f of ['renameFolder', 'moveFolderToParent', 'deleteFolder', 'moveItemsIntoFolder']) {
      expect([f, /afterFolderChange\(\)/.test(fn(f))]).toEqual([f, true]);
    }
  });

  test('a busy library and a stale answer are explained, not shown as raw errors', () => {
    const msg = fn('folderOpMessage');
    expect(msg).toMatch(/LIBRARY_BUSY/);
    expect(msg).toMatch(/CHANGED/);
    for (const f of ['renameFolder', 'moveFolderToParent', 'deleteFolder', 'moveItemsIntoFolder']) {
      expect([f, /folderOpMessage\(e\)/.test(fn(f))]).toEqual([f, true]);
    }
  });

  test('a multi-select delete that was refused does not then claim success', () => {
    expect(fn('deleteSelectedItems')).toMatch(/if \(refused >= folders\.length \+ files\.length\) return;/);
  });
});

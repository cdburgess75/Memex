'use strict';
// The text editor and library sharing (index.html): what helpdesk asked for in October 2026.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const html = fs.readFileSync(path.join(__dirname, '../../../index.html'), 'utf8');
const fnText = (name) => {
  const start = html.search(new RegExp(`^(async )?function ${name}\\(`, 'm'));
  if (start < 0) throw new Error(`${name} not found in index.html`);
  return html.slice(start, html.indexOf('\n}\n', start) + 3);
};

test('the page and the server agree on which files the editor opens', () => {
  const page = vm.runInNewContext(html.match(/const TEXT_EDIT_EXTS = \[[\s\S]*?\];/)[0] + '\nTEXT_EDIT_EXTS');
  expect([...page]).toEqual(require('../../lib/textTypes').EDITABLE_TEXT_EXTS);
  for (const ext of ['config', 'conf', 'html', 'php']) expect(page).toContain(ext);
});

test('a file opened from search takes its type from its own name', () => {
  const body = fnText('previewFile');
  expect(body).toMatch(/const ext = fileExt\(f \? f\.name : String\(data\.name \|\| ''\)\)/);
  expect(body.indexOf("apiGet('/files/' + fileId + '/url')")).toBeLessThan(body.indexOf('const ext = '));
  expect(fnText('renderContentSearchResults')).toContain('rememberFiles(rows)');
});

test('editing is judged in the file\'s own library', () => {
  const ctx = {
    currentUser: { id: 'me', role: 'contributor' },
    librariesList: [{ id: 'A', add_right: null, my_folders: [] }, { id: 'B', add_right: 'grant', my_folders: [] }],
    currentLibrary: () => ({ id: 'A', add_right: null, my_folders: [] }),
  };
  vm.runInNewContext(`${fnText('canWriteHere')}\n${fnText('canChangeFile')}\nthis.can = canChangeFile;`, ctx);
  expect(ctx.can({ name: 'x.txt', library_id: 'B', library_scoped: true })).toBe(true);    // found by search, in a library you can write to
  expect(ctx.can({ name: 'x.txt', library_id: 'A', library_scoped: true })).toBe(false);
});

describe('autosave', () => {
  const make = (on) => {
    const store = new Map([['memex_editor_autosave', on ? '1' : '0']]);
    const puts = [];
    const ctx = {
      localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
      apiPut: async (url, body) => { puts.push([url, body]); return {}; },
      findFile: () => null, toast: () => {}, Blob, setTimeout, clearTimeout, puts,
    };
    vm.runInNewContext(`let _codeEd = null;\n${html.slice(html.indexOf('const CODE_ED_AUTOSAVE_MS'), html.indexOf('function codeEdSaved() {'))}
      this.flush = codeEdFlush; this.set = (v) => { _codeEd = v; };`, ctx);
    return ctx;
  };
  test('closing a file saves what was typed, when autosave is on', async () => {
    const c = make(true);
    c.set({ fileId: 'f1', canEdit: true, saved: 'old', value: 'new' });
    c.flush(); await new Promise(r => setTimeout(r, 0));
    expect(c.puts).toEqual([['/files/f1/content', { content: 'new' }]]);
  });
  test('nothing is saved when it is off, or nothing changed, or the file is read-only', async () => {
    for (const [on, ed] of [[false, { fileId: 'f', canEdit: true, saved: 'a', value: 'b' }], [true, { fileId: 'f', canEdit: true, saved: 'a', value: 'a' }], [true, { fileId: 'f', canEdit: false, saved: 'a', value: 'b' }]]) {
      const c = make(on); c.set(ed); c.flush(); await new Promise(r => setTimeout(r, 0));
      expect(c.puts).toEqual([]);
    }
  });
  test('the editor has the checkbox, and the dialog saves on close', () => {
    expect(html).toContain('id="code-ed-autosave"');
    expect(html).toContain("openModal({ id: 'file-preview-scrim', onClose: codeEdFlush,");
  });
});

test('sharing a whole library asks first; sharing a folder does not', () => {
  const body = html.slice(html.indexOf('  async function add() {'), html.indexOf('  // What a change does, from the server'));
  expect(body).toMatch(/if \(!folderPath\) \{[\s\S]*askConfirm\([\s\S]*Share all of[\s\S]*if \(!ok\) return;/);
  expect(body.indexOf('askConfirm(')).toBeLessThan(body.indexOf('apiPost('));
});

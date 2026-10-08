'use strict';
// Buttons that went nowhere. Each of these was a control the app offered that failed when
// used: a call to a function that did not exist, a saved setting read back wrong, a choice
// the server refuses to the person being offered it, an option the server ignored.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
// Both come with jest (babel-jest), so nothing is added to the server to run this.
const { parse } = require('@babel/parser');
const traverse = require('@babel/traverse').default;

const html = fs.readFileSync(path.join(__dirname, '../../../index.html'), 'utf8');
const script = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
const block = (name) => { const s = html.search(new RegExp(`\\n(?:async )?function ${name}\\(`)); if (s < 0) throw new Error(`${name} not found`); let d = 0; const i = html.indexOf('{', s); for (let j = i; ; j++) { if (html[j] === '{') d++; else if (html[j] === '}' && --d === 0) return html.slice(s, j + 1); } };

describe('every function the app calls exists', () => {
  // The language's and the browser's own. Anything else called by bare name must be declared
  // in the app: `missing?.()` still throws a ReferenceError when `missing` was never declared.
  const BUILTIN = new Set(['Number', 'String', 'Boolean', 'Array', 'Object', 'Date', 'JSON', 'Math', 'Promise', 'Symbol', 'BigInt',
    'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI', 'atob', 'btoa',
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame', 'queueMicrotask',
    'fetch', 'getComputedStyle', 'matchMedia', 'alert', 'confirm', 'prompt', 'structuredClone']);
  let top;
  const unknown = new Set();
  const note = (p) => { const c = p.node.callee; if (c.type === 'Identifier' && !p.scope.hasBinding(c.name, true) && !BUILTIN.has(c.name)) unknown.add(c.name); };
  traverse(parse(script, { sourceType: 'script' }), { Program(p) { top = p.scope; }, CallExpression: note, OptionalCallExpression: note });

  test('in the script', () => expect([...unknown].sort()).toEqual([]));

  test('in the inline handlers (onclick="…" and the like)', () => {
    const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'X']);
    const missing = new Set();
    for (const m of html.matchAll(/\son[a-z]+="([^"]*)"/g)) {
      const code = m[1].replace(/\$\{[^}]*\}/g, 'X'); // a spliced-in name is not checked here
      for (const c of code.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*(?:\?\.)?\(/g)) {
        if (!KEYWORDS.has(c[1]) && !BUILTIN.has(c[1]) && !top.hasBinding(c[1], true)) missing.add(c[1]);
      }
    }
    expect([...missing].sort()).toEqual([]);
  });
});

// The move/copy dialog, run: the requests it makes, and what it leaves selected.
describe('moving and copying to another library', () => {
  const run = async (start, { files = [], folders = [] } = {}) => {
    const posts = [], toasts = [];
    let cleared = 0, title = '';
    const pick = { dataset: { lib: 'dest' } };
    const ctx = {
      librariesList: [{ id: 'src', name: 'Here', add_right: true }, { id: 'dest', name: 'Clients', add_right: true }],
      currentLibraryId: 'src',
      filesList: [{ id: 7, name: 'Plans/a.pdf' }, { id: 8, name: 'b.txt' }],
      selectedFileIds: new Set(files.map(String)), selectedFolderPaths: new Set(folders),
      closeLibraryMenu() {}, loadFiles: async () => {},
      toast: (m) => toasts.push(m),
      clearFileSelection: () => { cleared++; },
      fileDisplayName: (f) => f.name.split('/').pop(),
      openModal: ({ html: h }) => { title = h.match(/<h2>(.*?)<\/h2>/)[1]; return { el: { querySelector: () => ({}), querySelectorAll: () => [pick] }, close() {} }; },
      apiPost: async (url, body) => { posts.push([url, body]); return { count: 3 }; },
      String, Number, Set,
    };
    vm.runInNewContext(`${['esc', 'inFolderLib', 'transferSummary', 'openLibraryTransfer', 'moveFolderToLibrary', 'copyFolderToLibrary', 'moveFileToLibrary'].map(block).join('\n')}
      function selectedFiles() { return filesList.filter(f => selectedFileIds.has(String(f.id))); }
      function findFile(id) { return filesList.find(f => String(f.id) === String(id)) || null; }
      function selectedFolders() { return [...selectedFolderPaths]; }
      this.start = () => ${start};`, ctx);
    ctx.start();
    await pick.onclick();
    return { posts, toasts, cleared, title };
  };

  test("a folder's own menu copies it (the whole folder, from the library it is in)", async () => {
    const r = await run(`copyFolderToLibrary('Plans/2026')`);
    expect(r.title).toBe('Copy “2026”');
    expect(r.posts).toEqual([['/files/folder/copy', { path: 'Plans/2026', library_id: 'dest', source_library_id: 'src' }]]);
    expect(r.toasts.pop()).toBe('Copied 1 item to Clients');
  });
  test("…and moves it, without touching what is selected", async () => {
    const r = await run(`moveFolderToLibrary('Plans/2026')`, { files: [8] });
    expect(r.posts).toEqual([['/files/folder/move', { path: 'Plans/2026', library_id: 'dest', source_library_id: 'src' }]]);
    expect(r.cleared).toBe(0);
  });
  test("a file's own menu moves that file, and not the folders that happen to be selected", async () => {
    const r = await run(`moveFileToLibrary('7')`, { folders: ['Plans'] });
    expect(r.title).toBe('Move “a.pdf”');
    expect(r.posts).toEqual([['/files/library-transfer', { ids: [7], libraryId: 'dest', mode: 'move' }]]);
  });
  test('the command bar copies selected folders as well as files, then clears the selection', async () => {
    const r = await run(`openLibraryTransfer('copy')`, { files: [8], folders: ['Plans'] });
    expect(r.title).toBe('Copy 2 items');
    expect(r.posts).toEqual([
      ['/files/library-transfer', { ids: [8], libraryId: 'dest', mode: 'copy' }],
      ['/files/folder/copy', { path: 'Plans', library_id: 'dest', source_library_id: 'src' }],
    ]);
    expect(r.cleared).toBe(1);
  });
  test('copying is not offered to viewers (the server refuses them), and is offered for folders', () => {
    for (const fn of ['fileLibraryCommandBarHtml', 'openFolderMenu']) {
      const b = block(fn);
      expect(b).toMatch(/const canCopy = currentUser\?\.role !== 'viewer'/);
      expect(b).toMatch(/canCopy \? `<button[^`]*(openLibraryTransfer\('copy'\)|copyFolderToLibrary\(folderMenuPath\))/);
    }
  });
});

describe('renaming a library, putting one away', () => {
  const run = async (fn, { fails = false } = {}) => {
    const toasts = [];
    let redrawn = 0;
    const call = async () => { if (fails) throw new Error('nope'); return {}; };
    const ctx = {
      librariesList: [{ id: 'L1', name: 'Old' }], String, encodeURIComponent,
      askPrompt: async () => 'New', askConfirm: async () => true,
      apiPatch: call, apiPut: call, loadLibraries: async () => {},
      redrawAfterLibraryChange: () => { redrawn++; },
      toast: (m) => toasts.push(m),
    };
    vm.runInNewContext(`${block('renameLibrary')}\n${block('setLibraryArchived')}\nthis.go = () => ${fn};`, ctx);
    await ctx.go();
    return { toasts, redrawn };
  };
  test('a rename that saved says so once, and the page is drawn again', async () => {
    expect(await run(`renameLibrary('L1')`)).toEqual({ toasts: ['Renamed'], redrawn: 1 });
  });
  test('a rename that failed says only that', async () => {
    expect(await run(`renameLibrary('L1')`, { fails: true })).toEqual({ toasts: ['Rename failed: nope'], redrawn: 0 });
  });
  test('putting it away, and bringing it back', async () => {
    expect(await run(`setLibraryArchived('L1', true)`)).toEqual({ toasts: ['Put away'], redrawn: 1 });
    expect(await run(`setLibraryArchived('L1', false)`)).toEqual({ toasts: ['Brought back'], redrawn: 1 });
    expect(await run(`setLibraryArchived('L1', true)`, { fails: true })).toEqual({ toasts: ['Failed: nope'], redrawn: 0 });
  });
});

describe('the view-size slider comes back where it was left', () => {
  const line = html.match(/^let fileViewSize = .*$/m)[0];
  const load = (saved) => {
    const ctx = { localStorage: { getItem: () => saved }, parseInt };
    vm.runInNewContext(`${line}\nthis.v = fileViewSize;`, ctx);
    return ctx.v;
  };
  const stops = Number(html.match(/<input type="range" class="fvs-range" min="0" max="(\d+)"/)[1]);
  test('every stop on the slider', () => { for (let s = 0; s <= stops; s++) expect(load(String(s))).toBe(s); });
  test('anything else is List', () => { for (const v of [null, '', 'x', '-1', String(stops + 1)]) expect(load(v)).toBe(1); });
});

describe('the AI model', () => {
  const run = (role, act) => {
    const puts = [];
    const ctx = {
      currentUser: { role }, aiModels: [{ provider: 'anthropic', id: 'claude-sonnet-5', label: 'Sonnet 5' }], aiActive: 'anthropic:claude-sonnet-5',
      closeSearchControlMenu() {}, renderAiModelLabel() {}, renderSearchScope() {}, toast() {},
      apiPut: async (u, b) => { puts.push([u, b]); },
    };
    vm.runInNewContext(`${['esc', 'escAttr', 'aiModelShortLabel', 'aiModelMenuInnerHtml', 'switchAiModel'].map(block).join('\n')}\nthis.menu = aiModelMenuInnerHtml; this.pick = switchAiModel;`, ctx);
    return act(ctx, puts);
  };
  test('is switched only by an administrator, who is told it is for everyone', async () => {
    const menu = run('admin', (c) => c.menu());
    expect(menu).toContain('data-model="anthropic:claude-sonnet-5" onclick="switchAiModel(this.dataset.model)"');
    expect(menu).toContain('applies to everyone');
    expect(await run('admin', async (c, puts) => { await c.pick('off'); return puts; })).toEqual([['/ai/active', { model: 'off' }]]);
  });
  test.each(['contributor', 'viewer'])('a %s is told which one is in use, and offered nothing to switch', async (role) => {
    const menu = run(role, (c) => c.menu());
    expect(menu).not.toMatch(/switchAiModel|<button/);
    expect(menu).toContain('In use: Sonnet 5.');
    expect(await run(role, async (c, puts) => { await c.pick('off'); return puts; })).toEqual([]);
  });
});

describe('what the server would refuse or ignore is not offered', () => {
  test('Ask the collection has no "file the answer" (the server never did)', () => {
    expect(block('openCollectionAsk')).not.toMatch(/file answer/i);
    expect(html).not.toMatch(/fileIt/);
  });
  test('Trash is not in a viewer\'s rail, and a link to it lands on Files', () => {
    expect(block('fileHomeNav')).toMatch(/currentUser\?\.role === 'viewer' \? '' : fileNavButton\('Trash'/);
    expect(block('setFileView')).toMatch(/if \(view === 'trash' && currentUser\?\.role === 'viewer'\) view = 'active';/);
  });
  test('the ScreenConnect setting is sent where it now lives', () => {
    expect(html).not.toMatch(/System → Integrations/);
    expect(block('launchRemote')).toContain('Settings → Branding & links');
    expect(block('settingsTabsList')).toContain("{ id: 'workspace', label: 'Branding & links' }");
    expect(block('switchSettingsTab')).toMatch(/tab === 'workspace'\) body\.innerHTML = [^\n]*systemSections\('Integrations'\)/);
  });
});

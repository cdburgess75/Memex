'use strict';
// A text file in its own browser tab, and autosave on by default (index.html): the route,
// which tab a file opens in, the document window's header, saving with a revision, what
// happens when the file changed elsewhere, and the autosave timing.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const html = fs.readFileSync(path.join(__dirname, '../../../index.html'), 'utf8');
const fnText = (name) => {
  const start = html.search(new RegExp(`^(async )?function ${name}\\(`, 'm'));
  if (start < 0) throw new Error(`${name} not found in index.html`);
  return html.slice(start, html.indexOf('\n}\n', start) + 3);
};
const UUID = '11111111-1111-4111-8111-111111111111';
const base = () => ({
  OPEN_ID: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, OPEN_TOKEN: /^[A-Za-z0-9_-]{16,}$/,
  brandDefaults: { name: 'Acme Co.', logo: '' }, DEPOT_MARK: '<svg class="mark"></svg>',
  location: { hash: '', pathname: '/', search: '' }, sessionStorage: { getItem: () => null, removeItem: () => {} },
  TEXT_EDIT_EXTS: ['txt', 'md', 'json'], Date, encodeURIComponent, decodeURIComponent, Object, console,
});
const load = (names, over = {}) => { const ctx = { ...base(), ...over }; vm.runInNewContext(['esc', 'escAttr', ...names].map(fnText).join('\n'), ctx); return ctx; };

describe('the route', () => {
  const c = load(['hashToNav', 'docWindowTarget']);
  test('#/edit/file/<id> names a file for its own tab; anything else under edit is nothing', () => {
    expect(c.hashToNav(`#/edit/file/${UUID}`)).toEqual({ tab: 'files', view: 'active', filter: 'all', folder: '', edit: { file: UUID } });
    expect(c.hashToNav('#/edit/file/not-an-id')).toBeNull();
    expect(c.hashToNav(`#/edit/folder/${UUID}`)).toBeNull();
    expect(c.hashToNav(`#/open/file/${UUID}`).open).toEqual({ file: UUID });
  });
  test('the document window target comes from the address, or from the address kept across sign-in', () => {
    c.location.hash = `#/edit/file/${UUID}`;
    expect(c.docWindowTarget()).toBe(UUID);
    c.location.hash = '';
    c.sessionStorage.getItem = () => `#/edit/file/${UUID}`;
    expect(c.docWindowTarget()).toBe(UUID);
    c.sessionStorage.getItem = () => '#/files';
    expect(c.docWindowTarget()).toBeNull();
  });
  test('the app boots into the document window and loads nothing else of the app', () => {
    const after = fnText('_afterLogin');
    expect(after).toContain("const docWindowId = docWindowTarget();");
    expect(after).toMatch(/if \(docWindowId\) \{ currentUser = await apiGet\('\/auth\/me'\)\.catch\(\(\) => null\); await openDocumentWindow\(docWindowId\); return; \}/);
    expect(after.indexOf('docWindowTarget()')).toBeLessThan(after.indexOf('ensureMediaTicket()'));
    expect(fnText('navApply')).toContain('if (s.edit) { await openDocumentWindow(s.edit.file); return; }');
  });
});

describe('opening a tab', () => {
  test('the preview offers "Open in a tab" for a text file, and new text files open in one', () => {
    const preview = fnText('previewFile');
    expect(preview).toContain(`const tabBtn = isText ? \`<button class="ghost-btn" onclick="openTextTab('\${fileId}');closeFilePreview()"`);
    expect(preview).toContain('${primaryBtn}${tabBtn}${openWith}');
    expect(preview).toContain("t = await apiGet('/files/' + fileId + '/text')"); // the content and its revision come together
    const create = fnText('createFile');
    expect(create).toContain('const tab = TEXT_EDIT_EXTS.includes(ext) ? openTextTab(null) : null;');
    expect(create.indexOf('openTextTab(null)')).toBeLessThan(create.indexOf('await ensureFilesView()')); // opened while the click still counts
    expect(create).toContain('if (tab) { tab.location.href = textTabUrl(doc.id);');
    expect(create).toContain('catch (e) { if (tab) tab.close(); throw e; }');
  });
  test('Cmd/Ctrl-click and the middle button open a text file in a tab; a plain click previews', () => {
    const calls = [];
    const c = load(['openFileDefault', 'openFileAux'], {
      isTextFileId: (id) => id === UUID, openTextTab: (id) => calls.push(['tab', id]), previewFile: (id) => calls.push(['preview', id]),
    });
    c.openFileDefault(UUID, { metaKey: true, preventDefault() {} });
    c.openFileDefault(UUID, {});
    c.openFileDefault('22222222-2222-4222-8222-222222222222', { ctrlKey: true, preventDefault() {} }); // not a text file: previews
    c.openFileAux(UUID, { button: 1, preventDefault() {} });
    c.openFileAux(UUID, { button: 0, preventDefault() {} });
    expect(calls).toEqual([['tab', UUID], ['preview', UUID], ['preview', '22222222-2222-4222-8222-222222222222'], ['tab', UUID]]);
    const u = load(['textTabUrl'], { findFile: (id) => ({ id, name: 'notes.md' }), fileExt: (n) => n.split('.').pop() }); // one-line helpers share a chunk; only the url is called
    expect(u.textTabUrl(UUID)).toBe(`/#/edit/file/${UUID}`);
    expect(u.isTextFileId(UUID)).toBe(true);
    expect(html.match(/onclick="openFileDefault\(this\.dataset\.fid, event\)" onauxclick="openFileAux\(this\.dataset\.fid, event\)"/g).length).toBeGreaterThanOrEqual(3);
  });
});

describe('the document window', () => {
  const file = { id: UUID, name: 'plan.md', path: 'Notes/2026/plan.md', folder: 'Notes/2026', library: { id: '33333333-3333-4333-8333-333333333333', name: 'Projects' }, content: 'x', revision: 'r1', can_edit: true, too_big: false };
  test('the header names the file and where it lives, offers Save to someone who may edit, and the editor is the shared one', () => {
    const c = load(['docWindowBrandHtml', 'docWindowHtml', 'codeEdHtml']);
    const h = c.docWindowHtml(file);
    expect(h).toContain('<strong id="doc-window-name" title="Notes/2026/plan.md">plan.md</strong>');
    expect(h).toContain('Projects › Notes › 2026');
    expect(h).toContain('href="/#/open/lib/33333333-3333-4333-8333-333333333333/Notes/2026" target="_blank"');
    expect(h).toContain(`<button class="run-btn" id="doc-window-save" onclick="saveFileText('${UUID}')">Save</button>`);
    expect(h).toContain('<span class="brand-name">Acme Co.</span>');
    expect(h).toContain('<textarea class="file-preview-edit" id="file-edit-text"');
    expect(h).not.toContain(' readonly placeholder');
    expect(h).toContain('<span class="code-ed-clash" id="code-ed-clash" hidden>This file changed elsewhere.');
    expect(h).toContain('id="code-ed-autosave"');
  });
  test('read-only for a viewer or a file too big to edit: no Save, a read-only box', () => {
    const c = load(['docWindowBrandHtml', 'docWindowHtml', 'codeEdHtml']);
    const h = c.docWindowHtml({ ...file, can_edit: false, library: null, folder: '' });
    expect(h).not.toContain('id="doc-window-save"');
    expect(h).toContain(' readonly placeholder');
    expect(h).not.toContain('doc-window-place');
    const open = fnText('openDocumentWindow');
    expect(open).toContain("note: t.too_big ? 'Too large to edit here: showing the first part only. Download it to edit.' : !t.can_edit ? 'Read only' : ''");
    expect(open).toContain("document.title = `${t.name} – ${brandDefaults.name || 'Depot'}`");
    expect(open).toContain("document.documentElement.classList.add('doc-window-mode')");
    expect(html).toContain('.doc-window-mode .masthead, .doc-window-mode .shell, .doc-window-mode .skip-link { display: none !important; }');
  });
});

describe('saving', () => {
  const ctxFor = (apiPut, over = {}) => {
    const ta = { value: 'new text', readOnly: false };
    const st = { textContent: '', className: '' };
    const clashBar = { hidden: true };
    const calls = { clash: [], toast: [] };
    const c = load(['saveFileText', 'codeEdClash'], {
      document: { getElementById: (id) => ({ 'file-edit-text': ta, 'code-ed-state': st, 'code-ed-clash': clashBar }[id] || null) },
      _textSaving: null, _codeEd: { fileId: UUID, saved: 'old', value: 'new text', canEdit: true, revision: 'r1', clash: false, dirtySince: 5 },
      _codeEdAutoTimer: null, clearTimeout: () => {}, apiPut, findFile: () => null, toast: (m) => calls.toast.push(m), codeEdLines: () => {}, renderDocumentLibraryList: () => {}, ...over,
    });
    return { c, ta, st, clashBar, calls };
  };
  test('a save carries the revision it started from, and takes the new one back', async () => {
    const sent = [];
    const { c } = ctxFor(async (p, body) => { sent.push([p, body]); return { ok: true, revision: 'r2' }; });
    await c.saveFileText(UUID, { auto: true });
    expect(sent).toEqual([[`/files/${UUID}/content`, { content: 'new text', base_revision: 'r1', force: false }]]);
    expect(c._codeEd).toMatchObject({ saved: 'new text', revision: 'r2', dirtySince: null });
    expect(c.document.getElementById('code-ed-state').textContent).toBe('Saved automatically');
  });
  test('refused because the file changed elsewhere: the bar appears, autosave stops, and "Keep mine" forces it', async () => {
    const sent = [];
    const { c, st, clashBar, calls } = ctxFor(async (p, body) => { sent.push(body); if (!body.force) { const e = new Error('This file changed since you opened it'); e.status = 409; e.body = { code: 'FILE_CHANGED', revision: 'r9' }; throw e; } return { ok: true, revision: 'r10' }; });
    await c.saveFileText(UUID);
    expect(c._codeEd.clash).toBe(true); expect(c._codeEd.theirRevision).toBe('r9'); expect(c._codeEd.saved).toBe('old');
    expect(clashBar.hidden).toBe(false); expect(st).toEqual({ textContent: 'Changed elsewhere', className: 'warn' });
    expect(calls.toast).toEqual([]);
    await c.saveFileText(UUID); // nothing: the bar decides first
    expect(sent).toHaveLength(1);
    vm.runInNewContext(fnText('codeEdOverwrite'), c);
    c.codeEdOverwrite(UUID);
    await new Promise((r) => setImmediate(r));
    expect(sent[1]).toMatchObject({ force: true, base_revision: 'r1' });
    expect(c._codeEd).toMatchObject({ clash: false, revision: 'r10', saved: 'new text' });
  });
  test('"Use theirs" replaces the text with the saved copy', async () => {
    const ta = { value: 'mine' };
    const c = load(['codeEdReload'], {
      document: { getElementById: (id) => ({ 'file-edit-text': ta, 'code-ed-clash': { hidden: false }, 'code-ed-state': {} }[id] || null) },
      _codeEd: { fileId: UUID, value: 'mine', saved: 'old', revision: 'r1', clash: true }, apiGet: async () => ({ content: 'theirs', revision: 'r9' }),
      codeEdLines: () => {}, codeEdCursor: () => {}, toast: () => {},
    });
    await c.codeEdReload(UUID);
    expect(ta.value).toBe('theirs');
    expect(c._codeEd).toMatchObject({ value: 'theirs', saved: 'theirs', revision: 'r9', clash: false });
  });
});

describe('autosave', () => {
  test('is on unless switched off, and is remembered per browser', () => {
    expect(html).toContain("const codeEdAutosaveOn = () => { try { return localStorage.getItem('memex_editor_autosave') !== '0'; } catch { return true; } };");
    expect(fnText('codeEdSetAutosave')).toContain("localStorage.setItem('memex_editor_autosave', on ? '1' : '0')");
  });
  test('waits 3 seconds after typing stops, but no longer than 30 seconds after the first unsaved change', () => {
    const delays = [];
    const now = 1_000_000;
    const c = load(['codeEdAutosaveSoon'], {
      setTimeout: (fn, ms) => { delays.push(ms); return 1; }, clearTimeout: () => {}, Date: { now: () => now },
      localStorage: { getItem: () => null }, CODE_ED_AUTOSAVE_MS: 3000, CODE_ED_AUTOSAVE_MAX_MS: 30000, _codeEdAutoTimer: null,
      _codeEd: { fileId: UUID, canEdit: true, clash: false, dirtySince: null },
    });
    vm.runInNewContext("const codeEdAutosaveOn = () => localStorage.getItem('memex_editor_autosave') !== '0';", c);
    c.codeEdAutosaveSoon();
    expect(c._codeEd.dirtySince).toBe(now);
    c._codeEd.dirtySince = now - 31000; c.codeEdAutosaveSoon();
    c._codeEd.clash = true; c.codeEdAutosaveSoon();
    expect(delays).toEqual([3000, 0]);
  });
  test('the last changes go with the tab: saved on close or hide with autosave on, asked about with it off', () => {
    expect(html).toContain("window.addEventListener('beforeunload', (e) => {\n  if (!_codeEd?.canEdit || _codeEd.value === _codeEd.saved) return;\n  if (codeEdAutosaveOn() && !_codeEd.clash) { codeEdFlush(); return; }\n  e.preventDefault(); e.returnValue = '';\n});");
    expect(html).toContain("window.addEventListener('pagehide', () => codeEdFlush());");
    expect(html).toContain("document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') codeEdFlush(); });");
    expect(fnText('codeEdFlush')).toContain("{ keepalive: content.length < 60000 }");
    expect(fnText('apiPut')).toContain('keepalive,');
  });
});

test('every inline script still parses', () => {
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g; let m, n = 0;
  while ((m = re.exec(html))) { n++; expect(() => new vm.Script(m[1])).not.toThrow(); }
  expect(n).toBeGreaterThan(0);
});

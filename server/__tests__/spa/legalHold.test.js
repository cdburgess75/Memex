'use strict';
// Retention and legal holds in the app: the lock mark on what is held, the Retention and
// Legal hold rows in the menus (the second for administrators only), the Compliance
// window's fix pointers opening their own dialogs, and the plain words the dialogs use.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const html = fs.readFileSync(path.join(__dirname, '../../../index.html'), 'utf8');
const fn = (name) => {
  const s = html.search(new RegExp(`^(async )?function ${name}\\(`, 'm'));
  if (s < 0) throw new Error(`${name} not found`);
  let d = 0; const i = html.indexOf(') {', s) + 2;   // the body's brace, past a destructured parameter's
  for (let j = i; ; j++) { if (html[j] === '{') d++; else if (html[j] === '}' && --d === 0) return html.slice(s, j + 1); }
};
const line = (re) => html.match(re)[0];
const base = () => [line(/^function esc\(.*$/m), line(/^function escAttr\(.*$/m), line(/^const ICON_HOLD = .*$/m), fn('holdMark'), fn('folderHoldHere'), fn('folderHoldTag')].join('\n');

describe('the lock mark', () => {
  const ctx = (holds) => { const c = { normalizeFilePath: (p) => String(p || '').replace(/^\/+|\/+$/g, ''), libraryHolds: { holds } }; vm.runInNewContext(base(), c); return c; };
  test('says what it means in words, and escapes them', () => {
    const c = ctx([]);
    expect(c.holdMark('')).toBe('');
    const m = c.holdMark('Under a "legal" hold');
    expect(m).toMatch(/^<span class="hold-mark" title="Under a &quot;legal&quot; hold" aria-label="Under a &quot;legal&quot; hold"><svg/);
  });
  test('a folder is marked under a hold on it, on a folder above it, or on the whole library; not beside it', () => {
    const c = ctx([{ scope: 'folder', folder_path: 'Clients/Smith', reason: 'Smith v. Jones' }]);
    expect(c.folderHoldTag('Clients/Smith')).toMatch(/Smith v\. Jones/);
    expect(c.folderHoldTag('Clients/Smith/2024')).toMatch(/hold-mark/);
    expect(c.folderHoldTag('Clients/Smithson')).toBe('');
    expect(c.folderHoldTag('Clients')).toBe('');
    expect(c.folderHoldHere('Clients/Smith')).toBeTruthy();
    expect(c.folderHoldHere('Clients/Smith/2024')).toBeNull();
    expect(ctx([{ scope: 'library' }]).folderHoldTag('Anything')).toMatch(/whole library/);
  });
  test('a file row and a card carry the mark when the server says held', () => {
    const c = { ...{ normalizeFilePath: (p) => p, libraryHolds: { holds: [] } }, fileExt: () => 'pdf', fileFolderPath: () => '', fileVisibleCols: new Set(['size']), fileRowIconHtml: () => '', fileDisplayName: (f) => f.name, fileSizeLabel: () => '1 KB', fileDate: () => 'today', selectedFileIds: new Set(), favoriteFileIds: new Set(), fileCardThumbHtml: () => '', ICON_MORE: '' };
    vm.runInNewContext(`${base()}\n${fn('fileNameCellHtml')}\n${fn('fileCardHtml')}\nthis.row = fileNameCellHtml({ id: 1, name: 'a.pdf', held: true }); this.plain = fileNameCellHtml({ id: 2, name: 'b.pdf', held: false }); this.card = fileCardHtml({ id: 1, name: 'a.pdf', held: true });`, c);
    expect(c.row).toMatch(/a\.pdf<span class="hold-mark" title="Under a legal hold: it cannot be deleted, replaced or moved"/);
    expect(c.plain).not.toContain('hold-mark');
    expect(c.card).toContain('hold-mark');
  });
});

describe('the menus', () => {
  const menu = (role, held) => {
    const c = { currentUser: { role }, findFile: () => ({ id: 'f1', name: 'a.pdf', held }), fileExt: () => 'pdf', OFFICE_EXTS: [], PREVIEW_EXTS: [], canChangeFile: () => true, closeFileMenu() {}, aiOff: () => true, appConfig: {},
      document: { createElement: () => ({ style: {}, getBoundingClientRect: () => ({ width: 10, height: 10 }), set innerHTML(v) { c.items = v; } }), body: { appendChild() {} }, addEventListener() {} }, window: { innerWidth: 800, innerHeight: 600 } };
    vm.runInNewContext(`${base()}\n${fn('openFileMenu')}\nopenFileMenu('f1');`, c);
    return c.items;
  };
  test('a file: Legal hold… for an administrator only, worded for what is already held', () => {
    expect(menu('admin', false)).toMatch(/openLegalHold\(\{ scope: 'document', fileId: this\.dataset\.fid \}\)">Legal hold…</);
    expect(menu('admin', true)).toContain('Legal hold (in place)…');
    expect(menu('contributor', false)).not.toContain('Legal hold');
  });
  test('the file id travels in a data attribute, never spliced into the handler', () => {
    expect(menu('admin', false)).toMatch(/data-fid="f1" onclick="closeFileMenu\(\);openLegalHold\(\{ scope: 'document', fileId: this\.dataset\.fid \}\)"/);
  });
});

describe('the Compliance window points at the dialogs', () => {
  test('retention and holds open their own dialogs, not a Settings tab', () => {
    const c = { closeComplianceStatus: jest.fn(), openSettingsAt: jest.fn(), openRetentionOverview: jest.fn(), openLegalHolds: jest.fn() };
    vm.runInNewContext(`${line(/^const CMP_FIX = \{[\s\S]*?^\};/m)}\n${fn('cmpFix')}\ncmpFix('retention'); cmpFix('holds'); cmpFix('backup'); this.labels = [CMP_FIX.retention[1], CMP_FIX.holds[1]];`, c);
    expect(c.openRetentionOverview).toHaveBeenCalledTimes(1);
    expect(c.openLegalHolds).toHaveBeenCalledTimes(1);
    expect(c.openSettingsAt).toHaveBeenCalledWith('storage');
    expect(c.labels).toEqual(['Set how long files are kept', 'See and place legal holds']);
  });
  test('the retention dialog asks in years, in plain words, with the two examples the rules give', () => {
    const src = fn('openLibraryRetention');
    expect(src).toMatch(/Keep at least/);
    expect(src).toMatch(/Tax returns: 3 years\. Patient files: 6 years\./);
    expect(src).toMatch(/Move to the Trash after/);
    expect(src).toMatch(/told 30 days ahead/);
    expect(src).toMatch(/apiPut\('\/libraries\/' \+ encodeURIComponent\(lib\.id\) \+ '\/retention'/);
  });
  test('placing a hold asks for a reason and releasing one for a note; both say what a hold does', () => {
    const src = fn('openLegalHold');
    expect(src).toMatch(/Say what the hold is for/);
    expect(src).toMatch(/say why it is no longer needed/);
    expect(src).toMatch(/nothing in it can be deleted, deleted for good, replaced or moved, by anyone/);
    expect(src).toMatch(/apiPost\('\/admin\/legal-holds'/);
    expect(src).toMatch(/apiDelete\('\/admin\/legal-holds\/' \+ encodeURIComponent\(here\.id\), \{ note \}\)/);
  });
  test('a refusal reaches the person in the server\'s own sentence', () => {
    const c = {};
    vm.runInNewContext(`${fn('folderOpMessage')}\nthis.m = folderOpMessage({ body: { code: 'LEGAL_HOLD', error: 'This is under a legal hold, so it cannot be deleted.' }, message: 'HTTP 423' });`, c);
    expect(c.m).toBe('This is under a legal hold, so it cannot be deleted.');
  });
  test('the activity feed names the new events', () => {
    const c = {};
    vm.runInNewContext(`${line(/^const ACTIVITY_LABELS = \{[\s\S]*?^\};/m)}\nthis.l = ACTIVITY_LABELS;`, c);
    expect(c.l.hold_placed).toBe('Legal hold placed');
    expect(c.l.hold_released).toBe('Legal hold released');
    expect(c.l.disposed).toBe('Moved to trash by retention policy');
    expect(c.l.retention_policy_set).toBe('Retention policy set');
  });
});

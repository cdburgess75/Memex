'use strict';
// In-browser editing is a switch (off by default). While it is off, nothing on the page
// may offer it: no Edit button, no "Edit in browser" entry, no "Open in" menu, and no
// New Word / New Excel document (those open straight into the editor).
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '../../../index.html'), 'utf8');
// A function's text up to the next top-level function (block() counts braces, which the
// `opts = {}` default in previewFile's signature defeats).
const fnText = (name) => { const s = html.search(new RegExp(`\\n(?:async )?function ${name}\\(`)); if (s < 0) throw new Error(`${name} not found`); const e = html.slice(s + 1).search(/\n(?:async )?function /); return html.slice(s, e < 0 ? undefined : s + 1 + e); };
const block = (name) => { const s = html.search(new RegExp(`\\n(?:async )?function ${name}\\(`)); if (s < 0) throw new Error(`${name} not found`); let d = 0; const i = html.indexOf('{', s); for (let j = i; ; j++) { if (html[j] === '{') d++; else if (html[j] === '}' && --d === 0) return html.slice(s, j + 1); } };

describe('the Create menu', () => {
  function createMenu(editingEnabled) {
    const ctx = { out: '' };
    vm.runInNewContext(`${block('esc')}
      const currentFolderPath = ''; const currentLibraryId = 'L1';
      const currentUser = { role: 'contributor' };
      const canWriteHere = () => true;
      const currentLibrary = () => ({ personal: false, shared: true });
      const appConfig = { editingEnabled: ${editingEnabled} };
      ${block('fileCommandCreateUploadHtml')}
      this.out = fileCommandCreateUploadHtml();`, ctx);
    return ctx.out;
  }
  test('offers New Word / New Excel only while editing is on', () => {
    const on = createMenu(true), off = createMenu(false);
    expect(on).toContain('New Word document');
    expect(on).toContain('New Excel spreadsheet');
    expect(off).not.toContain('New Word document');
    expect(off).not.toContain('New Excel spreadsheet');
    // The rest of the menu is unchanged either way.
    for (const item of ['New folder', 'New Markdown file', 'New Text file']) { expect(on).toContain(item); expect(off).toContain(item); }
  });
});

describe('every other place editing is offered is gated on appConfig.editingEnabled', () => {
  test('the row menu', () => {
    expect(block('openFileMenu')).toMatch(/\(isOffice && appConfig\?\.editingEnabled\) \? `<button[^`]*editInBrowser\('\$\{fileId\}'\)">Edit in browser<\/button>` : ''/);
  });
  test('the preview: primary button and the Open in menu', () => {
    const preview = fnText('previewFile');
    expect(preview).toContain("const canEditInBrowser = !!appConfig?.editingEnabled;");
    // Desktop app takes the primary slot whenever editing is off, whatever the preference.
    expect(preview).toMatch(/else if \(isOfficeFile && \(appConfig\?\.defaultOfficeOpen === 'desktop' \|\| !canEditInBrowser\)\) primaryBtn = `<button[^`]*openInDesktopOffice/);
    expect(preview).toMatch(/else if \(isOfficeFile\) primaryBtn = `<button[^`]*editInBrowser/);
    expect(preview).toContain("const openWith = (isOfficeFile && canEditInBrowser) ?");
  });
  test('editInBrowser tells the person it is switched off, and stops offering it', () => {
    const fn = block('editInBrowser');
    expect(fn).toContain("if (appConfig) appConfig.editingEnabled = false;");
    expect(fn).toContain('switched off on this server');
    expect(fn).not.toContain('Collabora');
  });
});

describe('the Settings switch', () => {
  test('keeps asking while the editor is starting, stopping or reported failed, and stops once settled', () => {
    const render = block('renderEditorSwitch');
    expect(render).toContain("if (st.state !== 'on' && st.state !== 'off') editorSwitchTimer = setTimeout(loadEditorSwitch, 10000);");
    expect(render).toContain('clearTimeout(editorSwitchTimer)');
  });
  test('does not poll after Settings is closed', () => {
    expect(block('loadEditorSwitch')).toContain("classList.contains('open')");
  });
  test('has a sentence for every state the server reports', () => {
    const states = [...fs.readFileSync(path.join(__dirname, '../../lib/editorStatus.js'), 'utf8').matchAll(/state = [^\n]+/g)].join('\n');
    for (const s of ['off', 'stopping', 'lingering', 'starting', 'on', 'failed']) {
      expect(states).toContain(`'${s}'`);
      expect(html).toMatch(new RegExp(`^  ${s}: '`, 'm'));
    }
  });
});

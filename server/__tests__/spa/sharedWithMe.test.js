'use strict';
// The app's Shared to me page (index.html). No browser here: the page's section is
// lifted out of index.html and run in a sandbox against a stub DOM, and the call sites
// are checked by reading the source. The server decides every level; the page only words it.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '../../../index.html'), 'utf8');
const fnLine = (name) => {
  const m = html.match(new RegExp(`^function ${name}\\(.*$`, 'm'));
  if (!m) throw new Error(`${name} not found in index.html`);
  return m[0];
};
const section = (() => {
  const start = html.indexOf('// ---- Shared to me ----');
  const end = html.indexOf('async function renderShareLinks() {');
  if (start < 0 || end < start) throw new Error('Shared to me section not found');
  return html.slice(start, end);
})();

function page(answer) {
  const nodes = {};
  const calls = [];
  const ctx = {
    document: { getElementById: (id) => (nodes[id] ||= { innerHTML: '', querySelectorAll: () => [] }), querySelectorAll: () => [] },
    apiGet: async (p) => { calls.push(p); if (answer instanceof Error) throw answer; return answer; },
    fileHomeShell: (main) => main,
    fileSizeLabel: (n) => `${n} B`,
    fileDate: (d) => `on ${d}`,
    nodes, calls,
  };
  vm.runInNewContext(`${fnLine('esc')}\n${fnLine('escAttr')}\n${html.match(/^function emptyState\([\s\S]*?\n}\n/m)[0]}\n${section}
    this.renderSharedWithMe = renderSharedWithMe; this.swmShareLine = swmShareLine; this.swmLevel = swmLevel;`, ctx);
  return ctx;
}
const render = async (answer) => { const p = page(answer); await p.renderSharedWithMe(); return { body: p.nodes['swm-body'].innerHTML, calls: p.calls }; };

const LIB = { id: 'lib-1', name: 'Accounting', owner: { email: 'owner@acme.test', name: 'Olive Owner' } };
const base = { email_verified: true, is_admin: false, libraries: [], folders: [], files: [], truncated: { files: false } };
const share = (over = {}) => ({ share_id: 's1', via_group: null, permission: 'write', granted_by: { email: 'olive@acme.test', name: 'Olive' }, granted_at: '2026-09-01', ...over });

describe('the states', () => {
  test('asks the server, and says nothing is shared when nothing is', async () => {
    const { body, calls } = await render(base);
    expect(calls).toEqual(['/access/shared-with-me']);
    expect(body).toContain('Nothing is shared with you yet');
  });
  test('an unverified address is told why, and shown nothing', async () => {
    const { body } = await render({ ...base, email_verified: false, libraries: [{ library: LIB, level: 'read', effective: 'read', shares: [share()] }] });
    expect(body).toContain('hasn&#39;t been verified');
    expect(body).not.toContain('Accounting');
  });
  test('an error offers Try again', async () => {
    const { body } = await render(new Error('boom'));
    expect(body).toContain('Couldn&#39;t load what&#39;s shared with you.');
    expect(body).toContain('renderSharedWithMe()');
  });
  test('admins are told this is only what was shared with them', async () => {
    const { body } = await render({ ...base, is_admin: true });
    expect(body).toContain("You're an admin, so you can open everything.");
  });
  test('a cut-off file list says so', async () => {
    const file = { document: { id: 'd1', name: 'a.pdf', folder: '', size: 1, library: { id: 'lib-1', name: 'Accounting' } }, level: 'read', effective: 'read', granted_by: null, granted_at: '2026-09-02', owner: null };
    const { body } = await render({ ...base, files: [file], truncated: { files: true } });
    expect(body).toContain('Showing the 500 most recent files shared with you.');
  });
});

describe('the rows', () => {
  test('libraries, folders and files each get their own section, with the server level worded', async () => {
    const { body } = await render({
      ...base,
      libraries: [{ library: LIB, level: 'write', effective: 'write', view_only: false, shares: [share()], files: 3, bytes: 30, updated_at: '2026-09-03' }],
      folders: [{ library: LIB, path: 'Clients/Mender', name: 'Mender', level: 'read', effective: 'read', view_only: false, shares: [share({ permission: 'read', via_group: { id: 'g1', name: 'Bookkeepers' } })], also_whole_library: true, files: 0, bytes: 0, updated_at: null }],
      files: [{ document: { id: 'd1', name: 'Q1.pdf', folder: 'Tax & Co', size: 9, library: { id: 'lib-2', name: 'Ops' } }, level: 'admin', effective: 'read', view_only: true, granted_by: { email: 'g@acme.test', name: null }, granted_at: '2026-09-02', owner: null }],
    });
    expect(body).toMatch(/<h3>Libraries<\/h3>[\s\S]*<h3>Folders<\/h3>[\s\S]*<h3>Files given to you directly<\/h3>/);
    expect(body).toContain('Shared with you by Olive');
    expect(body).toContain('Read-Write');
    expect(body).toContain("shared with the Bookkeepers group by Olive · you're a member");
    expect(body).toContain('(you also have the whole library)');
    expect(body).toContain('No files here right now');
    expect(body).toContain('data-swm-folder="Clients/Mender"');
    expect(body).toContain('in Ops / Tax &amp; Co · given to you by g@acme.test');
    expect(body).toContain('You can open these files, not the rest of their library.');
    // a capped level shows what the account can use, and says why
    expect(body).toContain('title="Your account can only view files">Can view');
  });
  test('extra routes to the same library follow the first', () => {
    const p = page(base);
    expect(p.swmShareLine([share({ via_group: { id: 'g', name: 'Ops' }, permission: 'read' }), share()], true))
      .toBe("Shared with you by Olive + also shared with the Ops group (Read-only)");
  });
  test('names from other people are escaped', async () => {
    const evil = '<img src=x onerror=alert(1)>';
    const { body } = await render({
      ...base,
      libraries: [{ library: { ...LIB, name: evil, id: '"><b>' }, level: 'read', effective: 'read', shares: [share({ via_group: { id: 'g', name: evil }, granted_by: { email: 'x', name: evil } })] }],
    });
    expect(body).not.toContain('<img');
    expect(body).not.toContain('"><b>');
  });
});

describe('the call sites', () => {
  const body = (name) => {
    const start = html.search(new RegExp(`(async )?function ${name}\\(`));
    let i = html.indexOf('{', start), depth = 0;
    for (let j = i; j < html.length; j++) {
      if (html[j] === '{') depth++;
      else if (html[j] === '}' && --depth === 0) return html.slice(i, j + 1);
    }
    throw new Error(`unbalanced ${name}`);
  };
  test('the rail item is "Shared to me" and routes to the page', () => {
    expect(html).toContain("fileNavButton('Shared to me', 'shared', `setFileView('shared')`");
    expect(body('setFileView')).toMatch(/view === 'shared'\) \{\s*renderSharedWithMe\(\);/);
  });
  test('nav highlighting matches data-view, not label text', () => {
    expect(body('setFileView')).toContain("btn.dataset.view === view");
    expect(body('setFileView')).not.toMatch(/textContent/);
  });
  test('#/shared carries no folder and goes through setFileView', () => {
    expect(body('hashToNav')).toMatch(/view === 'shared'\) \? ''/);
    expect(body('navApply')).toMatch(/view === 'shared'\) \{\s*setFileView\(view\)/);
  });
  test('opening a row waits for the library before opening its folder', () => {
    const b = body('openSharedPlace');
    expect(b.indexOf('await renderDocumentLibrary')).toBeGreaterThan(-1);
    expect(b.indexOf('await renderDocumentLibrary')).toBeLessThan(b.indexOf('openFolder(folder)'));
  });
  test('who added a file is no longer worded as who can open it', () => {
    expect(html).not.toMatch(/isSharedFile\([^)]*\)\s*\?\s*'Shared'/);
    expect(html).not.toMatch(/'Shared with me' : 'My files'/);
    expect(body('renderDocumentLibraryList')).not.toContain('isSharedFile');
  });
});

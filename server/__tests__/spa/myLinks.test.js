'use strict';
// The app's "My links" page (index.html): the cards say what the server's state says,
// a file you can no longer open stays unnamed, admins can switch to every link, and the
// Home widgets count links by their real state. The section is lifted out of index.html
// and run in a sandbox against a stub DOM.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '../../../index.html'), 'utf8');
const fnLine = (name) => html.match(new RegExp(`^function ${name}\\(.*$`, 'm'))[0];
const block = (name) => { const s = html.search(new RegExp(`\\nfunction ${name}\\(`)); let d = 0, i = html.indexOf('{', s); for (let j = i; ; j++) { if (html[j] === '{') d++; else if (html[j] === '}' && --d === 0) return html.slice(s + 1, j + 1); } };
const section = html.slice(html.indexOf('// ---- Who has access (piece 3) ----'), html.indexOf('async function copyText(text) {'));

function sandbox({ role = 'contributor', answer = { shares: [], folder_links: [] } } = {}) {
  const nodes = {};
  const calls = [];
  const node = (id) => (nodes[id] ||= { id, innerHTML: '', onclick: null });
  const ctx = {
    currentUser: { email: 'me@acme.test', role },
    document: { getElementById: node },
    fileHomeShell: (main) => main,
    apiGet: async (u) => { calls.push(u); return answer; },
    apiDelete: async (u) => { calls.push(`DELETE ${u}`); return {}; },
    askConfirm: async () => true, toast: () => {}, groupErr: (e, m) => m, fileDate: (d) => d,
    shareDate: (d) => `on ${d}`,
    nodes, calls,
  };
  vm.runInNewContext(`${fnLine('esc')}\n${fnLine('escAttr')}\n${block('emptyState')}\n${section}
    Object.assign(this, { myLinkCard, renderShareLinks });`, ctx);
  return ctx;
}
const file = (over = {}) => ({ id: 'l1', document_id: 'd1', document_name: 'Clients/Mender/Q1.pdf', library_name: 'Accounting', name_hidden: false,
  expires_at: null, access_count: 2, has_password: false, allow_upload: false, recipient_email: null, created_by_me: true, created_by_email: 'me@acme.test', state: 'active', ...over });

describe('the cards', () => {
  const { myLinkCard } = sandbox();
  test('an active link: where it is, who it went to, and Revoke', () => {
    const c = myLinkCard(file({ recipient_email: 'client@x.test', has_password: true }), 'file', 'mine');
    expect(c).toContain('>Q1.pdf<');
    expect(c).toContain('Accounting / Clients/Mender · sent to client@x.test · never expires · opened 2 times · password');
    expect(c).toContain('>Active<');
    expect(c).toContain('data-link-id="l1"');
  });
  test('a paused link of yours says why, and can still be revoked', () => {
    const c = myLinkCard(file({ state: 'paused', paused_reason: 'creator_cannot_edit' }), 'file', 'mine');
    expect(c).toContain('>Paused<');
    expect(c).toContain('You can no longer edit this file, so the link doesn&#39;t open. Revoke it so it can&#39;t start working again.');
    expect(c).toContain('data-link-id="l1"');
    expect(myLinkCard(file({ state: 'paused', paused_reason: 'creator_view_only' }), 'file', 'mine')).toContain('Your account can only view files');
  });
  test('ended links show how they ended, with nothing to revoke', () => {
    for (const [state, label] of [['expired', 'Expired'], ['revoked', 'Revoked'], ['file_deleted', 'File deleted']]) {
      const c = myLinkCard(file({ state }), 'file', 'mine');
      expect([state, c.includes(`>${label}<`), c.includes('data-link-id')]).toEqual([state, true, false]);
    }
  });
  test('a file you can no longer open stays unnamed', () => {
    const c = myLinkCard(file({ name_hidden: true, document_name: null, library_name: null }), 'file', 'mine');
    expect(c).toContain('A file you can no longer open');
    expect(c).not.toContain('Q1');
  });
  test('a folder link counts its files and what it still serves', () => {
    const c = myLinkCard({ id: 'f1', folder_path: 'Clients/Mender', file_count: 14, serving: 9, library_name: 'Accounting', state: 'active', access_count: 0, created_by_me: true }, 'folder', 'mine');
    expect(c).toContain('Folder “Mender” (14 files)');
    expect(c).toContain('9 still served');
    expect(c).toContain('data-link-kind="folder"');
  });
  test("an admin's view says who made each one", () => {
    expect(myLinkCard(file({ created_by_me: false, created_by_email: 'tim@acme.test' }), 'file', 'all')).toContain('made by tim@acme.test');
  });
  test('names stay text', () => {
    expect(myLinkCard(file({ document_name: 'a/<img src=x onerror=alert(1)>.pdf' }), 'file', 'mine')).not.toContain('<img');
  });
});

describe('the page', () => {
  const settle = () => new Promise(r => setImmediate(r));
  test('someone who makes links sees their own, Active and Paused first', async () => {
    const ctx = sandbox({ answer: { shares: [file(), file({ id: 'l2', state: 'paused' }), file({ id: 'l3', state: 'revoked' })], folder_links: [] } });
    await ctx.renderShareLinks();
    await settle();
    expect(ctx.calls).toEqual(['/files/shares?scope=mine']);
    expect(ctx.nodes.panel.innerHTML).toContain('My links');
    expect(ctx.nodes.panel.innerHTML).not.toContain('All links (admin)');
    const list = ctx.nodes['file-links-list'].innerHTML;
    expect(list).toContain('Active (1)');
    expect(list).toContain('Paused (1)');
    expect(list).toContain('Revoked (1)');
    expect(list).toContain('data-link-id="l1"');
    expect(list).toContain('data-link-id="l2"');
    expect(list).not.toContain('data-link-id="l3"'); // revoked ones are behind their chip
  });
  test('an admin can switch to every link', async () => {
    const ctx = sandbox({ role: 'admin' });
    await ctx.renderShareLinks('all');
    await settle();
    expect(ctx.calls).toEqual(['/files/shares?scope=all']);
    expect(ctx.nodes.panel.innerHTML).toContain('All links (admin)');
    expect(ctx.nodes.panel.innerHTML).toContain('You can see these because you&#39;re an admin.');
  });
  test('nobody else can ask for everyone\'s', async () => {
    const ctx = sandbox();
    await ctx.renderShareLinks('all');
    expect(ctx.calls).toEqual(['/files/shares?scope=mine']);
  });
  test('no links yet', async () => {
    const ctx = sandbox();
    await ctx.renderShareLinks();
    await settle();
    expect(ctx.nodes['file-links-list'].innerHTML).toContain('You haven&#39;t made any links yet');
  });
});

describe('the call sites', () => {
  test('Home counts links by their real state', () => {
    expect(html).not.toMatch(/s\.status \|\| 'active'/);
    expect(html).toMatch(/const liveShares = shares\.filter\(s => s\.state === 'active'\)/);
  });
  test('viewers, who cannot make links, get no Links item', () => {
    expect(html).toContain("${currentUser?.role === 'viewer' ? '' : fileNavButton('My links', 'links'");
  });
});

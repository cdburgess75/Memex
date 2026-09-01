'use strict';
// SharePoint direct-share by email (Graph /invite). Pins the request shape — roles,
// recipients, requireSignIn/sendInvitation — and the input validation that must run
// before any network call, so a bad address never reaches the tenant.
const adapter = require('../../lib/connectors/sharepoint');

const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; adapter._resetForTests(); });

function mockGraphThenInvite() {
  // 1: token endpoint · 2: site resolution · 3: /invite
  global.fetch = jest.fn()
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3600 }) })
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ id: 'site-id' }) })
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ value: [{ id: 'perm1' }] }) });
}

const CFG = {
  siteUrl: 'https://acme.sharepoint.com/sites/InviteCase',
  tenantId: 'tid', clientId: 'cid', clientSecret: 's3cret', rootPath: '',
};

function inviteCall() {
  const c = global.fetch.mock.calls[2];
  return { url: c[0], body: JSON.parse(c[1].body) };
}

describe('sharepoint shareInvite', () => {
  test('view invite grants read and sends the invitation to each recipient', async () => {
    mockGraphThenInvite();
    const r = await adapter.shareInvite(CFG, 'Report.docx', { type: 'view', emails: ['a@acme.com', 'b@acme.com'] });
    expect(r).toEqual({ invited: ['a@acme.com', 'b@acme.com'], type: 'view' });
    const { url, body } = inviteCall();
    expect(url).toMatch(/\/invite$/);
    expect(body.roles).toEqual(['read']);
    expect(body.requireSignIn).toBe(true);
    expect(body.sendInvitation).toBe(true);
    expect(body.recipients).toEqual([{ email: 'a@acme.com' }, { email: 'b@acme.com' }]);
  });

  test('edit invite grants write', async () => {
    mockGraphThenInvite();
    const r = await adapter.shareInvite(CFG, 'Report.docx', { type: 'edit', emails: ['a@acme.com'] });
    expect(r.type).toBe('edit');
    expect(inviteCall().body.roles).toEqual(['write']);
  });

  test('whitespace-only entries are dropped; an all-blank list fails before any network call', async () => {
    global.fetch = jest.fn();
    await expect(adapter.shareInvite(CFG, 'Report.docx', { type: 'view', emails: ['  ', ''] }))
      .rejects.toThrow(/recipient email is required/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('a malformed address is rejected before any network call', async () => {
    global.fetch = jest.fn();
    await expect(adapter.shareInvite(CFG, 'Report.docx', { type: 'view', emails: ['a@acme.com', 'nope'] }))
      .rejects.toThrow(/not a valid email/);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

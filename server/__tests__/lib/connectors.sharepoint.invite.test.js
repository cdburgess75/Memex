'use strict';
// SharePoint direct-share by email. The invitation EMAIL is sent from the caller's
// mailbox, which app-only auth doesn't have — so the adapter splits by auth mode:
//   • delegated  → invite sendInvitation:true (SharePoint emails natively as the user)
//   • app-only   → invite sendInvitation:false (silent grant) + return the item's
//                  webUrl so the caller (the route) can email it via Depot's mailer.
// These tests pin that split, the returned shape, and the pre-network validation.
// The earlier bug — sendInvitation:true under app-only — produced Graph 400
// "There was a problem sharing"; test #1 guards against its return.
const adapter = require('../../lib/connectors/sharepoint');

const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; adapter._resetForTests(); });

const APP_CFG = {
  siteUrl: 'https://acme.sharepoint.com/sites/InviteCase',
  tenantId: 'tid', clientId: 'cid', clientSecret: 's3cret', rootPath: '',
};
const DELEGATED_CFG = {
  siteUrl: 'https://acme.sharepoint.com/sites/DelegatedCase',
  rootPath: '', delegated: true, delegatedToken: 'user-token',
};

const ok = (json) => ({ ok: true, status: 200, json: async () => json });

describe('sharepoint shareInvite — app-only (Depot delivers the email)', () => {
  function mockAppOnly() {
    // 1: token · 2: site · 3: invite (sendInvitation:false) · 4: GET webUrl
    global.fetch = jest.fn()
      .mockResolvedValueOnce(ok({ access_token: 'tok', expires_in: 3600 }))
      .mockResolvedValueOnce(ok({ id: 'site-id' }))
      .mockResolvedValueOnce(ok({ value: [{ id: 'perm1' }] }))
      .mockResolvedValueOnce(ok({ webUrl: 'https://acme.sharepoint.com/x/Report.docx', name: 'Report.docx' }));
  }

  test('grants silently (sendInvitation:false) and returns a webUrl, native:false', async () => {
    mockAppOnly();
    const r = await adapter.shareInvite(APP_CFG, 'Report.docx', { type: 'view', emails: ['a@acme.com', 'b@acme.com'] });
    expect(r).toEqual({
      invited: ['a@acme.com', 'b@acme.com'], type: 'view', native: false,
      url: 'https://acme.sharepoint.com/x/Report.docx',
    });
    const inviteBody = JSON.parse(global.fetch.mock.calls[2][1].body);
    expect(inviteBody.sendInvitation).toBe(false); // the whole point — no mailbox app-only
    expect(inviteBody.roles).toEqual(['read']);
    expect(inviteBody.requireSignIn).toBe(true);
    expect(inviteBody.recipients).toEqual([{ email: 'a@acme.com' }, { email: 'b@acme.com' }]);
    expect(global.fetch.mock.calls[3][0]).toMatch(/\?\$select=webUrl/);
  });

  test('edit invite grants write', async () => {
    mockAppOnly();
    const r = await adapter.shareInvite(APP_CFG, 'Report.docx', { type: 'edit', emails: ['a@acme.com'] });
    expect(r.type).toBe('edit');
    expect(JSON.parse(global.fetch.mock.calls[2][1].body).roles).toEqual(['write']);
  });

  test('the grant still succeeds when the webUrl lookup fails (url:null)', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce(ok({ access_token: 'tok', expires_in: 3600 }))
      .mockResolvedValueOnce(ok({ id: 'site-id' }))
      .mockResolvedValueOnce(ok({ value: [{ id: 'perm1' }] }))
      .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({ error: { message: 'gone' } }) });
    const r = await adapter.shareInvite(APP_CFG, 'Report.docx', { type: 'view', emails: ['a@acme.com'] });
    expect(r.native).toBe(false);
    expect(r.url).toBeNull();
  });

  test('a Graph 400 grant failure gives the guest guidance AND demotes to status 400', async () => {
    // The route's fail() drops e.message for status >= 500, and graph() maps 400 -> 502.
    // So the adapter must demote to 400, or the guidance never reaches the user.
    global.fetch = jest.fn()
      .mockResolvedValueOnce(ok({ access_token: 'tok', expires_in: 3600 }))
      .mockResolvedValueOnce(ok({ id: 'site-id' }))
      .mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({ error: { message: 'invalid recipient' } }) });
    const err = await adapter.shareInvite(APP_CFG, 'Report.docx', { type: 'view', emails: ['newguest@other.com'] }).catch(e => e);
    expect(err.message).toMatch(/brand-new external guest/);
    expect(err.status).toBe(400); // NOT 502 — else fail() would swallow the message
  });

  test('a 403 grant failure is reported as a permission problem, not a guest problem', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce(ok({ access_token: 'tok', expires_in: 3600 }))
      .mockResolvedValueOnce(ok({ id: 'site-id' }))
      .mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({ error: { message: 'Access denied' } }) });
    const err = await adapter.shareInvite(APP_CFG, 'Report.docx', { type: 'view', emails: ['a@acme.com'] }).catch(e => e);
    expect(err.status).toBe(403);
    expect(err.message).toMatch(/Sites\.ReadWrite\.All|app registration|restricted/);
    expect(err.message).not.toMatch(/guest/);
  });
});

describe('sharepoint shareInvite — delegated (SharePoint emails natively)', () => {
  test('uses sendInvitation:true with the user token, native:true, no token fetch', async () => {
    // delegated token is used directly → no token-endpoint call. 1: site · 2: invite
    global.fetch = jest.fn()
      .mockResolvedValueOnce(ok({ id: 'site-id' }))
      .mockResolvedValueOnce(ok({ value: [{ id: 'perm1' }] }));
    const r = await adapter.shareInvite(DELEGATED_CFG, 'Report.docx', { type: 'edit', emails: ['a@acme.com'], message: 'hi there' });
    expect(r).toEqual({ invited: ['a@acme.com'], type: 'edit', native: true, url: null });
    expect(global.fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer user-token');
    const inviteBody = JSON.parse(global.fetch.mock.calls[1][1].body);
    expect(inviteBody.sendInvitation).toBe(true);
    expect(inviteBody.roles).toEqual(['write']);
    expect(inviteBody.message).toBe('hi there');
  });
});

describe('sharepoint shareInvite — validation (before any network call)', () => {
  test('an all-blank recipient list fails', async () => {
    global.fetch = jest.fn();
    await expect(adapter.shareInvite(APP_CFG, 'Report.docx', { type: 'view', emails: ['  ', ''] }))
      .rejects.toThrow(/recipient email is required/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('a malformed address fails', async () => {
    global.fetch = jest.fn();
    await expect(adapter.shareInvite(APP_CFG, 'Report.docx', { type: 'view', emails: ['a@acme.com', 'nope'] }))
      .rejects.toThrow(/not a valid email/);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

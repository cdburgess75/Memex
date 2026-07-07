'use strict';
// Covers the Microsoft Graph sendMail backend: config parsing (secret vs cert),
// provider selection, token acquisition + caching, and the sendMail call shape.
jest.mock('../../lib/settings', () => ({ getOrEnv: jest.fn() }));
const settings = require('../../lib/settings');
const crypto = require('crypto');
const email = require('../../lib/email');

// A real RSA keypair so the cert client-assertion actually signs (jsonwebtoken RS256).
const TEST_PEM = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs1', format: 'pem' });

function cfg(map) { settings.getOrEnv.mockImplementation(async (k) => (k in map ? map[k] : null)); }

const realFetch = global.fetch;
beforeEach(() => {
  email._resetForTests();
  settings.getOrEnv.mockReset();
  global.fetch = jest.fn();
});
afterEach(() => { global.fetch = realFetch; });

function mockGraphOk() {
  global.fetch.mockImplementation(async (url) => {
    if (String(url).includes('/oauth2/v2.0/token')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'tok-123', expires_in: 3600 }) };
    }
    if (String(url).includes('/sendMail')) return { ok: true, status: 202, json: async () => ({}) };
    throw new Error('unexpected url ' + url);
  });
}

describe('graphConfig', () => {
  test('null when tenant/client/from missing', async () => {
    cfg({ graph_client_secret: 's' });
    expect(await email.graphConfig()).toBeNull();
  });
  test('null when configured but no credential (no secret, no cert)', async () => {
    cfg({ graph_tenant_id: 't', graph_client_id: 'c', email_from: 'a@b.com' });
    expect(await email.graphConfig()).toBeNull();
  });
  test('secret credential recognised', async () => {
    cfg({ graph_tenant_id: 't', graph_client_id: 'c', email_from: 'a@b.com', graph_client_secret: 'sh' });
    const g = await email.graphConfig();
    expect(g.hasSecret).toBe(true); expect(g.hasCert).toBe(false);
  });
  test('cert credential recognised (thumbprint + key)', async () => {
    cfg({ graph_tenant_id: 't', graph_client_id: 'c', email_from: 'a@b.com', graph_cert_thumbprint: 'AABBCC', graph_cert_key: TEST_PEM });
    const g = await email.graphConfig();
    expect(g.hasCert).toBe(true); expect(g.hasSecret).toBe(false);
  });
});

describe('resolveProvider', () => {
  test('auto prefers Graph when configured', async () => {
    cfg({ graph_tenant_id: 't', graph_client_id: 'c', email_from: 'a@b.com', graph_client_secret: 's', smtp_host: 'smtp.x.com' });
    expect((await email.resolveProvider()).kind).toBe('graph');
  });
  test('explicit smtp overrides even when Graph is configured', async () => {
    cfg({ email_provider: 'smtp', graph_tenant_id: 't', graph_client_id: 'c', email_from: 'a@b.com', graph_client_secret: 's', smtp_host: 'smtp.x.com' });
    expect((await email.resolveProvider()).kind).toBe('smtp');
  });
  test('explicit graph but unconfigured → null (does not silently fall back)', async () => {
    cfg({ email_provider: 'graph', smtp_host: 'smtp.x.com' });
    expect(await email.resolveProvider()).toBeNull();
  });
});

describe('graphSend (secret)', () => {
  const base = { graph_tenant_id: 'tenant-1', graph_client_id: 'client-1', email_from: 'memex@ptechllc.com', graph_client_secret: 'secret-1' };

  test('acquires a token then POSTs sendMail; returns sent+via', async () => {
    cfg(base); mockGraphOk();
    const r = await email.sendMail({ to: 'x@y.com', subject: 'Hi', html: '<b>hi</b>' });
    expect(r).toEqual({ sent: true, via: 'graph' });
    const tokenCall = global.fetch.mock.calls.find(c => String(c[0]).includes('/token'));
    expect(tokenCall[0]).toBe('https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token');
    expect(tokenCall[1].body).toContain('grant_type=client_credentials');
    expect(tokenCall[1].body).toContain('client_secret=secret-1');
    const sendCall = global.fetch.mock.calls.find(c => String(c[0]).includes('/sendMail'));
    expect(sendCall[0]).toBe('https://graph.microsoft.com/v1.0/users/memex%40ptechllc.com/sendMail');
    expect(sendCall[1].headers.Authorization).toBe('Bearer tok-123');
    const body = JSON.parse(sendCall[1].body);
    expect(body.message.toRecipients).toEqual([{ emailAddress: { address: 'x@y.com' } }]);
    expect(body.message.body).toEqual({ contentType: 'HTML', content: '<b>hi</b>' });
    expect(body.saveToSentItems).toBe(false);
  });

  test('multiple recipients split on comma', async () => {
    cfg(base); mockGraphOk();
    await email.sendMail({ to: 'a@x.com, b@x.com', subject: 's', text: 't' });
    const sendCall = global.fetch.mock.calls.find(c => String(c[0]).includes('/sendMail'));
    expect(JSON.parse(sendCall[1].body).message.toRecipients).toHaveLength(2);
  });

  test('token is cached across sends (one token call for two sends)', async () => {
    cfg(base); mockGraphOk();
    await email.sendMail({ to: 'a@x.com', subject: 's', text: 't' });
    await email.sendMail({ to: 'b@x.com', subject: 's', text: 't' });
    expect(global.fetch.mock.calls.filter(c => String(c[0]).includes('/token'))).toHaveLength(1);
  });

  test('text body when no html', async () => {
    cfg(base); mockGraphOk();
    await email.sendMail({ to: 'a@x.com', subject: 's', text: 'plain' });
    const sendCall = global.fetch.mock.calls.find(c => String(c[0]).includes('/sendMail'));
    expect(JSON.parse(sendCall[1].body).message.body).toEqual({ contentType: 'Text', content: 'plain' });
  });

  test('token failure → sent:false with reason (never throws)', async () => {
    cfg(base);
    global.fetch.mockImplementation(async (url) => String(url).includes('/token')
      ? { ok: false, status: 401, json: async () => ({ error: 'invalid_client', error_description: 'bad secret' }) }
      : { ok: true, status: 202, json: async () => ({}) });
    const r = await email.sendMail({ to: 'a@x.com', subject: 's', text: 't' });
    expect(r.sent).toBe(false);
    expect(r.reason).toMatch(/graph token 401/);
  });

  test('sendMail non-202 → sent:false with reason', async () => {
    cfg(base);
    global.fetch.mockImplementation(async (url) => String(url).includes('/token')
      ? { ok: true, status: 200, json: async () => ({ access_token: 't', expires_in: 3600 }) }
      : { ok: false, status: 403, json: async () => ({ error: { message: 'Access denied' } }) });
    const r = await email.sendMail({ to: 'a@x.com', subject: 's', text: 't' });
    expect(r.sent).toBe(false);
    expect(r.reason).toMatch(/graph sendMail 403.*Access denied/);
  });
});

describe('graphSend (certificate)', () => {
  test('uses a signed client-assertion instead of a secret', async () => {
    cfg({ graph_tenant_id: 'tenant-2', graph_client_id: 'client-2', email_from: 'memex@ptechllc.com', graph_cert_thumbprint: 'BBE7DE8E4DFFDF69', graph_cert_key: TEST_PEM });
    mockGraphOk();
    const r = await email.sendMail({ to: 'x@y.com', subject: 's', text: 't' });
    expect(r).toEqual({ sent: true, via: 'graph' });
    const tokenCall = global.fetch.mock.calls.find(c => String(c[0]).includes('/token'));
    expect(tokenCall[1].body).toContain('client_assertion_type=urn%3Aietf%3Aparams%3Aoauth%3Aclient-assertion-type%3Ajwt-bearer');
    expect(tokenCall[1].body).toContain('client_assertion=');
    expect(tokenCall[1].body).not.toContain('client_secret=');
  });
});

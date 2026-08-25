'use strict';
// The SharePoint adapter's app-only auth: client secret OR certificate. These
// tests pin which credential lands in the token request — the connector shipped
// secret-only once while the fleet standard was certificates, and nothing failed
// until a real tenant said no.
const crypto = require('crypto');
const adapter = require('../../lib/connectors/sharepoint');

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });
const THUMB = 'AABBCCDDEEFF00112233445566778899AABBCCDD';

const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; });

function mockGraph() {
  // 1: token endpoint · 2: site resolution · 3: children probe
  global.fetch = jest.fn()
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3600 }) })
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ id: 'site-id' }) })
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ value: [] }) });
}

function tokenBody() {
  return new URLSearchParams(global.fetch.mock.calls[0][1].body);
}

describe('sharepoint adapter auth', () => {
  test('certificate credential sends a client_assertion, no client_secret', async () => {
    mockGraph();
    const r = await adapter.test({
      siteUrl: 'https://acme.sharepoint.com/sites/CertCase',
      tenantId: 'tid', clientId: 'cid',
      certThumbprint: THUMB, certKey: PEM,
    });
    expect(r.ok).toBe(true);
    const body = tokenBody();
    expect(body.get('client_assertion_type')).toBe('urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
    expect(body.get('client_assertion')).toMatch(/^eyJ/);
    expect(body.get('client_secret')).toBeNull();
    expect(body.get('grant_type')).toBe('client_credentials');
  });

  test('client secret still works and wins when both are configured', async () => {
    mockGraph();
    await adapter.test({
      siteUrl: 'https://acme.sharepoint.com/sites/SecretCase',
      tenantId: 'tid2', clientId: 'cid',
      clientSecret: 's3cret', certThumbprint: THUMB, certKey: PEM,
    });
    const body = tokenBody();
    expect(body.get('client_secret')).toBe('s3cret');
    expect(body.get('client_assertion')).toBeNull();
  });

  test('no credential at all fails with a clear error before any network call', async () => {
    global.fetch = jest.fn();
    await expect(adapter.test({
      siteUrl: 'https://acme.sharepoint.com/sites/NoCred',
      tenantId: 'tid3', clientId: 'cid',
    })).rejects.toThrow(/client secret or certificate/);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

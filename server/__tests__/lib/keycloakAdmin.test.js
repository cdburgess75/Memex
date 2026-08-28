'use strict';
// Pins the Keycloak admin API contract for Depot-managed sign-in config: the
// Microsoft 365 OIDC identity provider and the Active Directory LDAP federation.
// The mask round-trip matters most — "blank secret keeps the stored one" only
// works because Keycloak preserves a config value of '**********' on update.

const kcAdmin = require('../../lib/keycloakAdmin');

const ENV = { ...process.env };
let calls;

function mockFetch(responses) {
  let i = 0;
  global.fetch = jest.fn(async (url, opts) => {
    calls.push({ url: String(url), method: opts?.method || 'GET', body: opts?.body });
    const r = responses[Math.min(i, responses.length - 1)]; i += 1;
    return {
      ok: r.status < 400,
      status: r.status,
      json: async () => r.json ?? {},
    };
  });
}
const tokenResponse = { status: 200, json: { access_token: 'admtok' } };
const jsonBody = (c) => JSON.parse(c.body);

beforeEach(() => {
  calls = [];
  process.env.KEYCLOAK_INTERNAL_URL = 'http://keycloak:8080';
  process.env.KEYCLOAK_ADMIN_USER = 'admin';
  process.env.KEYCLOAK_ADMIN_PASSWORD = 'pw';
  delete process.env.KEYCLOAK_REALM;
});
afterAll(() => { process.env = ENV; });

describe('adminToken', () => {
  test('fails with a readable error when credentials are missing', async () => {
    delete process.env.KEYCLOAK_ADMIN_PASSWORD;
    await expect(kcAdmin.adminToken()).rejects.toThrow(/admin credentials/i);
  });

  test('authenticates against the master realm with admin-cli', async () => {
    mockFetch([tokenResponse]);
    await kcAdmin.adminToken();
    expect(calls[0].url).toBe('http://keycloak:8080/realms/master/protocol/openid-connect/token');
    expect(String(calls[0].body)).toContain('grant_type=password');
  });
});

describe('setRealmDisplayName', () => {
  test('updates the realm heading shown on the hosted sign-in page', async () => {
    mockFetch([tokenResponse, { status: 204 }]);
    const r = await kcAdmin.setRealmDisplayName('Acme Legal');
    expect(r.displayName).toBe('Acme Legal');
    expect(calls[1].method).toBe('PUT');
    expect(calls[1].url).toBe('http://keycloak:8080/admin/realms/memex');
    const body = JSON.parse(calls[1].body);
    expect(body.displayName).toBe('Acme Legal');
    expect(body.realm).toBe('memex');   // identifier unchanged — it is in the token issuer
  });

  test('a blank brand falls back to the product name, never an internal one', async () => {
    mockFetch([tokenResponse, { status: 204 }]);
    const r = await kcAdmin.setRealmDisplayName('   ');
    expect(r.displayName).toBe('Depot');
    expect(JSON.parse(calls[1].body).displayName).toBe('Depot');
  });
});

describe('ensureMicrosoftIdp', () => {
  test('creates a single-tenant OIDC provider with alias "microsoft"', async () => {
    mockFetch([tokenResponse, { status: 404 }, { status: 201 }]);
    const r = await kcAdmin.ensureMicrosoftIdp({ tenantId: 'tid', clientId: 'cid', clientSecret: 'sec' });
    expect(r.created).toBe(true);
    expect(calls[2].url).toBe('http://keycloak:8080/admin/realms/memex/identity-provider/instances');
    const rep = jsonBody(calls[2]);
    expect(rep.alias).toBe('microsoft');
    expect(rep.providerId).toBe('oidc');
    expect(rep.config.issuer).toBe('https://login.microsoftonline.com/tid/v2.0');
    expect(rep.config.authorizationUrl).toBe('https://login.microsoftonline.com/tid/oauth2/v2.0/authorize');
    expect(rep.config.tokenUrl).toBe('https://login.microsoftonline.com/tid/oauth2/v2.0/token');
    expect(rep.config.clientAuthMethod).toBe('client_secret_post');
    expect(rep.config.clientId).toBe('cid');
    expect(rep.config.clientSecret).toBe('sec');
    expect(rep.config.defaultScope).toBe('openid profile email');
  });

  test('refuses to create without a client secret', async () => {
    mockFetch([tokenResponse, { status: 404 }]);
    await expect(kcAdmin.ensureMicrosoftIdp({ tenantId: 'tid', clientId: 'cid' }))
      .rejects.toThrow(/client secret is required/i);
  });

  test('update with a blank secret carries the stored mask forward', async () => {
    mockFetch([
      tokenResponse,
      { status: 200, json: { alias: 'microsoft', config: { clientSecret: kcAdmin.SECRET_MASK } } },
      { status: 204 },
    ]);
    const r = await kcAdmin.ensureMicrosoftIdp({ tenantId: 'tid', clientId: 'cid', clientSecret: null });
    expect(r.created).toBe(false);
    expect(calls[2].method).toBe('PUT');
    expect(jsonBody(calls[2]).config.clientSecret).toBe(kcAdmin.SECRET_MASK);
  });

  test('update with a new secret sends the new secret', async () => {
    mockFetch([
      tokenResponse,
      { status: 200, json: { alias: 'microsoft', config: { clientSecret: kcAdmin.SECRET_MASK } } },
      { status: 204 },
    ]);
    await kcAdmin.ensureMicrosoftIdp({ tenantId: 'tid', clientId: 'cid', clientSecret: 'fresh' });
    expect(jsonBody(calls[2]).config.clientSecret).toBe('fresh');
  });
});

describe('removeMicrosoftIdp', () => {
  test('tolerates an already-absent provider', async () => {
    mockFetch([tokenResponse, { status: 404 }]);
    await expect(kcAdmin.removeMicrosoftIdp()).resolves.toBeUndefined();
    expect(calls[1].method).toBe('DELETE');
  });
});

describe('ensureLdapFederation', () => {
  const realmLookup = { status: 200, json: { id: 'realm-internal-id' } };
  const opts = { connectionUrl: 'ldaps://dc1:636', bindDn: 'CN=svc', bindCredential: 'pw', usersDn: 'OU=Staff' };

  test('creates an AD-vendor component parented to the realm', async () => {
    mockFetch([tokenResponse, realmLookup, { status: 200, json: [] }, { status: 201 }]);
    const r = await kcAdmin.ensureLdapFederation(opts);
    expect(r.created).toBe(true);
    expect(calls[3].url).toBe('http://keycloak:8080/admin/realms/memex/components');
    const rep = jsonBody(calls[3]);
    expect(rep.providerId).toBe('ldap');
    expect(rep.providerType).toBe('org.keycloak.storage.UserStorageProvider');
    expect(rep.parentId).toBe('realm-internal-id');
    expect(rep.config.vendor).toEqual(['ad']);
    expect(rep.config.usernameLDAPAttribute).toEqual(['sAMAccountName']);
    expect(rep.config.editMode).toEqual(['READ_ONLY']);
    expect(rep.config.bindCredential).toEqual(['pw']);
  });

  test('refuses to create without a bind credential', async () => {
    mockFetch([tokenResponse, realmLookup, { status: 200, json: [] }]);
    await expect(kcAdmin.ensureLdapFederation({ ...opts, bindCredential: null }))
      .rejects.toThrow(/bind credential is required/i);
  });

  test('update with a blank credential keeps the stored one', async () => {
    const existing = {
      id: 'comp1', name: kcAdmin.LDAP_NAME, providerId: 'ldap',
      config: { bindCredential: [kcAdmin.SECRET_MASK], connectionUrl: ['ldaps://old:636'] },
    };
    mockFetch([tokenResponse, realmLookup, { status: 200, json: [existing] }, { status: 204 }]);
    const r = await kcAdmin.ensureLdapFederation({ ...opts, bindCredential: null });
    expect(r.created).toBe(false);
    expect(calls[3].method).toBe('PUT');
    expect(calls[3].url).toContain('/components/comp1');
    const rep = jsonBody(calls[3]);
    expect(rep.config.bindCredential).toEqual([kcAdmin.SECRET_MASK]);
    expect(rep.config.connectionUrl).toEqual(['ldaps://dc1:636']);
  });
});

describe('testLdap', () => {
  test('reports per-stage results instead of throwing', async () => {
    mockFetch([
      tokenResponse,
      { status: 204 },
      { status: 400, json: { errorMessage: 'invalid credentials' } },
    ]);
    const r = await kcAdmin.testLdap({ connectionUrl: 'ldaps://dc1:636', bindDn: 'CN=svc', bindCredential: 'bad' });
    expect(r.connection.ok).toBe(true);
    expect(r.authentication.ok).toBe(false);
    expect(r.authentication.error).toBe('invalid credentials');
    expect(jsonBody(calls[1]).action).toBe('testConnection');
    expect(jsonBody(calls[2]).action).toBe('testAuthentication');
  });
});

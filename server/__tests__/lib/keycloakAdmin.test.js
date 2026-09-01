'use strict';
// Pins the Keycloak admin API contract for Depot-managed sign-in config: the
// Microsoft 365 OIDC identity provider and the Active Directory LDAP federation.
// The mask round-trip matters most — "blank secret keeps the stored one" only
// works because Keycloak preserves a config value of '**********' on update.

jest.mock('../../lib/settings', () => ({ get: jest.fn(), set: jest.fn(), getOrEnv: jest.fn() }));
const settings = require('../../lib/settings');
const enc = require('../../lib/encryption');
const KEY_HEX = 'a'.repeat(64);

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

describe('setLocalTotpRequirement — TOTP for local accounts only', () => {
  // URL-routed mock: this flow touches several endpoints per user, and order
  // is an implementation detail — route by URL+method instead of by sequence.
  const LOCAL = { id: 'u-local', username: 'pat', requiredActions: [] };
  const BROKERED = { id: 'u-m365', username: 'dave', requiredActions: ['CONFIGURE_TOTP'] };
  const LDAP = { id: 'u-ad', username: 'owen', federationLink: 'ldap-comp', requiredActions: [] };
  let puts;

  function routeFetch() {
    puts = [];
    global.fetch = jest.fn(async (url, opts) => {
      const u = String(url); const method = opts?.method || 'GET';
      const json = (j) => ({ ok: true, status: 200, json: async () => j });
      if (u.includes('/realms/master/')) return json({ access_token: 'admtok' });
      if (method === 'PUT') { puts.push({ url: u, body: JSON.parse(opts.body) }); return { ok: true, status: 204, json: async () => ({}) }; }
      if (u.includes('/authentication/required-actions/CONFIGURE_TOTP')) return json({ alias: 'CONFIGURE_TOTP', enabled: true, defaultAction: true, priority: 10 });
      if (u.includes('/users?')) return json(u.includes('first=0') ? [LOCAL, BROKERED, LDAP] : []);
      if (u.includes('/u-m365/federated-identity')) return json([{ identityProvider: 'microsoft' }]);
      if (u.includes('/federated-identity')) return json([]);
      if (u.includes('/credentials')) return json([{ type: 'password' }]);
      return json({});
    });
  }

  test('the required-actions URL keeps its /authentication/ segment (shipped broken for months — do not let it rot)', async () => {
    routeFetch();
    await kcAdmin.setLocalTotpRequirement(true);
    const ra = puts.find(p => p.url.includes('required-actions'));
    expect(ra.url).toBe('http://keycloak:8080/admin/realms/memex/authentication/required-actions/CONFIGURE_TOTP');
  });

  test('enable: default stays OFF, local users get stamped, federated users get cleared instead', async () => {
    routeFetch();
    const r = await kcAdmin.setLocalTotpRequirement(true);
    // Never realm-wide: that is exactly what dead-ended a brokered M365 login.
    expect(puts.find(p => p.url.includes('required-actions')).body.defaultAction).toBe(false);
    // The local account is stamped…
    const local = puts.find(p => p.url.endsWith('/users/u-local'));
    expect(local.body.requiredActions).toContain('CONFIGURE_TOTP');
    // …the brokered account has its stale prompt REMOVED, not added…
    const brokered = puts.find(p => p.url.endsWith('/users/u-m365'));
    expect(brokered.body.requiredActions).not.toContain('CONFIGURE_TOTP');
    // …and the AD user (federationLink) is skipped without extra lookups.
    expect(puts.find(p => p.url.endsWith('/users/u-ad'))).toBeUndefined();
    expect(r).toMatchObject({ stamped: 1, skippedFederated: 2 });
  });

  test('disable: pending prompts are cleared from local users', async () => {
    LOCAL.requiredActions = ['CONFIGURE_TOTP'];
    routeFetch();
    const r = await kcAdmin.setLocalTotpRequirement(false);
    const local = puts.find(p => p.url.endsWith('/users/u-local'));
    expect(local.body.requiredActions).not.toContain('CONFIGURE_TOTP');
    expect(r.cleared).toBe(1);
    LOCAL.requiredActions = [];
  });

  test('a local user who already has an authenticator is not asked to enroll again', async () => {
    routeFetch();
    const inner = global.fetch;
    global.fetch = jest.fn(async (url, opts) => {
      if (String(url).includes('/u-local/credentials')) return { ok: true, status: 200, json: async () => [{ type: 'otp' }] };
      return inner(url, opts);
    });
    const r = await kcAdmin.setLocalTotpRequirement(true);
    expect(puts.find(p => p.url.endsWith('/users/u-local'))).toBeUndefined();
    expect(r.alreadyEnrolled).toBe(1);
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

describe('delegated Graph token refresh (Depot-side)', () => {
  beforeEach(() => {
    settings.get.mockReset(); settings.set.mockReset(); settings.getOrEnv.mockReset();
    settings.getOrEnv.mockResolvedValue(KEY_HEX);   // storage_encryption_key
  });

  test('the login client secret round-trips through encrypted storage', async () => {
    let storedB64 = null;
    settings.set.mockImplementation(async (k, v) => { if (k === 'login_ms365_client_secret_enc') storedB64 = v; });
    await kcAdmin.storeMsClientSecret('super-secret-value');
    expect(storedB64).toBeTruthy();
    expect(storedB64).not.toContain('super-secret-value'); // actually encrypted
    settings.get.mockImplementation(async (k) => (k === 'login_ms365_client_secret_enc' ? storedB64 : null));
    expect(await kcAdmin.getMsClientSecret()).toBe('super-secret-value');
  });

  test('storeMsClientSecret ignores the mask and blank values', async () => {
    await kcAdmin.storeMsClientSecret('**********');
    await kcAdmin.storeMsClientSecret('');
    expect(settings.set).not.toHaveBeenCalled();
  });

  test('refreshMsGraphToken exchanges the refresh token for a fresh Graph token', async () => {
    const encSecret = enc.encrypt(Buffer.from('cs'), enc.resolveKey(KEY_HEX)).toString('base64');
    settings.get.mockImplementation(async (k) => ({
      login_ms365_tenant_id: 'tid', login_ms365_client_id: 'cid', login_ms365_client_secret_enc: encSecret,
    }[k] ?? null));
    mockFetch([{ status: 200, json: { access_token: 'fresh-graph-token' } }]);
    const t = await kcAdmin.refreshMsGraphToken('the-refresh-token');
    expect(t).toBe('fresh-graph-token');
    expect(calls[0].url).toContain('login.microsoftonline.com/tid/oauth2/v2.0/token');
    expect(calls[0].body).toContain('grant_type=refresh_token');
    expect(calls[0].body).toContain('the-refresh-token');
  });

  test('refreshMsGraphToken returns null (no Entra call) when the secret is missing', async () => {
    settings.get.mockImplementation(async (k) => ({ login_ms365_tenant_id: 'tid', login_ms365_client_id: 'cid' }[k] ?? null));
    global.fetch = jest.fn();
    expect(await kcAdmin.refreshMsGraphToken('rt')).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('refreshMsGraphToken returns null when Entra rejects the refresh token', async () => {
    const encSecret = enc.encrypt(Buffer.from('cs'), enc.resolveKey(KEY_HEX)).toString('base64');
    settings.get.mockImplementation(async (k) => ({
      login_ms365_tenant_id: 'tid', login_ms365_client_id: 'cid', login_ms365_client_secret_enc: encSecret,
    }[k] ?? null));
    mockFetch([{ status: 400, json: { error: 'invalid_grant' } }]);
    expect(await kcAdmin.refreshMsGraphToken('dead-token')).toBeNull();
  });
});

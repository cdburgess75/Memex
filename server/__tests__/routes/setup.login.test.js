'use strict';
// Sign-in methods routes (/setup/login-ms365, /setup/login-ldap) plus the
// unconditional-write fixes in /setup/integrations: an empty re-save (the wizard
// renders blank fields on Back-navigation) must not null-clear provisioned
// graph_tenant_id/graph_client_id or a working SMTP relay config.

const request = require('supertest');
const express = require('express');

jest.mock('../../lib/settings', () => ({
  ENV_MAP: {},
  get: jest.fn().mockResolvedValue(null),
  getOrEnv: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../lib/email', () => ({ sendMail: jest.fn() }));
jest.mock('../../lib/keycloakAdmin', () => ({
  ensureMicrosoftIdp: jest.fn().mockResolvedValue({ created: true }),
  removeMicrosoftIdp: jest.fn().mockResolvedValue(undefined),
  ensureLdapFederation: jest.fn().mockResolvedValue({ created: true }),
  removeLdapFederation: jest.fn().mockResolvedValue(undefined),
  testLdap: jest.fn(),
}));
const settings = require('../../lib/settings');
const kcAdmin = require('../../lib/keycloakAdmin');

let mockUser = { id: 'u1', email: 'admin@test.com', role: 'admin' };
jest.mock('../../middleware/auth', () => (req, _res, next) => { req.user = mockUser; next(); });

const app = express();
app.use(express.json());
app.use('/api/setup', require('../../routes/setup'));

const TID = '04a63bc6-34c5-4ee6-a7d6-c29b544e7399';
const CID = '92789560-d220-4120-8d1d-c5018b2a4a9e';
const setCalls = () => settings.set.mock.calls;
const wrote = (key) => setCalls().find(([k]) => k === key);

beforeEach(() => {
  settings.get.mockResolvedValue(null);
  settings.getOrEnv.mockResolvedValue(null);
  settings.set.mockClear();
  kcAdmin.ensureMicrosoftIdp.mockClear().mockResolvedValue({ created: true });
  kcAdmin.removeMicrosoftIdp.mockClear().mockResolvedValue(undefined);
  kcAdmin.ensureLdapFederation.mockClear().mockResolvedValue({ created: true });
  kcAdmin.removeLdapFederation.mockClear().mockResolvedValue(undefined);
  kcAdmin.testLdap.mockReset();
  mockUser = { id: 'u1', email: 'admin@test.com', role: 'admin' };
});

describe('POST /login-ms365', () => {
  test('rejects a non-GUID tenant id without touching Keycloak', async () => {
    const r = await request(app).post('/api/setup/login-ms365').send({ tenantId: 'contoso', clientId: CID, clientSecret: 's' });
    expect(r.body.ok).toBe(false);
    expect(r.body.error).toMatch(/tenant id/i);
    expect(kcAdmin.ensureMicrosoftIdp).not.toHaveBeenCalled();
    expect(setCalls()).toHaveLength(0);
  });

  test('enables: provisions the IdP and records flag + display ids (never the secret)', async () => {
    const r = await request(app).post('/api/setup/login-ms365').send({ tenantId: TID, clientId: CID, clientSecret: 'topsecret' });
    expect(r.body).toMatchObject({ ok: true, enabled: true, created: true });
    expect(kcAdmin.ensureMicrosoftIdp).toHaveBeenCalledWith({ tenantId: TID, clientId: CID, clientSecret: 'topsecret', graphDelegation: false });
    expect(wrote('login_ms365_enabled')[1]).toBe('true');
    expect(wrote('login_ms365_tenant_id')[1]).toBe(TID);
    expect(wrote('login_ms365_client_id')[1]).toBe(CID);
    expect(setCalls().some(([, v]) => v === 'topsecret')).toBe(false);
  });

  test('falls back to saved tenant/client when the body omits them', async () => {
    settings.get.mockImplementation(async (k) => (
      { login_ms365_tenant_id: TID, login_ms365_client_id: CID }[k] ?? null
    ));
    const r = await request(app).post('/api/setup/login-ms365').send({});
    expect(r.body.ok).toBe(true);
    expect(kcAdmin.ensureMicrosoftIdp).toHaveBeenCalledWith({ tenantId: TID, clientId: CID, clientSecret: null, graphDelegation: false });
  });

  test('a Keycloak failure reports ok:false with a hint and does not set the flag', async () => {
    kcAdmin.ensureMicrosoftIdp.mockRejectedValue(new Error('Keycloak identity-provider create failed (401).'));
    const r = await request(app).post('/api/setup/login-ms365').send({ tenantId: TID, clientId: CID, clientSecret: 's' });
    expect(r.body.ok).toBe(false);
    expect(r.body.hint).toMatch(/EnableLogin/);
    expect(wrote('login_ms365_enabled')).toBeUndefined();
  });

  test('disable removes the IdP and pins the flag to the string false (not a row delete)', async () => {
    // A deleted row would fall back to a fleet-seeded LOGIN_MS365_ENABLED env var
    // via getOrEnv and resurrect the login button with no IdP behind it.
    const r = await request(app).post('/api/setup/login-ms365').send({ enable: false });
    expect(r.body).toMatchObject({ ok: true, enabled: false });
    expect(r.body.note).toMatch(/keep their imported account/i);
    expect(kcAdmin.removeMicrosoftIdp).toHaveBeenCalled();
    expect(wrote('login_ms365_enabled')[1]).toBe('false');
  });

  test('non-admins are refused', async () => {
    mockUser = { id: 'u2', email: 'user@test.com', role: 'contributor' };
    const r = await request(app).post('/api/setup/login-ms365').send({ tenantId: TID, clientId: CID });
    expect(r.status).toBe(403);
  });
});

describe('POST /login-ldap', () => {
  const body = { connectionUrl: 'ldaps://dc1.corp.local:636', bindDn: 'CN=svc', bindCredential: 'pw', usersDn: 'OU=Staff' };

  test('enable provisions the federation and records display fields (never the credential)', async () => {
    const r = await request(app).post('/api/setup/login-ldap').send({ action: 'enable', ...body });
    expect(r.body).toMatchObject({ ok: true, enabled: true });
    expect(kcAdmin.ensureLdapFederation).toHaveBeenCalledWith(body);
    expect(wrote('login_ldap_enabled')[1]).toBe('true');
    expect(wrote('login_ldap_url')[1]).toBe(body.connectionUrl);
    expect(setCalls().some(([, v]) => v === 'pw')).toBe(false);
  });

  test('enable without required fields is refused before touching Keycloak', async () => {
    const r = await request(app).post('/api/setup/login-ldap').send({ action: 'enable', connectionUrl: 'ldaps://dc1:636' });
    expect(r.body.ok).toBe(false);
    expect(kcAdmin.ensureLdapFederation).not.toHaveBeenCalled();
  });

  test('test relays per-stage results', async () => {
    kcAdmin.testLdap.mockResolvedValue({ connection: { ok: true }, authentication: { ok: false, error: 'nope' } });
    const r = await request(app).post('/api/setup/login-ldap').send({ action: 'test', ...body });
    expect(r.body.ok).toBe(false);
    expect(r.body.connection.ok).toBe(true);
    expect(r.body.authentication.error).toBe('nope');
  });

  test('disable removes the federation and pins the flag to the string false', async () => {
    const r = await request(app).post('/api/setup/login-ldap').send({ action: 'disable' });
    expect(r.body).toMatchObject({ ok: true, enabled: false });
    expect(kcAdmin.removeLdapFederation).toHaveBeenCalled();
    expect(wrote('login_ldap_enabled')[1]).toBe('false');
  });

  test('plain ldap:// is refused for enable and test — cleartext passwords', async () => {
    for (const action of ['enable', 'test']) {
      const r = await request(app).post('/api/setup/login-ldap')
        .send({ action, ...body, connectionUrl: 'ldap://dc1.corp.local:389' });
      expect(r.body.ok).toBe(false);
      expect(r.body.error).toMatch(/ldaps/i);
    }
    expect(kcAdmin.ensureLdapFederation).not.toHaveBeenCalled();
    expect(kcAdmin.testLdap).not.toHaveBeenCalled();
    expect(wrote('login_ldap_enabled')).toBeUndefined();
  });
});

describe('GET /status loginMethods', () => {
  test('reports enabled methods and prefill ids', async () => {
    settings.get.mockImplementation(async (k) => (
      { login_ms365_enabled: 'true', login_ms365_tenant_id: TID, login_ms365_client_id: CID, login_ldap_enabled: null }[k] ?? null
    ));
    const r = await request(app).get('/api/setup/status');
    expect(r.body.loginMethods).toEqual({ ms365: true, ms365TenantId: TID, ms365ClientId: CID, ldap: false });
  });
});

describe('POST /integrations empty-resave protection', () => {
  test('graph mode: blank tenant/client ids are not written (no null-clear)', async () => {
    const r = await request(app).post('/api/setup/integrations')
      .send({ emailProvider: 'graph', graphTenantId: '', graphClientId: '', graphCredType: 'secret', graphClientSecret: '' });
    expect(r.body.ok).toBe(true);
    expect(wrote('graph_tenant_id')).toBeUndefined();
    expect(wrote('graph_client_id')).toBeUndefined();
  });

  test('graph mode: supplied tenant/client ids are written', async () => {
    await request(app).post('/api/setup/integrations')
      .send({ emailProvider: 'graph', graphTenantId: TID, graphClientId: CID });
    expect(wrote('graph_tenant_id')[1]).toBe(TID);
    expect(wrote('graph_client_id')[1]).toBe(CID);
  });

  test('cert branch reached via key path alone does not null-clear the thumbprint', async () => {
    await request(app).post('/api/setup/integrations')
      .send({ emailProvider: 'graph', graphCredType: 'cert', graphCertKeyPath: '/secrets/graph.key.pem' });
    expect(wrote('graph_cert_thumbprint')).toBeUndefined();
    expect(wrote('graph_cert_key_path')[1]).toBe('/secrets/graph.key.pem');
  });

  test('smtp mode: a blank form leaves the relay config untouched', async () => {
    await request(app).post('/api/setup/integrations')
      .send({ emailProvider: 'smtp', smtpHost: '', smtpPort: '', smtpUser: '', smtpPass: '' });
    for (const k of ['smtp_host', 'smtp_port', 'smtp_secure', 'smtp_user', 'smtp_pass']) {
      expect(wrote(k)).toBeUndefined();
    }
  });

  test('a blank emailFrom (always posted by the wizard) never deletes email_from', async () => {
    await request(app).post('/api/setup/integrations')
      .send({ emailProvider: 'graph', emailFrom: '' });
    expect(wrote('email_from')).toBeUndefined();
  });

  test('a supplied emailFrom is written', async () => {
    await request(app).post('/api/setup/integrations')
      .send({ emailProvider: 'graph', emailFrom: 'depot@acme.com' });
    expect(wrote('email_from')[1]).toBe('depot@acme.com');
  });

  test('smtp mode: a filled form writes the relay config', async () => {
    await request(app).post('/api/setup/integrations')
      .send({ emailProvider: 'smtp', smtpHost: 'smtp.office365.com', smtpPort: '587', smtpSecure: true, smtpUser: 'depot@x.com' });
    expect(wrote('smtp_host')[1]).toBe('smtp.office365.com');
    expect(wrote('smtp_secure')[1]).toBe('true');
  });
});

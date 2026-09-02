'use strict';
// Keycloak admin REST helpers for the realm configuration Depot manages on the
// operator's behalf: the Microsoft 365 identity provider (OIDC brokering against
// the customer's Entra tenant) and Active Directory user federation (LDAP).
//
// Admin credentials come from the operator environment only (KEYCLOAK_ADMIN_USER/
// KEYCLOAK_ADMIN_PASSWORD) — deliberately not settings-backed, for the same reason
// as the license config: a web admin must not be able to repoint them.
//
// Secrets policy: the LDAP bind credential is handed straight to Keycloak and never
// stored in Depot's own settings/database. On update reads Keycloak masks stored
// secrets as '**********'; sending that mask back preserves the stored value, which
// is what lets "leave blank to keep current" work without Depot holding the secret.
// EXCEPTION (Microsoft 365 Graph delegation): the login client secret is ALSO kept
// in Depot — encrypted at rest with the storage key — so delegated connectors can
// refresh the brokered Graph token themselves (Keycloak doesn't refresh a brokered
// token on read), sparing users an ~hourly re-sign-in.

const settings = require('./settings');
const encryption = require('./encryption');
const SECRET_MASK = '**********';
const MS_ALIAS = 'microsoft';   // must match the SPA's kc_idp_hint
const LDAP_NAME = 'active-directory';

function baseUrl() {
  return String(process.env.KEYCLOAK_INTERNAL_URL || process.env.KEYCLOAK_URL || '').replace(/\/$/, '');
}
function realmName() { return process.env.KEYCLOAK_REALM || 'memex'; }

async function adminToken() {
  const base = baseUrl();
  const user = process.env.KEYCLOAK_ADMIN_USER || 'admin';
  const pass = process.env.KEYCLOAK_ADMIN_PASSWORD;
  if (!base || !pass) throw new Error('Keycloak admin credentials are not available on the server.');
  const r = await fetch(`${base}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: user, password: pass }),
  });
  if (!r.ok) throw new Error(`Keycloak admin auth failed (${r.status}).`);
  return (await r.json()).access_token;
}

async function kc(token, method, path, body) {
  return fetch(`${baseUrl()}/admin/realms/${realmName()}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/* ---------- Realm branding ---------- */

// Keycloak hosts the sign-in page, so its realm display name is the heading a
// customer's staff read while authenticating. Keep it equal to the workspace
// brand so that page never shows an internal name. The realm's *identifier*
// stays fixed — it appears in the broker redirect URI registered with Entra
// and in every token issuer, so renaming it would break live logins.
async function setRealmDisplayName(name) {
  const display = String(name || '').trim() || 'Depot';
  const token = await adminToken();
  const r = await kc(token, 'PUT', '', { realm: realmName(), displayName: display });
  if (!r.ok) throw new Error(`Keycloak realm display-name update failed (${r.status}).`);
  return { displayName: display };
}

/* ---------- Microsoft 365 sign-in (OIDC identity provider) ---------- */

// Delegated Microsoft Graph scopes requested at brokered login when graph
// delegation is enabled. ReadWrite so the token can do whatever the signed-in user
// can do in SharePoint — SharePoint itself is the sole authority per file (a user
// without write access is refused by Graph, which is correct). All resolve to
// graph.microsoft.com (single resource → Graph-audience token); offline_access lets
// the token refresh past its ~1h life. These delegated permissions need admin
// consent on the app registration (Sites.ReadWrite.All / Files.ReadWrite.All are
// high-impact) — but delegated never exceeds what the user could already do.
const MS_GRAPH_DELEGATED_SCOPE =
  'openid profile email offline_access https://graph.microsoft.com/Sites.ReadWrite.All https://graph.microsoft.com/Files.ReadWrite.All';

function msIdpRepresentation({ tenantId, clientId, clientSecret, graphDelegation = false }) {
  // Single-tenant v2.0 endpoints: only accounts from the customer's own Entra
  // tenant can sign in (signInAudience on the app registration also enforces it).
  const authBase = `https://login.microsoftonline.com/${tenantId}`;
  return {
    alias: MS_ALIAS,
    displayName: 'Microsoft 365',
    providerId: 'oidc',
    enabled: true,
    // Entra verifies mailbox ownership for its own tenant; trusting the email
    // claim skips Keycloak's verify-email loop for brokered users.
    trustEmail: true,
    // Store the brokered Azure token ONLY when delegation is on (so connectors can
    // call Graph as the user); and auto-grant the broker `read-token` role on first
    // Microsoft link so the app is allowed to read it back. Off by default → this
    // representation is byte-identical to the pre-delegation one, so simply
    // deploying the feature changes nothing about sign-in.
    storeToken: !!graphDelegation,
    addReadTokenRoleOnCreate: !!graphDelegation,
    firstBrokerLoginFlowAlias: 'first broker login',
    config: {
      issuer: `${authBase}/v2.0`,
      authorizationUrl: `${authBase}/oauth2/v2.0/authorize`,
      tokenUrl: `${authBase}/oauth2/v2.0/token`,
      jwksUrl: `${authBase}/discovery/v2.0/keys`,
      useJwksUrl: 'true',
      validateSignature: 'true',
      clientAuthMethod: 'client_secret_post',
      clientId,
      ...(clientSecret ? { clientSecret } : {}),
      defaultScope: graphDelegation ? MS_GRAPH_DELEGATED_SCOPE : 'openid profile email',
      syncMode: 'IMPORT',
    },
  };
}

// Create or update the provider. A blank clientSecret on update keeps the one
// Keycloak already holds; creating without a secret is an error.
async function ensureMicrosoftIdp({ tenantId, clientId, clientSecret, graphDelegation = false }) {
  const token = await adminToken();
  const rep = msIdpRepresentation({ tenantId, clientId, clientSecret, graphDelegation });
  const cur = await kc(token, 'GET', `/identity-provider/instances/${MS_ALIAS}`);
  if (cur.ok) {
    if (!clientSecret) rep.config.clientSecret = (await cur.json())?.config?.clientSecret || SECRET_MASK;
    const r = await kc(token, 'PUT', `/identity-provider/instances/${MS_ALIAS}`, rep);
    if (!r.ok) throw new Error(`Keycloak identity-provider update failed (${r.status}).`);
    return { created: false };
  }
  if (!clientSecret) throw new Error('A client secret is required to enable Microsoft 365 sign-in.');
  const r = await kc(token, 'POST', '/identity-provider/instances', rep);
  if (!r.ok) throw new Error(`Keycloak identity-provider create failed (${r.status}).`);
  return { created: true };
}

// Ensure EXISTING Microsoft-federated users can read their stored token, not just
// ones created after delegation was turned on. `addReadTokenRoleOnCreate` only grants
// the broker `read-token` role at first-link, so add that role to the realm's default
// role too — every current and future user then holds it. (Local-only users still
// can't retrieve a token — they have no federated identity — so this is safe.)
// Idempotent: re-adding an existing composite is a no-op.
async function ensureBrokerReadTokenDefault() {
  const token = await adminToken();
  const brokerRes = await kc(token, 'GET', '/clients?clientId=broker');
  const broker = brokerRes.ok ? (await brokerRes.json())[0] : null;
  if (!broker) throw new Error('Keycloak has no "broker" client — cannot grant read-token.');
  const roleRes = await kc(token, 'GET', `/clients/${broker.id}/roles/read-token`);
  if (!roleRes.ok) throw new Error(`Keycloak broker read-token role lookup failed (${roleRes.status}).`);
  const readToken = await roleRes.json();
  const defRes = await kc(token, 'GET', `/roles/default-roles-${realmName()}`);
  if (!defRes.ok) throw new Error(`Keycloak default-roles lookup failed (${defRes.status}).`);
  const defRole = await defRes.json();
  const addRes = await kc(token, 'POST', `/roles-by-id/${defRole.id}/composites`,
    [{ id: readToken.id, name: readToken.name, clientRole: true, containerId: broker.id }]);
  if (!addRes.ok && addRes.status !== 409) throw new Error(`Keycloak read-token grant failed (${addRes.status}).`);
}

async function removeMicrosoftIdp() {
  const token = await adminToken();
  const r = await kc(token, 'DELETE', `/identity-provider/instances/${MS_ALIAS}`);
  if (!r.ok && r.status !== 404) throw new Error(`Keycloak identity-provider delete failed (${r.status}).`);
}

// Retrieve the signed-in user's stored Microsoft/Graph token from Keycloak's broker
// endpoint, so a connector can call Graph AS that user (delegated). `userAuthHeader`
// is the user's own Depot Authorization header (their Keycloak access token) — the
// endpoint authenticates the user by it and returns THAT user's Azure token. Requires
// the Microsoft IdP to have storeToken on (graphDelegation) and the caller to hold the
// broker `read-token` role (auto-granted on first Microsoft link). Never uses the
// Keycloak admin credential — this is a per-user, per-request read.
async function getBrokerToken(userAuthHeader) {
  const auth = String(userAuthHeader || '');
  if (!/^Bearer\s+\S+/i.test(auth)) { const e = new Error('Sign in to use this Microsoft 365 connection.'); e.status = 401; throw e; }
  const url = `${baseUrl()}/realms/${realmName()}/broker/${MS_ALIAS}/token`;
  let res;
  try {
    res = await fetch(url, { method: 'GET', headers: { Authorization: auth, Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
  } catch { const e = new Error('Could not reach the identity provider for your Microsoft token.'); e.status = 502; throw e; }
  const body = await res.text();
  if (!res.ok) {
    let msg = body;
    try { const j = JSON.parse(body); msg = j.error_description || j.error || j.errorMessage || body; } catch { /* text body */ }
    // Map Keycloak's broker-token errors to clear, non-leaky guidance (spec §6).
    let userMsg = 'Could not get your Microsoft token.', status = 403;
    if (res.status === 401 || /invalid token/i.test(msg)) { userMsg = 'Your session expired — please sign in again.'; status = 401; }
    else if (/not authorized to retrieve tokens/i.test(msg)) userMsg = 'Your account can’t use Microsoft data yet — sign out and back in with Microsoft.';
    else if (/is not associated with identity provider/i.test(msg)) { userMsg = 'Sign in with your Microsoft 365 account to use this connection.'; status = 400; }
    else if (/does not support this operation/i.test(msg)) userMsg = 'Microsoft 365 delegation isn’t enabled for this workspace.';
    const e = new Error(userMsg); e.status = status; throw e;
  }
  // Keycloak returns the IdP's stored token response verbatim — JSON for Azure OIDC,
  // form-encoded only for legacy OAuth providers. Parse robustly.
  let tok;
  try { tok = JSON.parse(body); } catch { tok = Object.fromEntries(new URLSearchParams(body)); }
  const accessToken = tok && tok.access_token;
  if (!accessToken) { const e = new Error('No Microsoft token available — sign in with Microsoft again.'); e.status = 401; throw e; }
  // The stored `expires_in` is relative to when Keycloak stored it, so a read can
  // hand back an already-expired token. Trust the Azure JWT's own `exp` instead; if
  // it’s past (Keycloak didn’t refresh it), ask the user to re-auth rather than
  // firing a doomed Graph call.
  try {
    const payload = JSON.parse(Buffer.from(String(accessToken).split('.')[1] || '', 'base64url').toString('utf8'));
    if (payload && payload.exp && payload.exp * 1000 <= Date.now() + 30000) {
      // Keycloak won't refresh a brokered token on read, so refresh it ourselves
      // against Entra with the stored refresh token. Only if THAT fails (missing
      // creds, or the refresh token itself is dead) do we ask the user to re-auth.
      const refreshed = await refreshMsGraphToken(tok && tok.refresh_token);
      if (refreshed) return refreshed;
      const e = new Error('Your Microsoft session needs refreshing — sign out and back in with Microsoft.'); e.status = 401; throw e;
    }
  } catch (e) { if (e && e.status) throw e; /* not a decodable JWT → skip the expiry check */ }
  return accessToken;
}

// ---- Microsoft login client secret (encrypted) + delegated token refresh ----

async function _msEncKey() {
  return encryption.resolveKey(await settings.getOrEnv('storage_encryption_key'));
}

// Keep the Microsoft login client secret in Depot, encrypted at rest, so delegated
// connectors can refresh the brokered Graph token. Called from setup when delegation
// is enabled with a secret in hand. Ignores the mask and a missing storage key.
async function storeMsClientSecret(secret) {
  const s = String(secret || '').trim();
  if (!s || s === SECRET_MASK) return;
  const key = await _msEncKey();
  if (!key) return; // no storage key → can't encrypt; refresh just stays unavailable
  await settings.set('login_ms365_client_secret_enc', encryption.encrypt(Buffer.from(s, 'utf8'), key).toString('base64'), null);
}

async function getMsClientSecret() {
  const b64 = await settings.get('login_ms365_client_secret_enc');
  const key = b64 ? await _msEncKey() : null;
  if (!b64 || !key) return null;
  try { return encryption.decrypt(Buffer.from(b64, 'base64'), key).toString('utf8'); }
  catch { return null; }
}

// Refresh the brokered Graph token directly against Entra using the stored refresh
// token (offline_access) + the login client secret. Returns a fresh Graph access
// token, or null if we can't refresh (missing creds, or Entra rejected the refresh
// token — e.g. it expired after ~90d of inactivity), so the caller re-prompts sign-in.
async function refreshMsGraphToken(refreshToken) {
  const rt = String(refreshToken || '').trim();
  if (!rt) return null;
  const tenant = String(await settings.get('login_ms365_tenant_id') || '').trim();
  const clientId = String(await settings.get('login_ms365_client_id') || '').trim();
  const clientSecret = await getMsClientSecret();
  if (!tenant || !clientId || !clientSecret) return null;
  try {
    const r = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: rt,
        client_id: clientId,
        client_secret: clientSecret,
        scope: MS_GRAPH_DELEGATED_SCOPE,
      }).toString(),
      signal: AbortSignal.timeout(10000),
    });
    const data = await r.json().catch(() => ({}));
    if (r.ok && data.access_token) return data.access_token;
  } catch { /* network/timeout → fall through */ }
  return null;
}

// Prove a client secret works BEFORE it is written to Keycloak. A bad paste — the
// secret ID instead of its value, a browser-autofilled password, a truncated copy —
// used to overwrite the working secret and brick every Microsoft sign-in until an
// admin noticed. The client-credentials grant needs no user and no roles: Entra
// answers invalid_client for a wrong secret regardless of what the app may do.
// Returns { ok:true } or { ok:false, reason }. A network failure is a refusal, never
// a pass — writing an unverified secret is the failure mode this exists to prevent.
async function validateMsClientSecret({ tenantId, clientId, clientSecret }) {
  try {
    const r = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
        scope: 'https://graph.microsoft.com/.default',
      }).toString(),
      signal: AbortSignal.timeout(10000),
    });
    const data = await r.json().catch(() => ({}));
    if (r.ok && data.access_token) return { ok: true };
    const desc = String(data.error_description || data.error || `HTTP ${r.status}`);
    // Keep the AADSTS code and its first sentence; drop trace/correlation noise.
    const reason = desc.split(/\.\s|\n/)[0].replace(/\s*Trace ID.*$/i, '').slice(0, 220);
    return { ok: false, reason };
  } catch (e) {
    const why = e && e.name === 'TimeoutError' ? 'timeout' : (e && e.message) || 'network error';
    return { ok: false, reason: `could not reach Microsoft to verify the secret (${why}) — nothing was changed; try again` };
  }
}

/* ---------- MFA (TOTP) for local accounts ---------- */

// Require TOTP enrollment for LOCAL accounts only. Members arriving through
// Microsoft 365 brokering or AD/LDAP federation already authenticated — and
// did MFA — at their own identity provider; stacking a second Depot-only
// authenticator on them is friction with no security gain (a real M365
// sign-in dead-ended on the enrollment screen, 2026-08-28). So the required
// action is never a realm-wide default: it is stamped per-user onto accounts
// that actually sign in with a Depot password.
//
// Limitation, deliberate: a local account created AFTER enabling is not
// auto-stamped — re-save the toggle (idempotent) or set the action on the new
// user in Keycloak. The route surfaces this in its response.
async function setLocalTotpRequirement(enable) {
  const token = await adminToken();
  // Keep the action AVAILABLE either way (people may opt in from their own
  // account console) — but never DEFAULT, which is what hit brokered users.
  const raUrl = '/authentication/required-actions/CONFIGURE_TOTP';
  const cur = await kc(token, 'GET', raUrl);
  const rep = cur.ok ? await cur.json()
    : { alias: 'CONFIGURE_TOTP', name: 'Configure OTP', providerId: 'CONFIGURE_TOTP', priority: 10 };
  const upd = await kc(token, 'PUT', raUrl, { ...rep, enabled: true, defaultAction: false });
  if (!upd.ok) throw new Error(`Keycloak required-action update failed (${upd.status}).`);

  let stamped = 0, cleared = 0, skippedFederated = 0, alreadyEnrolled = 0;
  for (let first = 0; ; first += 100) {
    const page = await kc(token, 'GET', `/users?max=100&first=${first}`);
    if (!page.ok) throw new Error(`Keycloak user list failed (${page.status}).`);
    const users = await page.json();
    if (!Array.isArray(users) || !users.length) break;
    for (const u of users) {
      const pending = Array.isArray(u.requiredActions) ? u.requiredActions : [];
      // AD/LDAP users carry federationLink; brokered (M365) users have
      // federated-identity entries. A local account has neither.
      let federated = !!u.federationLink;
      if (!federated) {
        const fid = await kc(token, 'GET', `/users/${u.id}/federated-identity`);
        federated = fid.ok && ((await fid.json()) || []).length > 0;
      }
      if (federated) {
        skippedFederated += 1;
        // Never leave a federated account holding a stale enrollment prompt.
        if (pending.includes('CONFIGURE_TOTP')) {
          await kc(token, 'PUT', `/users/${u.id}`, { ...u, requiredActions: pending.filter(a => a !== 'CONFIGURE_TOTP') });
        }
        continue;
      }
      if (enable) {
        if (pending.includes('CONFIGURE_TOTP')) continue;
        // Someone already carrying an authenticator has nothing to enroll.
        const creds = await kc(token, 'GET', `/users/${u.id}/credentials`);
        const hasOtp = creds.ok && ((await creds.json()) || []).some((c) => c.type === 'otp');
        if (hasOtp) { alreadyEnrolled += 1; continue; }
        const r = await kc(token, 'PUT', `/users/${u.id}`, { ...u, requiredActions: [...pending, 'CONFIGURE_TOTP'] });
        if (r.ok) stamped += 1;
      } else if (pending.includes('CONFIGURE_TOTP')) {
        const r = await kc(token, 'PUT', `/users/${u.id}`, { ...u, requiredActions: pending.filter(a => a !== 'CONFIGURE_TOTP') });
        if (r.ok) cleared += 1;
      }
    }
    if (users.length < 100) break;
  }
  return { stamped, cleared, skippedFederated, alreadyEnrolled };
}

/* ---------- Active Directory sign-in (LDAP user federation) ---------- */

function ldapConfig({ connectionUrl, bindDn, bindCredential, usersDn }) {
  // AD-vendor defaults; READ_ONLY = passwords are validated against the DC via
  // LDAP bind, nothing is ever written back to the directory.
  return {
    enabled: ['true'],
    priority: ['1'],
    vendor: ['ad'],
    connectionUrl: [connectionUrl],
    usersDn: [usersDn],
    authType: ['simple'],
    bindDn: [bindDn],
    ...(bindCredential ? { bindCredential: [bindCredential] } : {}),
    editMode: ['READ_ONLY'],
    syncRegistrations: ['false'],
    usernameLDAPAttribute: ['sAMAccountName'],
    rdnLDAPAttribute: ['cn'],
    uuidLDAPAttribute: ['objectGUID'],
    userObjectClasses: ['person, organizationalPerson, user'],
    searchScope: ['2'],
    pagination: ['true'],
    trustEmail: ['true'],
  };
}

async function _findLdapComponent(token, realmId) {
  const list = await kc(token, 'GET', `/components?parent=${encodeURIComponent(realmId)}&type=org.keycloak.storage.UserStorageProvider`);
  if (!list.ok) throw new Error(`Keycloak component list failed (${list.status}).`);
  return (await list.json()).find((c) => c.providerId === 'ldap' && c.name === LDAP_NAME) || null;
}

async function _realmId(token) {
  const r = await kc(token, 'GET', '');
  if (!r.ok) throw new Error(`Keycloak realm lookup failed (${r.status}).`);
  return (await r.json()).id;
}

// Create or update the AD federation. A blank bindCredential on update keeps
// the one Keycloak already holds.
async function ensureLdapFederation({ connectionUrl, bindDn, bindCredential, usersDn }) {
  const token = await adminToken();
  const realmId = await _realmId(token);
  const existing = await _findLdapComponent(token, realmId);
  const config = ldapConfig({ connectionUrl, bindDn, bindCredential, usersDn });
  if (existing) {
    if (!bindCredential) config.bindCredential = existing.config?.bindCredential || [SECRET_MASK];
    const r = await kc(token, 'PUT', `/components/${existing.id}`, { ...existing, config });
    if (!r.ok) throw new Error(`Keycloak LDAP federation update failed (${r.status}).`);
    return { created: false };
  }
  if (!bindCredential) throw new Error('A bind credential is required to enable Active Directory sign-in.');
  const r = await kc(token, 'POST', '/components', {
    name: LDAP_NAME,
    providerId: 'ldap',
    providerType: 'org.keycloak.storage.UserStorageProvider',
    parentId: realmId,
    config,
  });
  if (!r.ok) throw new Error(`Keycloak LDAP federation create failed (${r.status}).`);
  return { created: true };
}

async function removeLdapFederation() {
  const token = await adminToken();
  const existing = await _findLdapComponent(token, await _realmId(token));
  if (!existing) return;
  const r = await kc(token, 'DELETE', `/components/${existing.id}`);
  if (!r.ok && r.status !== 404) throw new Error(`Keycloak LDAP federation delete failed (${r.status}).`);
}

// Live connectivity probe via Keycloak (it runs the LDAP dial, so the check
// exercises the same network path real logins will use). Returns per-stage
// results rather than throwing on an unreachable DC.
async function testLdap({ connectionUrl, bindDn, bindCredential }) {
  const token = await adminToken();
  const probe = async (action) => {
    const r = await kc(token, 'POST', '/testLDAPConnection', {
      action,
      connectionUrl,
      authType: 'simple',
      bindDn,
      bindCredential,
      startTls: 'false',
      useTruststoreSpi: 'always',
    });
    if (r.ok) return { ok: true };
    let msg = `failed (${r.status})`;
    try { msg = (await r.json()).errorMessage || msg; } catch { /* keep status text */ }
    return { ok: false, error: msg };
  };
  const connection = await probe('testConnection');
  const authentication = bindDn && bindCredential ? await probe('testAuthentication') : { ok: false, error: 'bind DN and credential required' };
  return { connection, authentication };
}

module.exports = {
  adminToken,
  setRealmDisplayName,
  setLocalTotpRequirement,
  ensureMicrosoftIdp,
  validateMsClientSecret,
  removeMicrosoftIdp,
  getBrokerToken,
  storeMsClientSecret,
  getMsClientSecret,
  refreshMsGraphToken,
  ensureBrokerReadTokenDefault,
  ensureLdapFederation,
  removeLdapFederation,
  testLdap,
  MS_ALIAS,
  LDAP_NAME,
  SECRET_MASK,
};

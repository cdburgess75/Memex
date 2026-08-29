'use strict';
// Keycloak admin REST helpers for the realm configuration Depot manages on the
// operator's behalf: the Microsoft 365 identity provider (OIDC brokering against
// the customer's Entra tenant) and Active Directory user federation (LDAP).
//
// Admin credentials come from the operator environment only (KEYCLOAK_ADMIN_USER/
// KEYCLOAK_ADMIN_PASSWORD) — deliberately not settings-backed, for the same reason
// as the license config: a web admin must not be able to repoint them.
//
// Secrets policy: the IdP client secret and the LDAP bind credential are handed
// straight to Keycloak and never stored in Depot's own settings/database. On
// update reads Keycloak masks stored secrets as '**********'; sending that mask
// back preserves the stored value, which is what lets "leave blank to keep
// current" work without Depot ever holding the secret.

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

function msIdpRepresentation({ tenantId, clientId, clientSecret }) {
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
    storeToken: false,
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
      defaultScope: 'openid profile email',
      syncMode: 'IMPORT',
    },
  };
}

// Create or update the provider. A blank clientSecret on update keeps the one
// Keycloak already holds; creating without a secret is an error.
async function ensureMicrosoftIdp({ tenantId, clientId, clientSecret }) {
  const token = await adminToken();
  const rep = msIdpRepresentation({ tenantId, clientId, clientSecret });
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

async function removeMicrosoftIdp() {
  const token = await adminToken();
  const r = await kc(token, 'DELETE', `/identity-provider/instances/${MS_ALIAS}`);
  if (!r.ok && r.status !== 404) throw new Error(`Keycloak identity-provider delete failed (${r.status}).`);
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
  removeMicrosoftIdp,
  ensureLdapFederation,
  removeLdapFederation,
  testLdap,
  MS_ALIAS,
  LDAP_NAME,
  SECRET_MASK,
};

'use strict';
// First-boot Setup Wizard API (Deployment Blueprint).
//
// On a fresh install nothing is configured, so `setup_completed` is absent and the
// client routes the admin through /setup. These endpoints let the wizard save tenant
// identity, integrations, and performance profiles, run live connectivity tests, and
// (best-effort) turn on MFA via Keycloak — then flip the durable completed flag.
//
// Auth stays with Keycloak: the wizard confirms the admin identity and offers an MFA
// toggle, but the admin's password is set through Keycloak's forced first-login change.
// It does NOT create a parallel credential store.
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const settings = require('../lib/settings');
const email = require('../lib/email');
const kcAdmin = require('../lib/keycloakAdmin');

// Secret keys blanked in the config export (mirrors routes/settings.js SENSITIVE).
const SENSITIVE = new Set([
  'anthropic_api_key', 'openai_api_key', 'storage_s3_access_key_id', 'storage_s3_secret_access_key',
  'supabase_service_role_key', 'google_service_account_key', 'storage_encryption_key', 'backup_download_secret',
  'turn_credential', 'smtp_pass', 'graph_client_secret', 'graph_cert_key',
]);

async function isSetupComplete() {
  try { return String((await settings.get('setup_completed')) || '').toLowerCase() === 'true'; }
  catch { return false; }
}

// Only allow first-boot configuration on a not-yet-completed instance; afterward,
// configuration changes go through the normal admin Settings, not the wizard.
async function requireIncomplete(_req, res, next) {
  if (await isSetupComplete()) return res.status(409).json({ error: 'Setup already completed. Change configuration in Settings.' });
  next();
}

const str = v => (v == null ? '' : String(v));
const trimmedOrNull = v => (str(v).trim() || null);

// GET /api/setup/status — the client decides whether to show the wizard from this.
router.get('/status', auth, async (req, res) => {
  try {
    const g = k => settings.getOrEnv(k);
    res.json({
      required: !(await isSetupComplete()),
      completed: await isSetupComplete(),
      isAdmin: req.user.role === 'admin',
      adminEmail: req.user.email || '',
      tenant: {
        orgName: (await g('brand_name')) || '',
        tenantId: (await g('tenant_id')) || '',
        contactEmail: (await g('tenant_contact_email')) || '',
        logo: (await g('brand_logo')) || '',
        accent: (await g('brand_accent')) || '',
      },
      integrations: {
        aiConfigured: !!(await g('anthropic_api_key')),
        emailProvider: (await g('email_provider')) || 'none',
        emailFrom: (await g('email_from')) || '',
      },
      performance: {
        maxUploadMb: parseInt((await g('max_upload_mb')) || '8192', 10),
        maxUploadFiles: parseInt((await g('max_upload_files')) || '4096', 10),
        minFreeDiskMb: parseInt((await g('min_free_disk_mb')) || '2048', 10),
        backupEnabled: String((await g('backup_enabled')) || '').toLowerCase() === 'true',
        backupIntervalHours: parseInt((await g('backup_interval_hours')) || '24', 10),
      },
      mfaRequired: String((await settings.get('mfa_required')) || '').toLowerCase() === 'true',
      loginMethods: {
        ms365: String((await settings.get('login_ms365_enabled')) || '').toLowerCase() === 'true',
        ms365TenantId: (await settings.get('login_ms365_tenant_id')) || '',
        ms365ClientId: (await settings.get('login_ms365_client_id')) || '',
        ldap: String((await settings.get('login_ldap_enabled')) || '').toLowerCase() === 'true',
      },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/setup/tenant — customer identity.
router.post('/tenant', auth, requireRole('admin'), requireIncomplete, async (req, res) => {
  try {
    await settings.set('brand_name', trimmedOrNull(req.body.orgName), req.user.id);
    await settings.set('tenant_id', trimmedOrNull(req.body.tenantId), req.user.id);
    await settings.set('tenant_contact_email', trimmedOrNull(req.body.contactEmail), req.user.id);
    // Branding: accent set when provided; logo set on a data URI, removed on '' (empty),
    // left untouched when the field is absent (the client only sends it when changed).
    if (req.body.accent) await settings.set('brand_accent', String(req.body.accent), req.user.id);
    if (req.body.logo !== undefined) await settings.set('brand_logo', req.body.logo === '' ? null : String(req.body.logo), req.user.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/setup/integrations — AI + email.
router.post('/integrations', auth, requireRole('admin'), requireIncomplete, async (req, res) => {
  try {
    const set = (k, v) => settings.set(k, v === '' || v == null ? null : String(v), req.user.id);
    if (req.body.anthropicApiKey) await set('anthropic_api_key', req.body.anthropicApiKey);
    if (req.body.anthropicModel) await set('anthropic_model', req.body.anthropicModel);

    const provider = String(req.body.emailProvider || 'none');
    await set('email_provider', provider === 'none' ? null : provider);
    // Truthy-guarded like the fields below: the wizard always posts emailFrom
    // (blank on Back-navigation since the input has no prefill), and Graph email
    // dies entirely without a from address — never let '' delete it.
    if (req.body.emailFrom) await set('email_from', req.body.emailFrom);
    if (provider === 'smtp') {
      // The host is the sentinel for "the form was actually filled in": a blank
      // re-save (Back-navigation renders empty fields) must not null-clear a
      // working relay config or flip smtp_secure off underneath it.
      if (req.body.smtpHost) {
        await set('smtp_host', req.body.smtpHost);
        await set('smtp_port', req.body.smtpPort);
        await set('smtp_secure', String(!!req.body.smtpSecure));
        await set('smtp_user', req.body.smtpUser);
      }
      if (req.body.smtpPass) await set('smtp_pass', req.body.smtpPass);
    } else if (provider === 'graph') {
      // Same protection as the credentials below: only write what was supplied,
      // so an empty re-save can't null-clear provisioning-seeded IDs.
      if (req.body.graphTenantId) await set('graph_tenant_id', req.body.graphTenantId);
      if (req.body.graphClientId) await set('graph_client_id', req.body.graphClientId);
      // Two mutually-exclusive credentials (see lib/email.js graphConfig): a client
      // secret OR a certificate (thumbprint + private key). Whichever the admin picks,
      // clear the other so email.js uses the chosen one — graphConfig prefers a secret
      // when both are present, so a lingering secret would silently shadow a new cert.
      // Either credential branch acts only when the admin actually supplied that
      // credential: an empty save (e.g. a FIRST_BOOT=force wizard re-run clicked
      // through on defaults) must never wipe a working configuration that was
      // seeded out-of-band (provisioning does exactly that on fleet boxes).
      if (String(req.body.graphCredType || 'secret') === 'cert') {
        if (req.body.graphCertThumbprint || req.body.graphCertKey || req.body.graphCertKeyPath) {
          if (req.body.graphCertThumbprint) await set('graph_cert_thumbprint', req.body.graphCertThumbprint);
          // The key comes as a pasted PEM OR a path the container can read (/secrets/*).
          // Store one and clear the other; a pasted key wins, matching graphConfig.
          if (req.body.graphCertKey) {
            await set('graph_cert_key', req.body.graphCertKey);
            await set('graph_cert_key_path', null);
          } else if (req.body.graphCertKeyPath) {
            await set('graph_cert_key_path', req.body.graphCertKeyPath);
            await set('graph_cert_key', null);
          }
          await set('graph_client_secret', null);
        }
      } else if (req.body.graphClientSecret) {
        await set('graph_client_secret', req.body.graphClientSecret);
        await set('graph_cert_thumbprint', null);
        await set('graph_cert_key', null);
        await set('graph_cert_key_path', null);
      }
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/setup/test/ai — live Anthropic reachability check (tests the provided key
// before it is saved). Returns { ok:false, error } rather than a 500 so the wizard can
// show the failure inline.
router.post('/test/ai', auth, requireRole('admin'), async (req, res) => {
  try {
    const key = req.body.anthropicApiKey || (await settings.getOrEnv('anthropic_api_key'));
    if (!key) return res.json({ ok: false, error: 'No API key provided.' });
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: key });
    const model = req.body.anthropicModel || (await settings.getOrEnv('anthropic_model')) || 'claude-sonnet-4-6';
    const m = await client.messages.create({ model, max_tokens: 4, messages: [{ role: 'user', content: 'ping' }] });
    res.json({ ok: true, model, detail: `Reachable · ${m.usage?.input_tokens ?? '?'} in / ${m.usage?.output_tokens ?? '?'} out tokens` });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// POST /api/setup/test/email — send a test email using the SAVED config (the wizard
// saves integrations before calling this).
router.post('/test/email', auth, requireRole('admin'), async (req, res) => {
  try {
    const to = trimmedOrNull(req.body.to) || req.user.email;
    if (!to) return res.json({ ok: false, error: 'No recipient.' });
    const r = await email.sendMail({
      to,
      subject: 'Depot setup: test email',
      text: 'This is a test email from your Depot setup wizard. Receiving it confirms outbound email works.',
    });
    if (r?.sent) return res.json({ ok: true, to, via: r.via });
    res.json({ ok: false, error: r?.reason === 'not_configured' ? 'Email is not configured yet — save the integration first.' : (r?.reason || 'send failed') });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// POST /api/setup/performance — upload guardrails + backup cadence.
router.post('/performance', auth, requireRole('admin'), requireIncomplete, async (req, res) => {
  try {
    const setNum = (k, v, def) => { const n = parseInt(v, 10); return settings.set(k, Number.isFinite(n) && n > 0 ? String(n) : String(def), req.user.id); };
    await setNum('max_upload_mb', req.body.maxUploadMb, 8192);
    await setNum('max_upload_files', req.body.maxUploadFiles, 4096);
    await setNum('min_free_disk_mb', req.body.minFreeDiskMb, 2048);
    await settings.set('backup_enabled', req.body.backupEnabled ? 'true' : null, req.user.id);
    if (req.body.backupEnabled) await setNum('backup_interval_hours', req.body.backupIntervalHours, 24);
    try { await require('../lib/backup').reschedule(); } catch { /* scheduler re-arm is best-effort */ }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/setup/mfa — turn on TOTP as a default required action in Keycloak, so every
// user (incl. the admin) is prompted to set up an authenticator at next login. Best-
// effort: on any failure it returns a hint to enable it in the Keycloak console.
router.post('/mfa', auth, requireRole('admin'), async (req, res) => {
  const enable = req.body.enable !== false;
  try {
    const base = String(process.env.KEYCLOAK_INTERNAL_URL || process.env.KEYCLOAK_URL || '').replace(/\/$/, '');
    const realm = process.env.KEYCLOAK_REALM || 'memex';
    const user = process.env.KEYCLOAK_ADMIN_USER || 'admin';
    const pass = process.env.KEYCLOAK_ADMIN_PASSWORD;
    if (!base || !pass) throw new Error('Keycloak admin credentials are not available on the server.');
    const tokRes = await fetch(`${base}/realms/master/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: user, password: pass }),
    });
    if (!tokRes.ok) throw new Error(`Keycloak admin auth failed (${tokRes.status}).`);
    const accessToken = (await tokRes.json()).access_token;
    // Keycloak's route lives under /authentication/ — the alias alone 404s.
    const upd = await fetch(`${base}/admin/realms/${realm}/authentication/required-actions/CONFIGURE_TOTP`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ alias: 'CONFIGURE_TOTP', name: 'Configure OTP', providerId: 'CONFIGURE_TOTP', enabled: enable, defaultAction: enable, priority: 10 }),
    });
    if (!upd.ok) throw new Error(`Keycloak required-action update failed (${upd.status}).`);
    await settings.set('mfa_required', enable ? 'true' : null, req.user.id);
    res.json({ ok: true, enabled: enable });
  } catch (e) {
    res.json({ ok: false, error: e.message, hint: 'Enable it manually: Keycloak admin console → Authentication → Required Actions → Configure OTP → set as Default.' });
  }
});

// POST /api/setup/login-ms365 — enable/update/disable "Sign in with Microsoft 365".
// Depot provisions the Keycloak OIDC identity provider itself over the admin API;
// the Entra client secret goes straight to Keycloak and is never stored in Depot's
// settings. Like /mfa, this stays callable after setup (Settings → Sign-in methods).
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
router.post('/login-ms365', auth, requireRole('admin'), async (req, res) => {
  const enable = req.body.enable !== false;
  try {
    if (!enable) {
      await kcAdmin.removeMicrosoftIdp();
      // 'false' (not a row delete): these flags are env-seedable via ENV_MAP, and
      // a deleted row would fall back to LOGIN_MS365_ENABLED=true — resurrecting
      // the login button with no IdP behind it.
      await settings.set('login_ms365_enabled', 'false', req.user.id);
      return res.json({
        ok: true, enabled: false,
        note: 'New Microsoft 365 sign-ins are blocked. Users who already signed in keep their imported account (and any active session until it expires) — remove them in Keycloak to fully revoke access.',
      });
    }
    const tenantId = trimmedOrNull(req.body.tenantId) || (await settings.get('login_ms365_tenant_id'));
    const clientId = trimmedOrNull(req.body.clientId) || (await settings.get('login_ms365_client_id'));
    const clientSecret = trimmedOrNull(req.body.clientSecret);   // blank = keep the one Keycloak holds
    if (!GUID.test(tenantId || '')) return res.json({ ok: false, error: 'Entra tenant ID must be a GUID.' });
    if (!GUID.test(clientId || '')) return res.json({ ok: false, error: 'Application (client) ID must be a GUID.' });
    const r = await kcAdmin.ensureMicrosoftIdp({ tenantId, clientId, clientSecret });
    await settings.set('login_ms365_enabled', 'true', req.user.id);
    await settings.set('login_ms365_tenant_id', tenantId, req.user.id);
    await settings.set('login_ms365_client_id', clientId, req.user.id);
    res.json({ ok: true, enabled: true, created: r.created });
  } catch (e) {
    res.json({ ok: false, error: e.message, hint: 'Run setup-graph.ps1 -EnableLogin first, and check the redirect URI …/realms/<realm>/broker/microsoft/endpoint is on the app registration.' });
  }
});

// POST /api/setup/login-ldap — enable/update/disable/test Active Directory sign-in
// (Keycloak LDAP user federation, AD vendor defaults, read-only binds). The bind
// credential also lives only in Keycloak.
router.post('/login-ldap', auth, requireRole('admin'), async (req, res) => {
  const action = String(req.body.action || 'enable');
  const p = {
    connectionUrl: trimmedOrNull(req.body.connectionUrl),
    bindDn: trimmedOrNull(req.body.bindDn),
    bindCredential: trimmedOrNull(req.body.bindCredential),
    usersDn: trimmedOrNull(req.body.usersDn),
  };
  // ldaps:// only: a simple bind over plain ldap:// would put the service
  // account's password — and every user's password at login time — on the wire
  // in cleartext between Keycloak and the domain controller.
  const ldapsOnly = (url) => /^ldaps:\/\//i.test(url || '');
  try {
    if (action === 'disable') {
      await kcAdmin.removeLdapFederation();
      await settings.set('login_ldap_enabled', 'false', req.user.id);   // 'false', not delete — see login-ms365
      return res.json({ ok: true, enabled: false });
    }
    if (!p.connectionUrl) return res.json({ ok: false, error: 'Connection URL is required.' });
    if (!ldapsOnly(p.connectionUrl)) {
      return res.json({ ok: false, error: 'Use ldaps:// (LDAP over TLS, usually port 636). Plain ldap:// sends passwords in cleartext and is not supported.' });
    }
    if (action === 'test') {
      const t = await kcAdmin.testLdap(p);
      return res.json({ ok: t.connection.ok && t.authentication.ok, ...t });
    }
    if (!p.usersDn || !p.bindDn) {
      return res.json({ ok: false, error: 'Connection URL, users DN, and bind DN are required.' });
    }
    const r = await kcAdmin.ensureLdapFederation(p);
    await settings.set('login_ldap_enabled', 'true', req.user.id);
    await settings.set('login_ldap_url', p.connectionUrl, req.user.id);
    await settings.set('login_ldap_users_dn', p.usersDn, req.user.id);
    await settings.set('login_ldap_bind_dn', p.bindDn, req.user.id);
    res.json({ ok: true, enabled: true, created: r.created });
  } catch (e) {
    res.json({ ok: false, error: e.message, hint: 'Use ldaps:// with the DC\'s FQDN where possible; the bind account needs read access to the users OU.' });
  }
});

// GET /api/setup/export — config-only export for replication/DR. Deployment settings
// only (NOT user data); secret values are blanked so the file is a safe template to
// carry to a new instance and fill in.
router.get('/export', auth, requireRole('admin'), async (_req, res) => {
  try {
    const out = {};
    for (const key of Object.keys(settings.ENV_MAP)) {
      const v = await settings.get(key); // DB overrides only, not env defaults
      if (v == null) continue;
      out[key] = SENSITIVE.has(key) ? '' : v;
    }
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="depot-config.json"');
    res.json({ _note: 'Depot deployment config (secret values blanked). Import into a fresh instance and re-enter secrets.', settings: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/setup/complete — flip the durable flag; the client then reloads into the app.
router.post('/complete', auth, requireRole('admin'), requireIncomplete, async (req, res) => {
  try {
    await settings.set('setup_completed', 'true', req.user.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;

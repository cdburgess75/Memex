'use strict';
const db = require('./db');

// Maps setting key → environment variable name (used as fallback when no DB row exists)
const ENV_MAP = {
  anthropic_api_key:              'ANTHROPIC_API_KEY',
  anthropic_model:                'ANTHROPIC_MODEL',
  anthropic_models:               'ANTHROPIC_MODELS',
  openai_api_key:                 'OPENAI_API_KEY',
  openai_base_url:                'OPENAI_BASE_URL',
  openai_models:                  'OPENAI_MODELS',
  ai_endpoints:                   'AI_ENDPOINTS',
  ai_active_model:                'AI_ACTIVE_MODEL',
  storage_provider:               'STORAGE_PROVIDER',
  storage_local_path:             'STORAGE_LOCAL_PATH',
  storage_s3_bucket:              'STORAGE_S3_BUCKET',
  storage_s3_region:              'STORAGE_S3_REGION',
  storage_s3_endpoint:            'STORAGE_S3_ENDPOINT',
  storage_s3_force_path_style:    'STORAGE_S3_FORCE_PATH_STYLE',
  storage_s3_access_key_id:       'STORAGE_S3_ACCESS_KEY_ID',
  storage_s3_secret_access_key:   'STORAGE_S3_SECRET_ACCESS_KEY',
  supabase_url:                   'SUPABASE_URL',
  supabase_service_role_key:      'SUPABASE_SERVICE_ROLE_KEY',
  storage_encryption_key:         'STORAGE_ENCRYPTION_KEY',
  app_url:                        'APP_URL',
  collabora_enabled:              'COLLABORA_ENABLED',
  collabora_url:                  'COLLABORA_URL',
  collabora_internal_url:         'COLLABORA_INTERNAL_URL',
  wopi_internal_url:              'WOPI_INTERNAL_URL',
  google_drive_folder_id:         'GOOGLE_DRIVE_FOLDER_ID',
  google_service_account_key:     'GOOGLE_SERVICE_ACCOUNT_KEY',
  bind_address:                   'BIND_ADDRESS',
  trust_proxy:                    'TRUST_PROXY',
  cors_origins:                   'CORS_ORIGINS',
  http_proxy:                     'HTTP_PROXY',
  max_upload_mb:                  'MAX_UPLOAD_MB',
  max_upload_files:               'MAX_UPLOAD_FILES',
  min_free_disk_mb:               'MIN_FREE_DISK_MB',
  trash_retention_days:           'TRASH_RETENTION_DAYS',
  max_document_versions:          'MAX_DOCUMENT_VERSIONS',
  compliance_soc2_enabled:        'COMPLIANCE_SOC2_ENABLED',
  compliance_hipaa_enabled:       'COMPLIANCE_HIPAA_ENABLED',
  compliance_gdpr_enabled:        'COMPLIANCE_GDPR_ENABLED',
  compliance_pci_dss_enabled:     'COMPLIANCE_PCI_DSS_ENABLED',
  compliance_iso27001_enabled:    'COMPLIANCE_ISO27001_ENABLED',
  compliance_cmmc_enabled:        'COMPLIANCE_CMMC_ENABLED',
  backup_enabled:                 'BACKUP_ENABLED',
  backup_interval_hours:          'BACKUP_INTERVAL_HOURS',
  backup_retention:               'BACKUP_RETENTION',
  backup_destinations:            'BACKUP_DESTINATIONS',
  backup_download_secret:         'BACKUP_DOWNLOAD_SECRET',
  stun_url:                       'STUN_URL',
  turn_url:                       'TURN_URL',
  turn_username:                  'TURN_USERNAME',
  turn_credential:                'TURN_CREDENTIAL',
  screenconnect_url:              'SCREENCONNECT_URL',
  email_provider:                 'EMAIL_PROVIDER',
  email_from:                     'EMAIL_FROM',
  smtp_host:                      'SMTP_HOST',
  smtp_port:                      'SMTP_PORT',
  smtp_secure:                    'SMTP_SECURE',
  smtp_user:                      'SMTP_USER',
  smtp_pass:                      'SMTP_PASS',
  smtp_reject_unauthorized:       'SMTP_REJECT_UNAUTHORIZED',
  smtp_require_tls:               'SMTP_REQUIRE_TLS',
  graph_tenant_id:                'GRAPH_TENANT_ID',
  graph_client_id:                'GRAPH_CLIENT_ID',
  graph_client_secret:            'GRAPH_CLIENT_SECRET',
  graph_cert_thumbprint:          'GRAPH_CERT_THUMBPRINT',
  graph_cert_key:                 'GRAPH_CERT_KEY',
  graph_cert_key_path:            'GRAPH_CERT_KEY_PATH',
  email_ev_share_granted:         'EMAIL_EV_SHARE_GRANTED',
  email_ev_share_downloaded:      'EMAIL_EV_SHARE_DOWNLOADED',
  email_ev_upload_received:       'EMAIL_EV_UPLOAD_RECEIVED',
  email_ev_document_edited:       'EMAIL_EV_DOCUMENT_EDITED',
  brand_name:                     'BRAND_NAME',
  brand_logo:                     'BRAND_LOGO',
  brand_accent:                   'BRAND_ACCENT',
  tenant_id:                      'TENANT_ID',
  tenant_contact_email:           'TENANT_CONTACT_EMAIL',
  // NOTE: license config (LICENSE_PUBLIC_KEY / LICENSE_PUBLIC_KEY_PATH / LICENSE_FILE)
  // and the one-click updater command (MEMEX_UPDATE_COMMAND) are deliberately ABSENT
  // here. They are read from the operator environment only (see server/lib/license.js
  // and server/routes/license.js), so a customer's own web admin can neither swap the
  // license trust anchor to forge an entitlement nor turn the updater into an RCE.
};

const cache = new Map();
let lastFetch = 0;
const TTL = 30_000;

async function refresh() {
  try {
    const rows = await db.query('SELECT key, value FROM system_settings');
    cache.clear();
    for (const row of rows) if (row.value !== null) cache.set(row.key, row.value);
    lastFetch = Date.now();
  } catch {
    // DB may not be ready on first boot — env vars still work
  }
}

async function _ensureFresh() {
  if (Date.now() - lastFetch > TTL) await refresh();
}

// DB value only (null if not set)
async function get(key) {
  await _ensureFresh();
  return cache.get(key) ?? null;
}

// DB value, falling back to the corresponding env var
async function getOrEnv(key) {
  const dbVal = await get(key);
  return dbVal ?? (ENV_MAP[key] ? (process.env[ENV_MAP[key]] || null) : null);
}

async function set(key, value, userId) {
  if (value === null || value === undefined || value === '') {
    await db.query('DELETE FROM system_settings WHERE key = $1', [key]);
    cache.delete(key);
  } else {
    await db.query(
      `INSERT INTO system_settings (key, value, updated_at, updated_by)
       VALUES ($1, $2, NOW(), $3)
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value, updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
      [key, value, userId]
    );
    cache.set(key, value);
  }
}

function _reset() { cache.clear(); lastFetch = 0; }

module.exports = { get, getOrEnv, set, refresh, ENV_MAP, _reset };

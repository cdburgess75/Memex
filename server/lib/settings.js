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
  google_drive_folder_id:         'GOOGLE_DRIVE_FOLDER_ID',
  google_service_account_key:     'GOOGLE_SERVICE_ACCOUNT_KEY',
  bind_address:                   'BIND_ADDRESS',
  trust_proxy:                    'TRUST_PROXY',
  cors_origins:                   'CORS_ORIGINS',
  http_proxy:                     'HTTP_PROXY',
  max_upload_mb:                  'MAX_UPLOAD_MB',
  trash_retention_days:           'TRASH_RETENTION_DAYS',
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

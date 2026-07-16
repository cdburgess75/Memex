'use strict';
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const settings = require('../lib/settings');
const db = require('../lib/db');

const ALL_KEYS = Object.keys(settings.ENV_MAP);

const SENSITIVE = new Set([
  'anthropic_api_key',
  'openai_api_key',
  'storage_s3_access_key_id',
  'storage_s3_secret_access_key',
  'supabase_service_role_key',
  'google_service_account_key',
  'storage_encryption_key',
  'backup_download_secret',
  'turn_credential',
  'smtp_pass',
  'graph_client_secret',
  'graph_cert_key',
]);

const MASKED = '●●●●●●●●';

function parseEndpoints(json) {
  if (!json) return [];
  try { const p = JSON.parse(json); return Array.isArray(p) ? p : []; } catch { return []; }
}

// ai_endpoints is a JSON array whose api_key fields are secrets — mask each for GET.
function maskEndpoints(json) {
  const arr = parseEndpoints(json).map(e => ({ ...e, api_key: e.api_key ? MASKED : '' }));
  return JSON.stringify(arr);
}

// On PUT, a still-masked api_key means "keep current" — restore it from the stored endpoint (by id),
// or from the legacy single openai_api_key when migrating that endpoint for the first time.
function mergeEndpointSecrets(incomingJson, storedJson, legacyKey) {
  const stored = parseEndpoints(storedJson);
  const arr = parseEndpoints(incomingJson).map(e => {
    if (e.api_key === MASKED) {
      const prev = stored.find(s => s.id === e.id);
      return { ...e, api_key: prev ? (prev.api_key || '') : (legacyKey || '') };
    }
    return e;
  });
  return JSON.stringify(arr);
}

// On PUT, a still-masked secret_access_key means "keep current" — restore it from
// the stored destination (matched by id, else by position) so a GET→PUT round-trip
// can't overwrite a real S3 backup secret with the mask string.
function mergeBackupSecrets(incomingJson, storedJson) {
  const stored = parseEndpoints(storedJson);
  const arr = parseEndpoints(incomingJson).map((d, i) => {
    if (d.secret_access_key === MASKED) {
      const prev = (d.id != null && stored.find(s => s.id === d.id)) || stored[i];
      return { ...d, secret_access_key: prev ? (prev.secret_access_key || '') : '' };
    }
    return d;
  });
  return JSON.stringify(arr);
}

// GET /api/admin/settings
router.get('/', auth, requireRole('admin'), async (req, res) => {
  try {
    await settings.refresh();
    const result = {};
    for (const key of ALL_KEYS) {
      const effective = await settings.getOrEnv(key);
      result[key] = (SENSITIVE.has(key) && effective) ? MASKED : (effective ?? '');
    }
    result.ai_endpoints = maskEndpoints(result.ai_endpoints);
    // backup_destinations is a JSON array with embedded S3 secrets — mask them too.
    result.backup_destinations = JSON.stringify(
      parseEndpoints(result.backup_destinations).map(d => ({ ...d, secret_access_key: d.secret_access_key ? MASKED : '' }))
    );
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/admin/settings
router.put('/', auth, requireRole('admin'), async (req, res) => {
  try {
    // Guard the encryption key: changing it silently makes every already-stored local
    // file undecryptable (GCM auth-tag failure on read). Refuse a real change while
    // encrypted files exist unless the caller explicitly confirms. A masked value means
    // "unchanged" and is left to the loop below to skip.
    const incomingKey = req.body.storage_encryption_key;
    if (incomingKey && incomingKey !== MASKED && !req.body.confirm_key_change) {
      const current = await settings.getOrEnv('storage_encryption_key');
      const provider = (await settings.getOrEnv('storage_provider')) || 'local';
      if (incomingKey !== current && provider === 'local') {
        const row = await db.queryOne('SELECT COUNT(*)::int AS n FROM documents WHERE deleted_at IS NULL');
        if (row && row.n > 0) {
          return res.status(409).json({
            code: 'ENC_KEY_CHANGE_BLOCKED',
            affected: row.n,
            error: `Changing the storage encryption key will make all ${row.n} existing file(s) permanently undecryptable. Re-send with "confirm_key_change": true only if you understand this.`,
          });
        }
      }
    }

    for (const [key, value] of Object.entries(req.body)) {
      if (!ALL_KEYS.includes(key)) continue;
      if (SENSITIVE.has(key) && value === MASKED) continue; // user didn't change it
      if (key === 'ai_endpoints') {
        const merged = mergeEndpointSecrets(value, await settings.getOrEnv('ai_endpoints'), await settings.getOrEnv('openai_api_key'));
        await settings.set(key, merged === '[]' ? null : merged, req.user.id);
        continue;
      }
      if (key === 'backup_destinations') {
        const merged = mergeBackupSecrets(value, await settings.getOrEnv('backup_destinations'));
        await settings.set(key, merged === '[]' ? null : merged, req.user.id);
        continue;
      }
      await settings.set(key, value === '' ? null : value, req.user.id);
    }
    await settings.refresh();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

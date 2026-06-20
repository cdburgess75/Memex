'use strict';
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const settings = require('../lib/settings');

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
    for (const [key, value] of Object.entries(req.body)) {
      if (!ALL_KEYS.includes(key)) continue;
      if (SENSITIVE.has(key) && value === MASKED) continue; // user didn't change it
      if (key === 'ai_endpoints') {
        const merged = mergeEndpointSecrets(value, await settings.getOrEnv('ai_endpoints'), await settings.getOrEnv('openai_api_key'));
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

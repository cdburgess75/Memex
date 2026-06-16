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
]);

const MASKED = '●●●●●●●●';

// GET /api/admin/settings
router.get('/', auth, requireRole('admin'), async (req, res) => {
  try {
    await settings.refresh();
    const result = {};
    for (const key of ALL_KEYS) {
      const effective = await settings.getOrEnv(key);
      result[key] = (SENSITIVE.has(key) && effective) ? MASKED : (effective ?? '');
    }
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
      await settings.set(key, value === '' ? null : value, req.user.id);
    }
    await settings.refresh();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

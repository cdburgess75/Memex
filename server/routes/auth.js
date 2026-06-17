const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const profiles = require('../lib/profiles');

const MAX_AVATAR_CHARS = 3_000_000; // generous guard (~2.2 MB); the client downscales before upload

// GET /api/auth/me — Keycloak identity overlaid with the local profile (name + avatar).
// Avatar falls back to the IdP picture (365/Google) when the user hasn't set their own.
router.get('/me', auth, async (req, res) => {
  const keycloakName = req.user.user_metadata?.full_name ?? req.user.email;
  let profile = null;
  try { profile = await profiles.getProfile(req.user.id); } catch { /* table may not exist yet */ }
  res.json({
    id: req.user.id,
    email: req.user.email,
    role: req.user.role,
    name: (profile?.display_name || keycloakName),
    avatar: profile?.avatar || req.user.idp_avatar || null,
  });
});

// GET /api/auth/profile — the caller's editable profile
router.get('/profile', auth, async (req, res) => {
  try {
    const p = await profiles.getProfile(req.user.id);
    res.json({ display_name: p?.display_name || '', avatar: p?.avatar || '' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/auth/profile — update display name and/or avatar (data URL)
router.put('/profile', auth, async (req, res) => {
  try {
    const display_name = typeof req.body?.display_name === 'string' ? req.body.display_name.trim().slice(0, 200) : undefined;
    let avatar = typeof req.body?.avatar === 'string' ? req.body.avatar : undefined;
    if (avatar && avatar.length > MAX_AVATAR_CHARS) return res.status(413).json({ error: 'Image too large even after resizing — try a different photo' });
    if (avatar && !/^data:image\//.test(avatar) && avatar !== '') return res.status(400).json({ error: 'avatar must be an image data URL' });
    const saved = await profiles.setProfile(req.user, { display_name, avatar });
    res.json({ display_name: saved?.display_name || '', avatar: saved?.avatar || '' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

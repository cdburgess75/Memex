'use strict';
const { serverError } = require('../lib/httpError');
// Per-user, cross-device UI preferences (pinned libraries + favorite files). Stored
// server-side so they follow the user, with the client keeping a localStorage cache.
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const db = require('../lib/db');

// Defensive caps so a client can't store an unbounded blob under a user's row.
const MAX_PINNED = 500;
const MAX_FAVORITES = 5000;

function idList(v, cap) {
  if (!Array.isArray(v)) return [];
  const seen = new Set();
  const out = [];
  for (const x of v) {
    const s = String(x);
    if (s && !seen.has(s)) { seen.add(s); out.push(s); if (out.length >= cap) break; }
  }
  return out;
}

// GET /api/preferences — the caller's saved preferences (empty defaults if none/unavailable).
router.get('/', auth, async (req, res) => {
  try {
    const row = await db.queryOne(
      'SELECT pinned_libraries, favorite_files, start_library FROM user_preferences WHERE user_id = $1',
      [req.user.id]
    );
    res.json({
      pinnedLibraries: row?.pinned_libraries || [],
      favoriteFiles: row?.favorite_files || [],
      startLibrary: row?.start_library || null,
    });
  } catch {
    // Degrade gracefully (e.g. the table isn't migrated yet) rather than 500 — the
    // client falls back to its localStorage cache.
    res.json({ pinnedLibraries: [], favoriteFiles: [] });
  }
});

// PUT /api/preferences — replace the caller's preferences with the provided sets.
// startLibrary is changed only when the body names it (an id, or null to clear it), so
// a page that does not know about it never wipes it.
router.put('/', auth, async (req, res) => {
  try {
    const pins = idList(req.body?.pinnedLibraries, MAX_PINNED);
    const favs = idList(req.body?.favoriteFiles, MAX_FAVORITES);
    const setStart = req.body && Object.prototype.hasOwnProperty.call(req.body, 'startLibrary');
    const start = setStart && req.body.startLibrary != null ? String(req.body.startLibrary).slice(0, 64) : null;
    const row = await db.queryOne(
      `INSERT INTO user_preferences (user_id, pinned_libraries, favorite_files, start_library, updated_at)
       VALUES ($1, $2::jsonb, $3::jsonb, $5, NOW())
       ON CONFLICT (user_id) DO UPDATE
         SET pinned_libraries = EXCLUDED.pinned_libraries,
             favorite_files   = EXCLUDED.favorite_files,
             start_library    = CASE WHEN $4 THEN EXCLUDED.start_library ELSE user_preferences.start_library END,
             updated_at       = NOW()
       RETURNING start_library`,
      [req.user.id, JSON.stringify(pins), JSON.stringify(favs), setStart, start]
    );
    res.json({ ok: true, pinnedLibraries: pins, favoriteFiles: favs, startLibrary: row?.start_library || null });
  } catch (e) {
    serverError(res, e);
  }
});

module.exports = router;

'use strict';
// Update check: compares the running VERSION against published release tags on
// GitHub and reports how many releases behind we are. Cached to respect the
// unauthenticated GitHub API rate limit (60/hr per IP).
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const fs = require('fs');
const path = require('path');

const REPO = process.env.MEMEX_REPO || 'cdburgess75/Memex';

function readVersion() {
  try { return fs.readFileSync(path.join(__dirname, '..', '..', 'VERSION'), 'utf8').trim() || 'dev'; }
  catch { return 'dev'; }
}
function parseV(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(String(v || '').trim());
  return m ? [+m[1], +m[2], +m[3], +m[4]] : null;
}
function cmpV(a, b) { for (let i = 0; i < 4; i++) { if (a[i] !== b[i]) return a[i] - b[i]; } return 0; }

let cache = null; // { at, data }

router.get('/check', auth, async (req, res) => {
  const current = readVersion();
  if (cache && Date.now() - cache.at < 10 * 60 * 1000) {
    return res.json({ current, ...cache.data, cached: true });
  }
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/tags?per_page=100`, {
      headers: { 'User-Agent': 'memex-update-check', Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) throw new Error('GitHub API ' + r.status);
    const tags = await r.json();
    const cur = parseV(current);
    const vers = (Array.isArray(tags) ? tags : [])
      .map(t => ({ v: parseV(t && t.name), name: t && t.name }))
      .filter(x => x.v)
      .sort((a, b) => cmpV(b.v, a.v)); // newest first
    const latest = vers[0] ? vers[0].name : null;
    const behind = cur ? vers.filter(x => cmpV(x.v, cur) > 0).length : null;
    const data = { latest, behind, checkedAt: new Date().toISOString() };
    cache = { at: Date.now(), data };
    res.json({ current, ...data });
  } catch (e) {
    res.json({ current, latest: null, behind: null, error: e.message });
  }
});

module.exports = router;

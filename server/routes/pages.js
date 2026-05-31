'use strict';
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const db = require('../lib/db');

// GET /api/pages/search?q=text
router.get('/search', auth, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);
  try {
    const rows = await db.query('SELECT * FROM search_pages($1)', [q]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/pages
router.get('/', auth, async (req, res) => {
  try {
    const rows = await db.query('SELECT * FROM pages ORDER BY updated_at DESC');
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/pages/:id/versions
router.get('/:id/versions', auth, async (req, res) => {
  try {
    const rows = await db.query(
      `SELECT id, page_id, title, category, saved_at, saved_by_email
       FROM page_versions WHERE page_id = $1 ORDER BY saved_at DESC LIMIT 20`,
      [req.params.id]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/pages/:id/restore/:versionId
router.post('/:id/restore/:versionId', auth, requireRole('admin', 'contributor'), async (req, res) => {
  const { id, versionId } = req.params;
  try {
    const version = await db.queryOne(
      'SELECT * FROM page_versions WHERE id = $1 AND page_id = $2',
      [versionId, id]
    );
    if (!version) return res.status(404).json({ error: 'Version not found' });

    const current = await db.queryOne('SELECT sources FROM pages WHERE id = $1', [id]);
    const sources = current?.sources ?? 0;

    const restored = await db.queryOne(
      `INSERT INTO pages (id, title, category, content, sources, updated_at, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET
         title = EXCLUDED.title, category = EXCLUDED.category,
         content = EXCLUDED.content, sources = EXCLUDED.sources,
         updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by
       RETURNING *`,
      [id, version.title, version.category, version.content, sources, new Date().toISOString(), req.user.id]
    );
    res.json(restored);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/pages/:id — create or update a page (upsert by slug id)
router.put('/:id', auth, requireRole('admin', 'contributor'), async (req, res) => {
  const { id } = req.params;
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) {
    return res.status(400).json({ error: 'Invalid page ID format' });
  }
  const { title, category, content, sources } = req.body;

  try {
    const existing = await db.queryOne(
      'SELECT id, sources, title, category, content FROM pages WHERE id = $1',
      [id]
    );

    let row;
    if (existing) {
      await db.query(
        `INSERT INTO page_versions (page_id, title, category, content, saved_by, saved_by_email)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [existing.id, existing.title, existing.category, existing.content, req.user.id, req.user.email]
      );
      row = await db.queryOne(
        `UPDATE pages SET title = $1, category = $2, content = $3, sources = $4,
         updated_at = $5, updated_by = $6 WHERE id = $7 RETURNING *`,
        [title, category, content, sources, new Date().toISOString(), req.user.id, id]
      );
    } else {
      row = await db.queryOne(
        `INSERT INTO pages (id, title, category, content, sources, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [id, title, category, content, sources, req.user.id, req.user.id]
      );
    }

    res.json(row);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/pages/:id
router.delete('/:id', auth, requireRole('admin'), async (req, res) => {
  try {
    await db.query('DELETE FROM pages WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/pages — wipe all pages
router.delete('/', auth, requireRole('admin'), async (req, res) => {
  try {
    await db.query('DELETE FROM pages');
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

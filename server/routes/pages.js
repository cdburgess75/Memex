const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const { createClient } = require('@supabase/supabase-js');

function db() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

// GET /api/pages/search?q=text — full-text search via Postgres function
router.get('/search', auth, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);

  const { data, error } = await db().rpc('search_pages', { query_text: q });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// GET /api/pages — fetch all wiki pages
router.get('/', auth, async (req, res) => {
  const { data, error } = await db().from('pages').select('*').order('updated_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// GET /api/pages/:id/versions — list version history for a page
router.get('/:id/versions', auth, async (req, res) => {
  const { data, error } = await db()
    .from('page_versions')
    .select('id, page_id, title, category, saved_at, saved_by_email')
    .eq('page_id', req.params.id)
    .order('saved_at', { ascending: false })
    .limit(20);

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/pages/:id/restore/:versionId — restore a page to a previous version
router.post('/:id/restore/:versionId', auth, requireRole('admin', 'contributor'), async (req, res) => {
  const { id, versionId } = req.params;
  const client = db();

  const { data: version, error: vErr } = await client
    .from('page_versions')
    .select('*')
    .eq('id', versionId)
    .eq('page_id', id)
    .maybeSingle();

  if (vErr) return res.status(500).json({ error: vErr.message });
  if (!version) return res.status(404).json({ error: 'Version not found' });

  // Preserve current sources count
  const { data: current } = await client.from('pages').select('sources').eq('id', id).maybeSingle();
  const sources = current?.sources ?? 0;

  const { data: restored, error: uErr } = await client
    .from('pages')
    .upsert({
      id,
      title: version.title,
      category: version.category,
      content: version.content,
      sources,
      updated_at: new Date().toISOString(),
      updated_by: req.user.id,
    })
    .select()
    .single();

  if (uErr) return res.status(500).json({ error: uErr.message });
  res.json(restored);
});

// PUT /api/pages/:id — create or update a page (upsert by slug id)
router.put('/:id', auth, requireRole('admin', 'contributor'), async (req, res) => {
  const { id } = req.params;
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) {
    return res.status(400).json({ error: 'Invalid page ID format' });
  }
  const { title, category, content, sources } = req.body;
  const client = db();

  const { data: existing } = await client.from('pages').select('id, sources, title, category, content').eq('id', id).maybeSingle();

  let result;
  if (existing) {
    // Save old version before updating
    await client.from('page_versions').insert({
      page_id: existing.id,
      title: existing.title,
      category: existing.category,
      content: existing.content,
      saved_by: req.user.id,
      saved_by_email: req.user.email,
    });

    result = await client
      .from('pages')
      .update({ title, category, content, sources, updated_at: new Date().toISOString(), updated_by: req.user.id })
      .eq('id', id)
      .select()
      .single();
  } else {
    result = await client
      .from('pages')
      .insert({ id, title, category, content, sources, created_by: req.user.id, updated_by: req.user.id })
      .select()
      .single();
  }

  if (result.error) return res.status(500).json({ error: result.error.message });
  res.json(result.data);
});

// DELETE /api/pages/:id — delete one page
router.delete('/:id', auth, requireRole('admin'), async (req, res) => {
  const { error } = await db().from('pages').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// DELETE /api/pages — wipe all pages (erase wiki)
router.delete('/', auth, requireRole('admin'), async (req, res) => {
  const { error } = await db().from('pages').delete().neq('id', '');
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

module.exports = router;

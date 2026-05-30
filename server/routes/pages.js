const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { createClient } = require('@supabase/supabase-js');

function db() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

// GET /api/pages — fetch all wiki pages
router.get('/', auth, async (req, res) => {
  const { data, error } = await db().from('pages').select('*').order('updated_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// PUT /api/pages/:id — create or update a page (upsert by slug id)
router.put('/:id', auth, async (req, res) => {
  const { id } = req.params;
  const { title, category, content, sources } = req.body;
  const client = db();

  const { data: existing } = await client.from('pages').select('id, sources').eq('id', id).maybeSingle();

  let result;
  if (existing) {
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
router.delete('/:id', auth, async (req, res) => {
  const { error } = await db().from('pages').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// DELETE /api/pages — wipe all pages (erase wiki)
router.delete('/', auth, async (req, res) => {
  const { error } = await db().from('pages').delete().neq('id', '');
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

module.exports = router;

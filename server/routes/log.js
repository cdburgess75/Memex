const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { createClient } = require('@supabase/supabase-js');

router.get('/', auth, async (req, res) => {
  const { data, error } = await createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
    .from('activity_log')
    .select('id, event, user_email, created_at')
    .order('created_at', { ascending: false })
    .limit(40);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

module.exports = router;

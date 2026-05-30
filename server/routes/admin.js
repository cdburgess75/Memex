const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { createClient } = require('@supabase/supabase-js');

function db() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

// GET /api/admin/stats
router.get('/stats', auth, async (req, res) => {
  const client = db();

  try {
    const [pagesResult, activityResult] = await Promise.all([
      client.from('pages').select('id', { count: 'exact', head: true }),
      client
        .from('activity_log')
        .select('user_email, created_at')
        .order('created_at', { ascending: false })
        .limit(100),
    ]);

    if (pagesResult.error) throw pagesResult.error;
    if (activityResult.error) throw activityResult.error;

    const pageCount = pagesResult.count ?? 0;
    const recentActivity = (activityResult.data || []).slice(0, 20);

    // Tally contributions per email across the full 100-row window
    const tally = {};
    for (const row of activityResult.data || []) {
      const email = row.user_email || 'unknown';
      tally[email] = (tally[email] || 0) + 1;
    }
    const topContributors = Object.entries(tally)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([email, count]) => ({ email, count }));

    res.json({ pageCount, recentActivity, topContributors });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

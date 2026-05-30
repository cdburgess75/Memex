const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const { createClient } = require('@supabase/supabase-js');

function db() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function adminClient() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

// GET /api/admin/stats
router.get('/stats', auth, requireRole('admin'), async (req, res) => {
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

// GET /api/admin/users — list all users with their roles
router.get('/users', auth, requireRole('admin'), async (req, res) => {
  try {
    const ac = adminClient();
    const { data: { users } } = await ac.auth.admin.listUsers();
    const { data: roles } = await ac.from('user_roles').select('*');
    const roleMap = Object.fromEntries((roles || []).map(r => [r.user_id, r]));
    const result = users.map(u => ({
      user_id: u.id,
      email: u.email,
      role: roleMap[u.id]?.role || 'contributor',
      assigned_at: roleMap[u.id]?.assigned_at || u.created_at,
    }));
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/admin/users/:userId/role — update a user's role
router.put('/users/:userId/role', auth, requireRole('admin'), async (req, res) => {
  const { userId } = req.params;
  const { role } = req.body;

  const validRoles = ['admin', 'contributor', 'viewer'];
  if (!validRoles.includes(role)) {
    return res.status(400).json({ error: `role must be one of: ${validRoles.join(', ')}` });
  }

  try {
    const client = db();
    const { error } = await client.from('user_roles').upsert({
      user_id: userId,
      role,
      assigned_by: req.user.id,
      assigned_at: new Date().toISOString(),
    });

    if (error) throw error;
    res.json({ role });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/usage — token usage stats for the current month
router.get('/usage', auth, requireRole('admin'), async (req, res) => {
  try {
    const client = db();
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const { data: monthRows, error: mErr } = await client
      .from('api_usage')
      .select('*')
      .gte('created_at', startOfMonth);

    if (mErr) throw mErr;

    const rows = monthRows || [];

    // thisMonth totals
    const totalInput = rows.reduce((s, r) => s + (r.input_tokens || 0), 0);
    const totalOutput = rows.reduce((s, r) => s + (r.output_tokens || 0), 0);
    const costUsd = (totalInput / 1_000_000 * 3.00) + (totalOutput / 1_000_000 * 15.00);

    // byUser
    const userMap = {};
    for (const r of rows) {
      const key = r.user_email || r.user_id || 'unknown';
      if (!userMap[key]) userMap[key] = { user_email: key, input_tokens: 0, output_tokens: 0 };
      userMap[key].input_tokens += r.input_tokens || 0;
      userMap[key].output_tokens += r.output_tokens || 0;
    }
    const byUser = Object.values(userMap).map(u => ({
      ...u,
      cost_usd: (u.input_tokens / 1_000_000 * 3.00) + (u.output_tokens / 1_000_000 * 15.00),
    }));

    // byOperation
    const opMap = {};
    for (const r of rows) {
      const key = r.operation || 'unknown';
      if (!opMap[key]) opMap[key] = { operation: key, input_tokens: 0, output_tokens: 0 };
      opMap[key].input_tokens += r.input_tokens || 0;
      opMap[key].output_tokens += r.output_tokens || 0;
    }
    const byOperation = Object.values(opMap);

    // daily (last 30 days)
    const { data: dailyRows, error: dErr } = await client
      .from('api_usage')
      .select('created_at, input_tokens, output_tokens')
      .gte('created_at', thirtyDaysAgo);

    if (dErr) throw dErr;

    const dayMap = {};
    for (const r of dailyRows || []) {
      const day = r.created_at.slice(0, 10);
      if (!dayMap[day]) dayMap[day] = { date: day, input_tokens: 0, output_tokens: 0 };
      dayMap[day].input_tokens += r.input_tokens || 0;
      dayMap[day].output_tokens += r.output_tokens || 0;
    }
    const daily = Object.values(dayMap).sort((a, b) => a.date.localeCompare(b.date));

    res.json({
      thisMonth: { input_tokens: totalInput, output_tokens: totalOutput, cost_usd: costUsd },
      byUser,
      byOperation,
      daily,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

'use strict';
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const db = require('../lib/db');

// GET /api/admin/stats
router.get('/stats', auth, requireRole('admin'), async (req, res) => {
  try {
    const [countRows, activityRows] = await Promise.all([
      db.query('SELECT COUNT(*) AS count FROM pages'),
      db.query('SELECT user_email, created_at FROM activity_log ORDER BY created_at DESC LIMIT 100'),
    ]);

    const pageCount = parseInt(countRows[0]?.count ?? 0, 10);
    const recentActivity = activityRows.slice(0, 20);

    const tally = {};
    for (const row of activityRows) {
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
    const rows = await db.query(
      'SELECT user_id, email, role, assigned_at FROM user_roles ORDER BY assigned_at DESC'
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/admin/users/:userId/role
router.put('/users/:userId/role', auth, requireRole('admin'), async (req, res) => {
  const { userId } = req.params;
  const { role } = req.body;

  const validRoles = ['admin', 'contributor', 'viewer'];
  if (!validRoles.includes(role)) {
    return res.status(400).json({ error: `role must be one of: ${validRoles.join(', ')}` });
  }

  try {
    await db.query(
      `INSERT INTO user_roles (user_id, role, assigned_by, assigned_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE SET
         role = EXCLUDED.role,
         assigned_by = EXCLUDED.assigned_by,
         assigned_at = EXCLUDED.assigned_at`,
      [userId, role, req.user.id, new Date().toISOString()]
    );
    res.json({ role });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/usage
router.get('/usage', auth, requireRole('admin'), async (req, res) => {
  try {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const [monthRows, dailyRows] = await Promise.all([
      db.query('SELECT * FROM api_usage WHERE created_at >= $1', [startOfMonth]),
      db.query('SELECT created_at, input_tokens, output_tokens FROM api_usage WHERE created_at >= $1', [thirtyDaysAgo]),
    ]);

    const totalInput = monthRows.reduce((s, r) => s + (r.input_tokens || 0), 0);
    const totalOutput = monthRows.reduce((s, r) => s + (r.output_tokens || 0), 0);
    const costUsd = (totalInput / 1_000_000 * 3.00) + (totalOutput / 1_000_000 * 15.00);

    const userMap = {};
    for (const r of monthRows) {
      const key = r.user_email || r.user_id || 'unknown';
      if (!userMap[key]) userMap[key] = { user_email: key, input_tokens: 0, output_tokens: 0 };
      userMap[key].input_tokens += r.input_tokens || 0;
      userMap[key].output_tokens += r.output_tokens || 0;
    }
    const byUser = Object.values(userMap).map(u => ({
      ...u,
      cost_usd: (u.input_tokens / 1_000_000 * 3.00) + (u.output_tokens / 1_000_000 * 15.00),
    }));

    const opMap = {};
    for (const r of monthRows) {
      const key = r.operation || 'unknown';
      if (!opMap[key]) opMap[key] = { operation: key, input_tokens: 0, output_tokens: 0 };
      opMap[key].input_tokens += r.input_tokens || 0;
      opMap[key].output_tokens += r.output_tokens || 0;
    }
    const byOperation = Object.values(opMap);

    const dayMap = {};
    for (const r of dailyRows) {
      const day = r.created_at instanceof Date ? r.created_at.toISOString().slice(0, 10) : r.created_at.slice(0, 10);
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

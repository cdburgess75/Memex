'use strict';
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const db = require('../lib/db');
const settings = require('../lib/settings');
const compliance = require('../lib/compliance');
const documentAccess = require('../lib/documentAccess');
const seafile = require('../lib/seafileMigration');
const storage = require('../lib/storage');

// GET /api/admin/stats
router.get('/stats', auth, requireRole('admin'), async (req, res) => {
  try {
    const activityRows = await db.query('SELECT user_email, created_at FROM activity_log ORDER BY created_at DESC LIMIT 100');
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

    res.json({ recentActivity, topContributors });
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

// GET /api/admin/compliance — readiness profiles and update posture
router.get('/compliance', auth, requireRole('admin'), async (_req, res) => {
  try {
    const [frameworks, updates, summary] = await Promise.all([
      compliance.profileStatus(),
      compliance.updateStatus(),
      compliance.summary(),
    ]);
    res.json({
      disclaimer: 'Compliance profiles track readiness controls and evidence only. They do not certify Memex or the operating organization.',
      frameworks,
      updates,
      summary,
      probes: compliance.probeMeta(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/compliance/probe — run the runtime checks (HTTPS, npm audit, backup freshness)
router.post('/compliance/probe', auth, requireRole('admin'), async (_req, res) => {
  try {
    const probe = await compliance.runProbes();
    const [frameworks, summary] = await Promise.all([compliance.profileStatus(), compliance.summary()]);
    res.json({ ok: true, frameworks, summary, probes: { lastRun: probe.at, results: probe.results } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/admin/compliance/attest — record a manual control attestation (who/when/note)
router.put('/compliance/attest', auth, requireRole('admin'), async (req, res) => {
  try {
    const { control_id, met, note } = req.body || {};
    if (!control_id) return res.status(400).json({ error: 'control_id required' });
    await compliance.setAttestation(control_id, { met, note }, req.user);
    res.json({ ok: true, frameworks: await compliance.profileStatus(), summary: await compliance.summary() });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// PUT /api/admin/compliance — enable/disable readiness profiles
router.put('/compliance', auth, requireRole('admin'), async (req, res) => {
  try {
    const enabled = req.body?.enabled || {};
    const allowed = new Map(compliance.FRAMEWORKS.map(f => [f.id, f.setting]));
    for (const [id, value] of Object.entries(enabled)) {
      const settingKey = allowed.get(id);
      if (!settingKey) continue;
      await settings.set(settingKey, value ? 'true' : 'false', req.user.id);
    }
    await settings.refresh();
    res.json({ ok: true, frameworks: await compliance.profileStatus() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/backfill-owner-acl — one-time idempotent owner-grant backfill
router.post('/backfill-owner-acl', auth, requireRole('admin'), async (req, res) => {
  try {
    const granted = await documentAccess.backfillOwnerGrants();
    res.json({ ok: true, granted });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Build the WHERE clause + params for the activity feed from query filters.
// Shared by the JSON list and the CSV export so both honour the same filters.
function activityFilters(q) {
  const where = [];
  const params = [];
  const add = (clause, value) => { params.push(value); where.push(clause.replace('$?', '$' + params.length)); };
  const actor = String(q.actor || '').trim();
  if (actor) add('de.actor_email ILIKE $?', `%${actor}%`);
  const event = String(q.event || '').trim();
  if (event) add('de.event_type = $?', event);
  const name = String(q.q || '').trim();
  if (name) add('d.name ILIKE $?', `%${name}%`);
  const from = String(q.from || '').trim();
  if (from) add('de.created_at >= $?', from);
  const to = String(q.to || '').trim();
  if (to) add('de.created_at < ($?::date + INTERVAL \'1 day\')', to);
  return { clause: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
}

// GET /api/admin/activity — audit feed of document events (who did what to which
// file), filterable by actor, event type, document name, and date range.
router.get('/activity', auth, requireRole('admin'), async (req, res) => {
  try {
    const { clause, params } = activityFilters(req.query);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const rows = await db.query(
      `SELECT de.id, de.event_type, de.actor_email, de.detail, de.created_at,
              de.document_id, d.name AS document_name
         FROM document_events de
         LEFT JOIN documents d ON d.id = de.document_id
         ${clause}
         ORDER BY de.created_at DESC
         LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    const totalRow = await db.queryOne(
      `SELECT COUNT(*)::int AS n FROM document_events de LEFT JOIN documents d ON d.id = de.document_id ${clause}`,
      params
    );
    const types = await db.query('SELECT DISTINCT event_type FROM document_events ORDER BY event_type');
    res.json({
      events: rows,
      total: totalRow?.n || 0,
      limit,
      offset,
      eventTypes: types.map(t => t.event_type),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/activity.csv — same feed as a CSV download (no pagination).
router.get('/activity.csv', auth, requireRole('admin'), async (req, res) => {
  try {
    const { clause, params } = activityFilters(req.query);
    const rows = await db.query(
      `SELECT de.created_at, de.event_type, de.actor_email, d.name AS document_name, de.detail
         FROM document_events de
         LEFT JOIN documents d ON d.id = de.document_id
         ${clause}
         ORDER BY de.created_at DESC
         LIMIT 10000`,
      params
    );
    const { csvCell } = require('../lib/csv');
    const header = ['timestamp', 'event', 'actor', 'document', 'detail'];
    const lines = [header.join(',')];
    for (const r of rows) {
      lines.push([
        r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
        r.event_type, r.actor_email, r.document_name, r.detail,
      ].map(csvCell).join(','));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="memex-activity-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(lines.join('\n'));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- Seafile → Memex migration ----
// Names already in the target library (non-deleted), lowercased, so re-runs skip
// files already migrated rather than duplicating them.
async function targetExistingNames(libraryId) {
  const rows = await db.query('SELECT name FROM documents WHERE library_id = $1 AND deleted_at IS NULL', [libraryId]);
  return new Set(rows.map(r => String(r.name).toLowerCase()));
}

// POST /api/admin/migrate/seafile/test — verify credentials + repo access.
router.post('/migrate/seafile/test', auth, requireRole('admin'), async (req, res) => {
  try {
    const { url, username, password, repoId } = req.body || {};
    if (!url || !username || !password || !repoId) return res.status(400).json({ error: 'url, username, password and repoId are required' });
    res.json(await seafile.testConnection({ url, username, password, repoId }));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// POST /api/admin/migrate/seafile/start — kick off a background migration.
router.post('/migrate/seafile/start', auth, requireRole('admin'), async (req, res) => {
  try {
    if (seafile.isRunning()) return res.status(409).json({ error: 'A migration is already running' });
    const { url, username, password, repoId, targetLibraryId, destFolder } = req.body || {};
    if (!url || !username || !password || !repoId || !targetLibraryId) {
      return res.status(400).json({ error: 'url, username, password, repoId and targetLibraryId are required' });
    }
    const files = require('./files'); // required lazily to avoid load-order coupling
    const st = seafile.start(
      { url, username, password, repoId, targetLibraryId, destFolder, user: { id: req.user.id, email: req.user.email } },
      { storage, createDocumentRecord: files.createDocumentRecord, existingNames: targetExistingNames }
    );
    res.json(st);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// GET /api/admin/migrate/seafile/status — poll progress (credentials never returned).
router.get('/migrate/seafile/status', auth, requireRole('admin'), (_req, res) => {
  res.json(seafile.status());
});

// GET /api/admin/compliance/audit-verify — walk and verify the tamper-evident
// audit-log hash chain. Returns { ok, count, head } or the first break.
router.get('/compliance/audit-verify', auth, requireRole('admin'), async (_req, res) => {
  try {
    res.json(await require('../lib/auditLog').verify());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/compliance/evidence — aggregate evidence bundle (JSON).
router.get('/compliance/evidence', auth, requireRole('admin'), async (_req, res) => {
  try {
    res.json(await require('../lib/evidence').build());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/compliance/evidence.md — the same bundle as a Markdown download.
router.get('/compliance/evidence.md', auth, requireRole('admin'), async (_req, res) => {
  try {
    const evidence = require('../lib/evidence');
    const md = evidence.toMarkdown(await evidence.build());
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="memex-compliance-evidence-${new Date().toISOString().slice(0, 10)}.md"`);
    res.send(md);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/access-review — user/role/library-access/last-activity review.
router.get('/access-review', auth, requireRole('admin'), async (_req, res) => {
  try {
    res.json(await require('../lib/accessReview').build());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/access-review.csv — the same review as a CSV download.
router.get('/access-review.csv', auth, requireRole('admin'), async (_req, res) => {
  try {
    const review = require('../lib/accessReview');
    const csv = review.toCsv(await review.build());
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="memex-access-review-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
module.exports.activityFilters = activityFilters; // exported for unit tests

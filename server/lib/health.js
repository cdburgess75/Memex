'use strict';
// Health: what the server could not do for people, and what it is carrying, for Admin › Health
// and GET /api/admin/health (public API: /api/v1/admin/health). Built so a daily watch needs
// no shell on the box.
//
// Two halves. note() is the journal: every 5xx (lib/httpError.serverError, and the catch-all
// in index.js) and the refusals people hit (413, 415, 429) land in health_events, swept after
// 30 days. summary() reads the journal and the rest of the picture (what people did, failed
// sign-ins from Keycloak, disk, database, license) and gives a verdict in plain words:
// ok, attention or problem, with the reasons.
const fs = require('fs');
const path = require('path');

const KEEP_DAYS = 30;
const STARTED_AT = new Date();
let VERSION = 'dev';
try { VERSION = fs.readFileSync(path.join(__dirname, '..', '..', 'VERSION'), 'utf8').trim() || 'dev'; } catch { /* optional */ }

let _lastSweep = 0;
// Never throws and never waits on the request: a failing journal must not fail a request.
async function note({ kind, status, method, path: p, message, actorEmail } = {}) {
  try {
    const db = require('./db');
    await db.query(
      'INSERT INTO health_events (kind, status, method, path, message, actor_email) VALUES ($1, $2, $3, $4, $5, $6)',
      [kind === 'refusal' ? 'refusal' : 'error', Number.isFinite(Number(status)) ? Number(status) : null,
        String(method || '').slice(0, 10) || null, String(p || '').split('?')[0].slice(0, 300) || null,
        String(message || '').slice(0, 500) || null, actorEmail ? String(actorEmail).slice(0, 200) : null]
    );
    if (Date.now() - _lastSweep > 6 * 3600e3) {
      _lastSweep = Date.now();
      db.query(`DELETE FROM health_events WHERE at < now() - INTERVAL '${KEEP_DAYS} days'`).catch(() => {});
    }
  } catch { /* the journal is best effort */ }
}

const GiB = 2 ** 30;
function fmtBytes(n) {
  n = Number(n) || 0;
  if (n >= GiB) return `${(n / GiB).toFixed(n >= 10 * GiB ? 0 : 1)} GB`;
  if (n >= 2 ** 20) return `${Math.round(n / 2 ** 20)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

// The verdict. Each rule is one sentence an administrator can act on; the worst level wins.
function verdict({ errors = 0, refusals = 0, disk = null, signins = null, license = null } = {}) {
  const reasons = [];
  let level = 'ok';
  const raise = (to, why) => { reasons.push(why); if (to === 'problem') level = 'problem'; else if (level === 'ok') level = 'attention'; };
  if (errors >= 10) raise('problem', `${errors} requests could not be finished.`);
  else if (errors > 0) raise('attention', `${errors} request${errors === 1 ? '' : 's'} could not be finished.`);
  if (refusals >= 10) raise('attention', `${refusals} uploads or requests were refused: too big, a refused file type, or too many at once.`);
  if (disk && disk.total_bytes) {
    const share = disk.free_bytes / disk.total_bytes;
    if (share < 0.05 || disk.free_bytes < 2 * GiB) raise('problem', `Only ${fmtBytes(disk.free_bytes)} is free on the file store.`);
    else if (share < 0.15) raise('attention', `${fmtBytes(disk.free_bytes)} is free on the file store, ${Math.round(share * 100)}% of it.`);
  }
  if (signins && !signins.unavailable && signins.failed >= 20) {
    const w = signins.worst_address;
    raise('attention', `${signins.failed} failed sign-ins${w && w[1] >= 10 ? `, ${w[1]} of them from ${w[0]}` : ''}.`);
  }
  if (license) {
    if (license.read_only || license.state === 'lapsed' || license.state === 'readonly') raise('problem', 'The license has lapsed.');
    else if (license.state === 'expiring') raise('attention', 'The license is about to expire.');
    else if (license.state === 'unlicensed') raise('attention', 'No license is installed.');
  }
  return { status: level, reasons };
}

async function diskFree() {
  try {
    const storage = require('./storage');
    if (!(await storage.isLocalProvider())) return null;
    const base = await storage.localBase();
    const s = await fs.promises.statfs(base);
    return { path: base, free_bytes: Number(s.bavail) * Number(s.bsize), total_bytes: Number(s.blocks) * Number(s.bsize) };
  } catch { return null; }
}

let _eventsEnsured = false;
// Sign-ins and failed sign-ins, from Keycloak's own records (lib/keycloakAdmin). null when
// this server holds no Keycloak admin credentials; { unavailable } when Keycloak would not answer.
async function signIns(since) {
  if (!process.env.KEYCLOAK_ADMIN_PASSWORD) return null;
  try {
    const kcAdmin = require('./keycloakAdmin');
    if (!_eventsEnsured) { await kcAdmin.ensureLoginEvents(); _eventsEnsured = true; }
    const events = (await kcAdmin.loginEvents({ since })).filter(e => new Date(e.at) >= since);
    const failed = events.filter(e => e.type === 'LOGIN_ERROR');
    const byIp = new Map();
    for (const e of failed) byIp.set(e.ip || 'unknown', (byIp.get(e.ip || 'unknown') || 0) + 1);
    const worst = [...byIp.entries()].sort((a, b) => b[1] - a[1])[0] || null;
    return { signins: events.length - failed.length, failed: failed.length, worst_address: worst, recent_failed: failed.slice(0, 20) };
  } catch (e) { return { unavailable: e.message }; }
}

async function licenseState() {
  try {
    const st = await require('./license').status();
    return { state: st.state, read_only: !!st.readOnly, reason: st.stateReason || null };
  } catch { return null; }
}

async function summary({ days = 1 } = {}) {
  const db = require('./db');
  days = days === 7 ? 7 : 1;
  const sinceDate = new Date(Date.now() - days * 86400e3);
  const since = sinceDate.toISOString();
  const [errRow, refusalRows, recentErrors, recentRefusals, byType, activeRow, filesRow, peopleRow, dbRow] = await Promise.all([
    db.queryOne("SELECT count(*)::int AS n FROM health_events WHERE kind = 'error' AND at >= $1", [since]),
    db.query("SELECT status, count(*)::int AS n FROM health_events WHERE kind = 'refusal' AND at >= $1 GROUP BY status", [since]),
    db.query("SELECT at, status, method, path, message, actor_email FROM health_events WHERE kind = 'error' AND at >= $1 ORDER BY at DESC LIMIT 20", [since]),
    db.query("SELECT at, status, method, path, message, actor_email FROM health_events WHERE kind = 'refusal' AND at >= $1 ORDER BY at DESC LIMIT 20", [since]),
    db.query('SELECT event_type AS type, count(*)::int AS n FROM document_events WHERE created_at >= $1 GROUP BY event_type ORDER BY n DESC', [since]),
    db.queryOne('SELECT count(DISTINCT actor_email)::int AS n FROM document_events WHERE created_at >= $1 AND actor_email IS NOT NULL', [since]),
    db.queryOne('SELECT count(*)::int AS n, COALESCE(SUM(size), 0)::bigint AS bytes FROM documents WHERE deleted_at IS NULL', []),
    db.queryOne('SELECT count(*)::int AS n, count(*) FILTER (WHERE disabled_at IS NULL)::int AS active FROM user_roles', []),
    db.queryOne('SELECT pg_database_size(current_database())::bigint AS bytes', []),
  ]);
  const [disk, signins, license] = await Promise.all([diskFree(), signIns(sinceDate), licenseState()]);
  const byStatus = {};
  let refusals = 0;
  for (const r of refusalRows || []) { byStatus[r.status] = r.n; refusals += r.n; }
  const errors = errRow?.n || 0;
  const actions = (byType || []).reduce((a, r) => a + r.n, 0);
  const { status, reasons } = verdict({ errors, refusals, disk, signins, license });
  return {
    status, reasons, checked_at: new Date().toISOString(), period_days: days,
    version: VERSION, started_at: STARTED_AT.toISOString(), uptime_seconds: Math.round(process.uptime()),
    errors: { count: errors, recent: recentErrors || [] },
    refusals: { count: refusals, by_status: byStatus, recent: recentRefusals || [] },
    signins,
    activity: { actions, by_type: byType || [], active_people: activeRow?.n || 0 },
    stored: { files: filesRow?.n || 0, bytes: Number(filesRow?.bytes || 0), people: peopleRow?.n || 0, people_active: peopleRow?.active || 0, database_bytes: Number(dbRow?.bytes || 0) },
    disk, license,
  };
}

module.exports = { note, summary, verdict, fmtBytes, KEEP_DAYS };

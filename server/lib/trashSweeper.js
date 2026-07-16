'use strict';
// Periodic hard-delete of trashed documents past the retention window.
//
// DELETE /api/files/:id is a soft delete (sets deleted_at); the app advertises a
// retention window ("recoverable until purge") and reports it in compliance output,
// but nothing enforced it — trashed rows and their blobs accumulated forever. This
// sweeper hard-deletes documents whose deleted_at is older than trash_retention_days,
// removing the main blob AND every version blob (a plain row delete CASCADEs the
// version rows but would orphan their objects on disk), and appends a tamper-evident
// audit event so the automated deletion is recorded.
const db = require('./db');
const storage = require('./storage');
const settings = require('./settings');
const auditLog = require('./auditLog');

const num = (v, d) => (Number(v) > 0 ? Number(v) : d);
const INTERVAL_HOURS = num(process.env.TRASH_SWEEP_INTERVAL_HOURS, 12);
const BATCH = num(process.env.TRASH_SWEEP_BATCH, 200);

let _timer = null;
let _running = false;

// 0 disables enforcement (keep trash forever). Default 30 days.
async function retentionDays() {
  const d = parseInt((await settings.getOrEnv('trash_retention_days')) || '30', 10);
  return Number.isFinite(d) && d >= 0 ? d : 30;
}

async function sweepOnce({ days } = {}) {
  const retention = days != null ? days : await retentionDays();
  const result = { documentsPurged: 0, blobsDeleted: 0 };
  if (!retention) return result; // retention disabled

  let docs = [];
  try {
    docs = await db.query(
      `SELECT id, name, storage_path FROM documents
       WHERE deleted_at IS NOT NULL AND deleted_at < NOW() - make_interval(days => $1::int)
       ORDER BY deleted_at ASC LIMIT $2`,
      [retention, BATCH]
    );
  } catch { docs = []; }

  for (const d of docs) {
    // Version blobs first (their rows go via CASCADE when the document is deleted).
    let versions = [];
    try { versions = await db.query('SELECT storage_path FROM document_versions WHERE document_id = $1', [d.id]); }
    catch { versions = []; }
    for (const v of versions) {
      if (v.storage_path) { await storage.del(v.storage_path).catch(() => {}); result.blobsDeleted += 1; }
    }
    if (d.storage_path) { await storage.del(d.storage_path).catch(() => {}); result.blobsDeleted += 1; }

    try {
      await db.query('DELETE FROM documents WHERE id = $1', [d.id]);
      result.documentsPurged += 1;
      await auditLog.append({
        documentId: d.id,
        eventType: 'purged',
        actorId: null,
        actorEmail: 'system@retention',
        detail: `auto-purged after ${retention}d retention · ${d.name || ''}`.trim(),
      }).catch(() => {});
    } catch { /* keep going with the rest of the batch */ }
  }

  return result;
}

async function runGuarded() {
  if (_running) return;
  _running = true;
  try {
    const r = await sweepOnce();
    if (r.documentsPurged) {
      console.log(`[trash-sweeper] purged ${r.documentsPurged} expired document(s), deleted ${r.blobsDeleted} blob(s)`);
    }
  } catch (e) {
    console.error('[trash-sweeper] sweep failed:', e.message);
  } finally {
    _running = false;
  }
}

function start() {
  if (_timer) return _timer;
  const first = setTimeout(runGuarded, 90 * 1000); // first pass ~90s after boot
  first.unref?.();
  _timer = setInterval(runGuarded, INTERVAL_HOURS * 3600 * 1000);
  _timer.unref?.();
  return _timer;
}

function stop() { if (_timer) { clearInterval(_timer); _timer = null; } }

module.exports = { start, stop, sweepOnce, INTERVAL_HOURS };

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
    /* The row goes FIRST, and only while it is still expired.
     *
     * Deleting the blobs first was a way to destroy a file somebody had just restored:
     * between reading the batch and deleting the row, a restore sets deleted_at to NULL
     * -- and an unconditional DELETE then removed a live document whose objects were
     * already gone. The condition is repeated inside the delete, so a restore that
     * landed in the meantime simply leaves nothing to purge.
     *
     * No lock is taken. Nothing else deletes these rows, and a restore either lands
     * before the DELETE (which then matches nothing) or after it (and finds the row
     * gone, which every restore path already treats as "not in the trash").
     */
    let objects = null;
    try {
      objects = await db.withTransaction(async (client) => {
        // Version objects are read BEFORE the delete: their rows CASCADE away with the
        // document, and afterwards nothing is left to say which objects to remove.
        const { rows: versions } = await client.query('SELECT storage_path FROM document_versions WHERE document_id = $1', [d.id]);
        const { rows: gone } = await client.query(
          `DELETE FROM documents
            WHERE id = $1 AND deleted_at IS NOT NULL AND deleted_at < NOW() - make_interval(days => $2::int)
            RETURNING storage_path`,
          [d.id, retention]
        );
        if (!gone.length) return null;   // restored, or already purged, meanwhile
        return [...versions.map(v => v.storage_path), gone[0].storage_path].filter(Boolean);
      });
    } catch { objects = null; /* keep going with the rest of the batch */ }
    if (!objects) continue;

    // Only now, with the row committed away, are the objects removed. A crash here
    // leaves objects nobody points at -- countable and cleanable -- rather than rows
    // pointing at objects that are already gone.
    for (const objectPath of objects) { await storage.del(objectPath).catch(() => {}); result.blobsDeleted += 1; }
    result.documentsPurged += 1;
    await auditLog.append({
      documentId: d.id,
      eventType: 'purged',
      actorId: null,
      actorEmail: 'system@retention',
      detail: `auto-purged after ${retention}d retention · ${d.name || ''}`.trim(),
    }).catch(() => {});
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

'use strict';
// Periodic cleanup for resumable upload sessions.
//
// A resumable upload stages each chunk as a .part file under
// <localBase>/.uploads/<sessionId>/. Completed and canceled sessions delete their
// chunk dir inline, but a session the client simply ABANDONS (closes the tab mid
// upload) stays 'active' and its staged chunks would sit on disk forever. On a host
// that takes large uploads this is a slow disk leak.
//
// This sweeper: (1) cancels 'active' sessions with no chunk written for STALE_HOURS
// and removes their staged chunks, (2) removes orphaned chunk dirs that have no
// matching active session (belt-and-suspenders for a failed inline cleanup), and
// (3) purges old terminal session rows so the table stays bounded.
const path = require('path');
const fs = require('fs').promises;
const db = require('./db');
const storage = require('./storage');

const num = (v, d) => (Number(v) > 0 ? Number(v) : d);
const STALE_HOURS = num(process.env.UPLOAD_SWEEP_STALE_HOURS, 24);
const INTERVAL_HOURS = num(process.env.UPLOAD_SWEEP_INTERVAL_HOURS, 6);
const TERMINAL_RETENTION_DAYS = num(process.env.UPLOAD_SWEEP_RETENTION_DAYS, 30);

let _timer = null;
let _running = false;

// Null when storage isn't local (resumable uploads require local storage, so there
// are no chunk dirs to sweep — only the DB rows, which we still tidy).
async function chunkRoot() {
  try { return (await storage.isLocalProvider()) ? path.join(await storage.localBase(), '.uploads') : null; }
  catch { return null; }
}

async function removeDir(root, name) {
  await fs.rm(path.join(root, name), { recursive: true, force: true }).catch(() => {});
}

async function sweepOnce({ staleHours = STALE_HOURS, retentionDays = TERMINAL_RETENTION_DAYS } = {}) {
  const result = { canceledStale: 0, orphanDirsRemoved: 0, terminalRowsPurged: 0 };
  const root = await chunkRoot();

  // 1) Cancel active sessions idle for staleHours; remove their staged chunks.
  let stale = [];
  try {
    stale = await db.query(
      "SELECT id FROM upload_sessions WHERE status = 'active' AND updated_at < NOW() - make_interval(hours => $1::int)",
      [staleHours]
    );
  } catch { stale = []; }
  for (const s of stale) {
    if (root) await removeDir(root, String(s.id));
    try {
      await db.query("UPDATE upload_sessions SET status = 'canceled', updated_at = NOW() WHERE id = $1 AND status = 'active'", [s.id]);
      result.canceledStale += 1;
    } catch { /* keep going */ }
  }

  // 2) Remove orphaned chunk dirs (no matching active session), guarded by mtime so
  //    a just-created dir whose session row we haven't observed isn't yanked.
  if (root) {
    let entries = [];
    try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { entries = []; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      let active = null;
      try { active = await db.queryOne("SELECT 1 FROM upload_sessions WHERE id = $1 AND status = 'active'", [e.name]); }
      catch { active = { keep: true }; } // on DB error, err on the side of keeping it
      if (active) continue;
      let old = false;
      try { const st = await fs.stat(path.join(root, e.name)); old = (Date.now() - st.mtimeMs) > staleHours * 3600 * 1000; } catch { old = false; }
      if (old) { await removeDir(root, e.name); result.orphanDirsRemoved += 1; }
    }
  }

  // 3) Purge old terminal rows so the table stays bounded.
  try {
    const purged = await db.query(
      "DELETE FROM upload_sessions WHERE status IN ('complete','canceled') AND updated_at < NOW() - make_interval(days => $1::int) RETURNING id",
      [retentionDays]
    );
    result.terminalRowsPurged = purged.length;
  } catch { /* ignore */ }

  return result;
}

async function runGuarded() {
  if (_running) return;
  _running = true;
  try {
    const r = await sweepOnce();
    if (r.canceledStale || r.orphanDirsRemoved || r.terminalRowsPurged) {
      console.log(`[upload-sweeper] canceled ${r.canceledStale} stale session(s), removed ${r.orphanDirsRemoved} orphan dir(s), purged ${r.terminalRowsPurged} old row(s)`);
    }
  } catch (e) {
    console.error('[upload-sweeper] sweep failed:', e.message);
  } finally {
    _running = false;
  }
}

function start() {
  if (_timer) return _timer;
  const first = setTimeout(runGuarded, 60 * 1000); // first pass a minute after boot
  first.unref?.();
  _timer = setInterval(runGuarded, INTERVAL_HOURS * 3600 * 1000);
  _timer.unref?.();
  return _timer;
}

function stop() { if (_timer) { clearInterval(_timer); _timer = null; } }

module.exports = { start, stop, sweepOnce, STALE_HOURS, INTERVAL_HOURS };

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
// matching active session (belt-and-suspenders for a failed inline cleanup),
// (3) purges old terminal session rows so the table stays bounded, and (4) removes
// orphaned `<final>.<16 hex>.upload` temp files that storage.localUploadStream writes
// beside the final file. Its catch block unlinks them on a normal failure, but a hard
// stop mid-upload (SIGKILL, OOM, reboot) leaves one behind as big as the upload. With
// encryption on, releases before segmented encryption also wrote a second temp,
// `<final>.<16 hex>.upload.ciphertext`, the whole ciphertext before its header went on:
// a hard stop then leaves that one too, just as big, so it is swept the same way.
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

const TEMP_RE = /\.[0-9a-f]{16}\.upload(\.ciphertext)?$/;

// Null when storage isn't local (resumable uploads require local storage, so there
// are no chunk dirs or temp files to sweep — only the DB rows, which we still tidy).
async function localRoot() {
  try { return (await storage.isLocalProvider()) ? await storage.localBase() : null; }
  catch { return null; }
}

async function removeDir(root, name) {
  await fs.rm(path.join(root, name), { recursive: true, force: true }).catch(() => {});
}

// A matching temp file is removed only once its mtime is stale (an upload in progress
// keeps writing, so keeps it fresh) and no document or version row points at it: the
// stored name ends in the user's file name, so a real file can match the pattern too.
async function removeIfOrphanTemp(base, full, staleMs) {
  try {
    const st = await fs.lstat(full);
    if (!st.isFile() || (Date.now() - st.mtimeMs) <= staleMs) return false;
    const owned = await db.queryOne(
      'SELECT 1 FROM documents WHERE storage_path = $1 UNION ALL SELECT 1 FROM document_versions WHERE storage_path = $1 LIMIT 1',
      [path.relative(base, full)]
    );
    if (owned) return false;
    await fs.unlink(full);
    return true;
  } catch { return false; } // on fs or DB error, keep it
}

// Depth-first walk of the document tree. opendir streams entries, so memory is one open
// dir per level rather than whole listings; a Dirent for a symlink is neither a file nor
// a dir, so links aren't followed. Unreadable dirs are skipped; nothing throws.
async function sweepTempFiles(dir, skip, base, staleMs, result) {
  let handle;
  try { handle = await fs.opendir(dir); } catch { return; }
  try {
    for await (const e of handle) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (full !== skip) await sweepTempFiles(full, skip, base, staleMs, result);
      } else if (e.isFile() && TEMP_RE.test(e.name)) {
        if (await removeIfOrphanTemp(base, full, staleMs)) result.tempFilesRemoved += 1;
      }
    }
  } catch { /* read failed mid-dir: skip the rest of it */ }
}

async function sweepOnce({ staleHours = STALE_HOURS, retentionDays = TERMINAL_RETENTION_DAYS } = {}) {
  const result = { canceledStale: 0, orphanDirsRemoved: 0, terminalRowsPurged: 0, tempFilesRemoved: 0 };
  const base = await localRoot();
  const root = base ? path.join(base, '.uploads') : null;

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

  // 4) Remove orphaned upload temp files from the document tree (the staging dir is
  //    step 2's job).
  if (base) await sweepTempFiles(base, root, base, staleHours * 3600 * 1000, result);

  return result;
}

async function runGuarded() {
  if (_running) return;
  _running = true;
  try {
    const r = await sweepOnce();
    if (r.canceledStale || r.orphanDirsRemoved || r.terminalRowsPurged || r.tempFilesRemoved) {
      console.log(`[upload-sweeper] canceled ${r.canceledStale} stale session(s), removed ${r.orphanDirsRemoved} orphan dir(s), purged ${r.terminalRowsPurged} old row(s), removed ${r.tempFilesRemoved} orphan temp file(s)`);
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

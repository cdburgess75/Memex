'use strict';
// In-app backup engine + scheduler. Produces a single archive (Postgres dump via
// pg_dump + a tar of the documents dir + a manifest), writes it to a local staging
// dir, ships it to every enabled destination, and prunes to the retention count.
const { execFile } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const settings = require('./settings');
const dests = require('./backupDestinations');

const STAGING = process.env.BACKUP_STAGING_DIR || '/data/backups';

let _running = false;
let _timer = null;

function execFileP(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: opts.timeout || 120000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message || 'command failed').slice(0, 500)));
      else resolve(stdout);
    });
  });
}

function bool(v) { return ['1', 'true', 'yes', 'on'].includes(String(v || '').toLowerCase()); }
function parseDestinations(raw) {
  if (!raw) return [];
  try { const p = JSON.parse(raw); return Array.isArray(p) ? p : []; } catch { return []; }
}

async function getConfig() {
  return {
    enabled: bool(await settings.getOrEnv('backup_enabled')),
    intervalHours: Math.max(1, Number(await settings.getOrEnv('backup_interval_hours')) || 24),
    retention: Math.max(1, Number(await settings.getOrEnv('backup_retention')) || 7),
    destinations: parseDestinations(await settings.getOrEnv('backup_destinations')),
  };
}

async function listStaging() {
  try {
    const names = (await fsp.readdir(STAGING)).filter(n => dests.ARCHIVE_RE.test(n));
    const out = [];
    for (const n of names) {
      const st = await fsp.stat(path.join(STAGING, n)).catch(() => null);
      if (st) out.push({ name: n, size: st.size, ts: st.mtimeMs });
    }
    return out.sort((a, b) => b.ts - a.ts);
  } catch { return []; }
}

async function status() {
  const cfg = await getConfig();
  const lastRunRaw = await settings.get('backup_last_run');
  const lastStatusRaw = await settings.get('backup_last_status');
  const lastRun = lastRunRaw ? Number(lastRunRaw) : null;
  let lastStatus = null;
  try { lastStatus = lastStatusRaw ? JSON.parse(lastStatusRaw) : null; } catch { /* ignore */ }
  const nextRun = cfg.enabled ? (lastRun ? lastRun + cfg.intervalHours * 3600000 : Date.now()) : null;
  return { running: _running, enabled: cfg.enabled, lastRun, lastStatus, nextRun, artifacts: await listStaging() };
}

// ---- archive creation ----
async function createArchive() {
  await fsp.mkdir(STAGING, { recursive: true });
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z'); // 20260618T031500Z
  const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'memex-bk-'));
  try {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) throw new Error('DATABASE_URL is not set');
    await execFileP('pg_dump', ['-Fc', '-d', dbUrl, '-f', path.join(work, 'postgres-memex.dump')], { timeout: 180000 });

    const docsDir = (await settings.getOrEnv('storage_local_path')) || '/data/documents';
    let docsNote = 'not backed up (non-local storage or directory missing)';
    if (fs.existsSync(docsDir)) {
      await execFileP('tar', ['-czf', path.join(work, 'documents.tar.gz'), '-C', docsDir, '.'], { timeout: 180000 });
      docsNote = 'documents.tar.gz';
    }

    await fsp.writeFile(path.join(work, 'manifest.txt'),
      [`created_at=${new Date().toISOString()}`, 'database_dump=postgres-memex.dump', `documents=${docsNote}`, 'source=memex in-app backup'].join('\n') + '\n');

    const name = `memex-backup-${ts}.tar.gz`;
    const archivePath = path.join(STAGING, name);
    await execFileP('tar', ['-czf', archivePath, '-C', work, '.'], { timeout: 180000 });
    const buf = await fsp.readFile(archivePath);
    return { path: archivePath, name, size: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
  } finally {
    await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

// ---- run ----
async function runBackup({ manual = false } = {}) {
  if (_running) throw new Error('A backup is already running');
  _running = true;
  const started = Date.now();
  const result = { startedAt: new Date(started).toISOString(), manual, destinations: [] };
  try {
    const cfg = await getConfig();
    const archive = await createArchive();
    Object.assign(result, { name: archive.name, size: archive.size, sha256: archive.sha256 });

    for (const d of cfg.destinations) {
      if (d.enabled === false) continue;
      const r = { type: d.type, label: d.label || d.type };
      try {
        const meta = { size: archive.size, sha256: archive.sha256, downloadUrl: await signedDownloadUrl(archive.name) };
        await dests.adapter(d.type).put(d, archive.path, archive.name, meta);
        r.ok = true;
      } catch (e) { r.ok = false; r.error = e.message; }
      result.destinations.push(r);
    }

    await pruneStaging(cfg.retention);
    for (const d of cfg.destinations) {
      if (d.enabled === false) continue;
      try { await pruneDestination(d, cfg.retention); } catch { /* best-effort */ }
    }

    result.ok = result.destinations.every(x => x.ok !== false);
    result.finishedAt = new Date().toISOString();
    return result;
  } catch (e) {
    result.ok = false;
    result.error = e.message;
    result.finishedAt = new Date().toISOString();
    throw e;
  } finally {
    _running = false;
    await settings.set('backup_last_run', String(started)).catch(() => {});
    await settings.set('backup_last_status', JSON.stringify(result)).catch(() => {});
  }
}

async function pruneStaging(keepN) {
  const arts = await listStaging();
  for (const a of arts.slice(keepN)) await fsp.unlink(path.join(STAGING, a.name)).catch(() => {});
}
async function pruneDestination(d, keepN) {
  const a = dests.adapter(d.type);
  const items = (await a.list(d)).sort((x, y) => y.ts - x.ts);
  for (const it of items.slice(keepN)) await a.remove(d, it.name).catch(() => {});
}

// ---- signed download (for the webhook "pull" destination) ----
async function downloadSecret() {
  let s = await settings.getOrEnv('backup_download_secret');
  if (!s) { s = crypto.randomBytes(32).toString('hex'); await settings.set('backup_download_secret', s); }
  return s;
}
function sign(name, exp, secret) {
  return crypto.createHmac('sha256', secret).update(`${name}.${exp}`).digest('hex');
}
async function signToken(name, ttlMs = 7 * 24 * 3600 * 1000) {
  const exp = Date.now() + ttlMs;
  return `${exp}.${sign(name, exp, await downloadSecret())}`;
}
async function verifyToken(name, token) {
  if (!token || !/^\d+\.[a-f0-9]{64}$/.test(token)) return false;
  const [expStr, sig] = token.split('.');
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || Date.now() > exp) return false;
  const expected = sign(name, exp, await downloadSecret());
  try { return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex')); } catch { return false; }
}
async function signedDownloadUrl(name) {
  const base = String((await settings.getOrEnv('app_url')) || '').replace(/\/+$/, '');
  const p = `/api/backup/download/${encodeURIComponent(name)}?token=${await signToken(name)}`;
  return base ? base + p : p;
}
// Resolve a staging artifact path, guarding against traversal.
function stagingPath(name) {
  if (typeof name !== 'string' || !dests.ARCHIVE_RE.test(name)) return null;
  return path.join(STAGING, path.basename(name));
}

// ---- scheduler ----
async function reschedule() {
  if (_timer) { clearTimeout(_timer); _timer = null; }
  const st = await status();
  if (!st.enabled) return;
  let delay = st.nextRun ? st.nextRun - Date.now() : 0;
  if (delay < 0) delay = 60000;            // overdue → run shortly after boot
  delay = Math.min(delay, 2_000_000_000);  // setTimeout 32-bit safety
  _timer = setTimeout(async () => {
    try { await runBackup({ manual: false }); } catch (e) { console.error('[backup] scheduled run failed:', e.message); }
    reschedule();
  }, delay);
  _timer.unref?.();
}

module.exports = { getConfig, status, runBackup, reschedule, verifyToken, signToken, signedDownloadUrl, stagingPath, STAGING };

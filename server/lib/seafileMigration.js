'use strict';
// One-way migration: copy a Seafile library into a Memex library, preserving the
// folder tree. Files are ingested through the normal Memex path (storage.upload +
// createDocumentRecord) so encryption, text extraction, ACLs, and activity
// logging all behave exactly like a regular upload.
//
// Runs as a single background job (one at a time). Progress is held in memory and
// polled by the admin UI. Seafile credentials are used only for the job and are
// never persisted or logged.

// ---- Seafile REST client (api2) ----
function apiBase(url) {
  return String(url || '').replace(/\/+$/, '') + '/api2';
}

async function authToken(url, username, password) {
  const r = await fetch(`${apiBase(url)}/auth-token/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.token) throw new Error(`Seafile auth failed (${r.status})`);
  return data.token;
}

function authHeaders(token) {
  return { Authorization: `Token ${token}`, Accept: 'application/json' };
}

// List one directory. Returns [{ type:'file'|'dir', name, size, ... }].
async function listDir(url, token, repoId, dirPath) {
  const p = encodeURIComponent(dirPath || '/');
  const r = await fetch(`${apiBase(url)}/repos/${repoId}/dir/?p=${p}`, {
    headers: authHeaders(token),
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`Seafile list "${dirPath}" failed (${r.status})`);
  const data = await r.json().catch(() => []);
  return Array.isArray(data) ? data : [];
}

// Walk the whole tree under startPath, returning file entries with full paths.
async function walk(url, token, repoId, startPath = '/', out = []) {
  const entries = await listDir(url, token, repoId, startPath);
  for (const e of entries) {
    const full = startPath === '/' ? `/${e.name}` : `${startPath}/${e.name}`;
    if (e.type === 'dir') await walk(url, token, repoId, full, out);
    else if (e.type === 'file') out.push({ path: full, name: e.name, size: Number(e.size) || 0 });
  }
  return out;
}

// Resolve a file's temporary download URL, then fetch its bytes.
async function downloadFile(url, token, repoId, filePath) {
  const p = encodeURIComponent(filePath);
  const linkRes = await fetch(`${apiBase(url)}/repos/${repoId}/file/?p=${p}&reuse=1`, {
    headers: authHeaders(token),
    signal: AbortSignal.timeout(20000),
  });
  if (!linkRes.ok) throw new Error(`Seafile download link failed (${linkRes.status})`);
  // The endpoint returns the download URL as a JSON-quoted string.
  const dlUrl = JSON.parse(await linkRes.text());
  const fileRes = await fetch(dlUrl, { signal: AbortSignal.timeout(120000) });
  if (!fileRes.ok) throw new Error(`Seafile file fetch failed (${fileRes.status})`);
  return Buffer.from(await fileRes.arrayBuffer());
}

async function repoName(url, token, repoId) {
  try {
    const r = await fetch(`${apiBase(url)}/repos/${repoId}/`, { headers: authHeaders(token), signal: AbortSignal.timeout(15000) });
    if (!r.ok) return null;
    return (await r.json())?.name || null;
  } catch { return null; }
}

// Verify credentials + repo access without moving anything.
async function testConnection({ url, username, password, repoId }) {
  const token = await authToken(url, username, password);
  const name = await repoName(url, token, repoId);
  const top = await listDir(url, token, repoId, '/');
  return { ok: true, repoName: name, topLevelEntries: top.length };
}

// ---- Migration job (one at a time) ----
let job = { status: 'idle' }; // idle | running | done | error

function status() {
  // Never leak credentials in the polled status.
  const { creds, ...safe } = job;
  return safe;
}

function isRunning() { return job.status === 'running'; }

// Start a background migration. deps = { storage, createDocumentRecord, existingNames }
// existingNames(libraryId) -> Set of lowercased names already in the target lib
// (for idempotent re-runs).
function start({ url, username, password, repoId, targetLibraryId, destFolder, user }, deps) {
  if (isRunning()) throw new Error('A migration is already running');
  job = {
    status: 'running', total: 0, done: 0, skipped: 0, failed: 0,
    current: '', errors: [], startedAt: Date.now(), finishedAt: null,
    repoId, targetLibraryId,
  };
  // Fire-and-forget; the caller returns immediately and the UI polls status().
  run({ url, username, password, repoId, targetLibraryId, destFolder, user }, deps)
    .then(() => { job.status = 'done'; job.finishedAt = Date.now(); job.current = ''; })
    .catch((e) => { job.status = 'error'; job.finishedAt = Date.now(); job.error = e.message; });
  return status();
}

const path = require('path');
function cleanSeg(s) { return String(s || '').split('/').map(x => x.trim()).filter(x => x && x !== '.' && x !== '..').join('/'); }

async function run({ url, username, password, repoId, targetLibraryId, destFolder, user }, deps) {
  const token = await authToken(url, username, password);
  const files = await walk(url, token, repoId, '/');
  job.total = files.length;
  const existing = deps.existingNames ? await deps.existingNames(targetLibraryId) : new Set();
  const prefix = cleanSeg(destFolder);

  for (const f of files) {
    job.current = f.path;
    // Preserve the tree: strip the leading slash; optionally nest under destFolder.
    const rel = cleanSeg(f.path);
    const displayName = prefix ? `${prefix}/${rel}` : rel;
    if (existing.has(displayName.toLowerCase())) { job.skipped++; continue; }
    try {
      const buffer = await downloadFile(url, token, repoId, f.path);
      const mimetype = mimeFor(f.name);
      const sanitized = path.basename(f.name).replace(/[^a-zA-Z0-9._-]/g, '_');
      const storagePath = `documents/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${sanitized}`;
      await deps.storage.upload(storagePath, buffer, mimetype);
      await deps.createDocumentRecord({
        displayName, storagePath, mimetype, storedSize: buffer.length, user,
        sourceDetail: 'migrated from Seafile', libraryId: targetLibraryId,
      });
      existing.add(displayName.toLowerCase());
      job.done++;
    } catch (e) {
      job.failed++;
      if (job.errors.length < 50) job.errors.push({ path: f.path, error: e.message });
    }
  }
}

function mimeFor(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  const map = {
    pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', md: 'text/markdown',
    doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    zip: 'application/zip', json: 'application/json',
  };
  return map[ext] || 'application/octet-stream';
}

module.exports = { testConnection, start, status, isRunning, authToken, listDir, walk, downloadFile, apiBase, mimeFor, _reset: () => { job = { status: 'idle' }; } };

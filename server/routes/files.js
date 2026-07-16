'use strict';
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const multer = require('multer');
const Anthropic = require('@anthropic-ai/sdk');
const { generateToken } = require('../lib/wopiTokens');
const storage = require('../lib/storage');
const encryption = require('../lib/encryption');
const db = require('../lib/db');
const settings = require('../lib/settings');
const documentAccess = require('../lib/documentAccess');
const libraries = require('../lib/libraries');
const profiles = require('../lib/profiles');
const notifications = require('../lib/notifications');
const emailEvents = require('../lib/emailEvents');
const auditLog = require('../lib/auditLog');
const { extractText } = require('../lib/textExtraction');
const blankDocs = require('../lib/blankDocs');
const mp4Faststart = require('../lib/mp4Faststart');
const { zipStream } = require('../lib/zip');
const fsSync = require('fs');
const fs = fsSync.promises;
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');

const DOCUMENT_COLUMNS = `
  id, name, size, mime_type, storage_path, google_drive_id, uploaded_by,
  uploaded_by_email, created_at, deleted_at, deleted_by, deleted_by_email,
  restored_at, restored_by, restored_by_email
`;

// Uploads accept any file type. Downloads are always served as attachments
// (Content-Disposition: attachment), so arbitrary content can't execute in our
// origin. Add extensions here to block specific types if a deployment needs to.
// Text extraction (for AI indexing) runs best-effort on known formats and is a
// no-op for others — binary/unknown types are simply stored without indexing.
const BLOCKED_FILE_EXTS = [];
const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024;
const MAX_CHUNK_SIZE = 64 * 1024 * 1024;
let uploadSessionsEnsured = false;
let shareLinksEnsured = false;
let folderShareLinksEnsured = false;

function cleanDisplayName(name) {
  return String(name || '')
    .split(/[\\/]+/)
    .map(part => part.trim().replace(/[^a-zA-Z0-9._ -]/g, '_').replace(/^\.+$/, '_'))
    .filter(Boolean)
    .join('/');
}

function fileExt(name) {
  const ext = require('path').extname(String(name || '')).toLowerCase();
  return ext;
}

function isAllowedFile(name) {
  return !BLOCKED_FILE_EXTS.includes(fileExt(name));
}

function fileSizeLabelForEvent(size) {
  const n = Number(size || 0);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) { value /= 1024; idx += 1; }
  return `${value >= 10 || idx === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[idx]}`;
}

async function maxUploadMb() {
  const mb = parseInt(await settings.getOrEnv('max_upload_mb') || '8192', 10);
  return Number.isFinite(mb) && mb > 0 ? mb : 8192;
}
async function maxUploadFiles() {
  const n = parseInt(await settings.getOrEnv('max_upload_files') || '4096', 10);
  return Number.isFinite(n) && n > 0 ? n : 4096;
}
// The buffered (multer memoryStorage) path holds the whole file in RAM, so it must
// NOT honor the full max_upload_mb (which can be many GB). Large files go through the
// streaming/chunked paths; the buffered path (legacy /upload + the public upload-link)
// is capped to a memory-safe size regardless of max_upload_mb.
const MULTER_MEMORY_MB = 256;
// Text extraction downloads the whole file into memory, so its size gate is capped
// independently of max_upload_mb — a multi-GB file must never be buffered to index it.
const TEXT_EXTRACTION_MAX_BYTES = 25 * 1024 * 1024;

let _uploadMb = 0;
let _uploadMw = null;
async function getUpload() {
  const mb = Math.min(await maxUploadMb(), MULTER_MEMORY_MB);
  if (mb !== _uploadMb || !_uploadMw) {
    _uploadMb = mb;
    _uploadMw = multer({
      storage: multer.memoryStorage(),
      limits: { fileSize: mb * 1024 * 1024 },
      fileFilter(_req, file, cb) {
        cb(null, isAllowedFile(file.originalname));
      }
    }).single('file');
  }
  return _uploadMw;
}

async function anthropic() {
  return new Anthropic({ apiKey: await settings.getOrEnv('anthropic_api_key') });
}

async function MODEL() {
  return (await settings.getOrEnv('anthropic_model')) || 'claude-sonnet-4-6';
}

async function logEvent(event, userId, userEmail) {
  await db.query(
    'INSERT INTO activity_log (event, user_id, user_email) VALUES ($1, $2, $3)',
    [event, userId, userEmail]
  );
}

async function logDocumentEvent(documentId, eventType, userId, userEmail, detail = null) {
  // Appended to the tamper-evident hash chain (see lib/auditLog).
  await auditLog.append({ documentId, eventType, actorId: userId, actorEmail: userEmail, detail });
}

function requestAuditDetail(req) {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const userAgent = String(req.get('user-agent') || 'unknown').replace(/\s+/g, ' ').slice(0, 160);
  return `ip ${ip} · user-agent ${userAgent}`;
}

async function trashRetentionDays() {
  const days = parseInt(await settings.getOrEnv('trash_retention_days') || '30', 10);
  return Number.isFinite(days) && days > 0 ? days : 30;
}

async function saveDocumentVersion(doc, user, source = 'replace') {
  const path = require('path');
  const safeName = path.basename(doc.name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
  const versionNumber = await db.queryOne(
    'SELECT COALESCE(MAX(version_number), 0) + 1 AS next FROM document_versions WHERE document_id = $1',
    [doc.id]
  );
  const next = Number(versionNumber?.next || 1);
  const versionPath = `versions/${doc.id}/${String(next).padStart(4, '0')}-${Date.now()}-${safeName}`;
  await storage.copy(doc.storage_path, versionPath, doc.mime_type);
  const version = await db.queryOne(
    `INSERT INTO document_versions
     (document_id, version_number, name, size, mime_type, storage_path, document_text, saved_by, saved_by_email, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id, document_id, version_number, name, size, mime_type, saved_at, saved_by_email, source`,
    [doc.id, next, doc.name, doc.size || 0, doc.mime_type, versionPath, doc.document_text || null, user.id, user.email, source]
  );
  await logDocumentEvent(doc.id, 'version_saved', user.id, user.email, `${source} · version ${next}`);
  return version;
}

async function ensureUploadSessionsTable() {
  if (uploadSessionsEnsured) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS upload_sessions (
      id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      name              TEXT        NOT NULL,
      size              BIGINT      NOT NULL DEFAULT 0,
      mime_type         TEXT        NOT NULL,
      storage_path      TEXT        NOT NULL,
      chunk_size        INTEGER     NOT NULL,
      total_chunks      INTEGER     NOT NULL,
      received_chunks   INTEGER[]   NOT NULL DEFAULT '{}',
      received_bytes    BIGINT      NOT NULL DEFAULT 0,
      uploaded_by       UUID,
      uploaded_by_email TEXT,
      status            TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('active','complete','canceled')),
      document_id       UUID        REFERENCES documents(id) ON DELETE SET NULL,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at      TIMESTAMPTZ
    )
  `);
  await db.query('CREATE INDEX IF NOT EXISTS upload_sessions_user_status_idx ON upload_sessions(uploaded_by, status, updated_at DESC)');
  uploadSessionsEnsured = true;
}

async function ensureShareLinksTable() {
  if (shareLinksEnsured) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS document_share_links (
      id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      document_id          UUID        NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      token_hash           TEXT        NOT NULL UNIQUE,
      password_salt        TEXT,
      password_hash        TEXT,
      expires_at           TIMESTAMPTZ,
      revoked_at           TIMESTAMPTZ,
      revoked_by           UUID,
      revoked_by_email     TEXT,
      created_by           UUID,
      created_by_email     TEXT,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_accessed_at      TIMESTAMPTZ,
      access_count         INTEGER     NOT NULL DEFAULT 0
    )
  `);
  await db.query('CREATE INDEX IF NOT EXISTS document_share_links_document_idx ON document_share_links(document_id, created_at DESC)');
  await db.query('CREATE INDEX IF NOT EXISTS document_share_links_active_idx ON document_share_links(token_hash) WHERE revoked_at IS NULL');
  shareLinksEnsured = true;
}

// Public download links for a whole folder. Unlike per-file links (which reference
// one document_id), a folder link snapshots the exact set of document IDs the
// creator could read under the folder at creation time (document_ids[]). The public
// download serves only that frozen set, so a later ACL change can never widen what
// the link exposes, and files added to the folder afterward are NOT retroactively
// shared. Same token/password/expiry/revoke model as document_share_links.
async function ensureFolderShareLinksTable() {
  if (folderShareLinksEnsured) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS folder_share_links (
      id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      folder_path          TEXT        NOT NULL,
      document_ids         UUID[]      NOT NULL DEFAULT '{}',
      token_hash           TEXT        NOT NULL UNIQUE,
      password_salt        TEXT,
      password_hash        TEXT,
      expires_at           TIMESTAMPTZ,
      revoked_at           TIMESTAMPTZ,
      revoked_by           UUID,
      revoked_by_email     TEXT,
      created_by           UUID,
      created_by_email     TEXT,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_accessed_at      TIMESTAMPTZ,
      access_count         INTEGER     NOT NULL DEFAULT 0
    )
  `);
  await db.query('CREATE INDEX IF NOT EXISTS folder_share_links_creator_idx ON folder_share_links(created_by, created_at DESC)');
  await db.query('CREATE INDEX IF NOT EXISTS folder_share_links_active_idx ON folder_share_links(token_hash) WHERE revoked_at IS NULL');
  folderShareLinksEnsured = true;
}

// Total-size ceiling for a folder ZIP (the archive is buffered in memory, so this
// bounds peak RAM — matched between the authed /folder/zip route and the public link).
const FOLDER_ZIP_MAX_BYTES = 500 * 1024 * 1024;
// Upper bound on how many files a single folder copy will duplicate in one request,
// so a pathological folder can't tie up the event loop (or disk) unbounded.
const FOLDER_COPY_MAX_FILES = 5000;

function folderShareClientShape(row, url = null) {
  return {
    id: row.id,
    folder_path: row.folder_path,
    file_count: Array.isArray(row.document_ids) ? row.document_ids.length : Number(row.file_count || 0),
    expires_at: row.expires_at,
    revoked_at: row.revoked_at,
    created_at: row.created_at,
    created_by_email: row.created_by_email,
    last_accessed_at: row.last_accessed_at,
    access_count: Number(row.access_count || 0),
    has_password: !!row.password_hash,
    url,
  };
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function passwordParts(password) {
  if (!password) return { salt: null, hash: null };
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return { salt, hash };
}

function verifySharePassword(password, salt, expectedHash) {
  if (!expectedHash) return true;
  if (!password || !salt) return false;
  const actual = crypto.scryptSync(String(password), salt, 32);
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function shareLinkClientShape(row, url = null) {
  return {
    id: row.id,
    document_id: row.document_id,
    expires_at: row.expires_at,
    revoked_at: row.revoked_at,
    created_at: row.created_at,
    created_by_email: row.created_by_email,
    last_accessed_at: row.last_accessed_at,
    access_count: Number(row.access_count || 0),
    has_password: !!row.password_hash,
    url
  };
}

async function publicAppBase(req) {
  const configured = (await settings.getOrEnv('app_url') || '').replace(/\/$/, '');
  const host = req.get('host') || '';
  // Prefer the host the user actually reached Memex on, so the share link is
  // reachable from their vantage point. The configured app_url can be stale (a
  // dead dev/LAN host) and would otherwise poison every share link. Fall back to
  // app_url only when the request host is internal — e.g. a reverse proxy that
  // didn't forward the original Host header (localhost/loopback/0.0.0.0).
  const hostname = (host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':')[0]).toLowerCase();
  const internal = !host || hostname === 'localhost' || hostname === '::1' || hostname === '0.0.0.0' || /^127\./.test(hostname);
  if (!internal) return `${req.protocol}://${host}`;
  return configured || `${req.protocol}://${host}`;
}

// The exact origin the browser reached this request on. Unlike publicAppBase(),
// this NEVER substitutes the configured app_url — used for the same-origin
// Collabora editor iframe, which is loaded by the very browser already on this
// origin, so a stale/dead app_url must not override it (that yields a blank
// editor). Only falls back to app_url when there is genuinely no Host header.
async function requestOrigin(req) {
  const host = req.get('host') || '';
  if (host) return `${req.protocol}://${host}`;
  return (await settings.getOrEnv('app_url') || '').replace(/\/$/, '');
}

// The base for WOPISrc — the callback URL Collabora fetches SERVER-SIDE (carrying
// the WOPI access token) to read and write the document. It must be an
// operator-configured host and MUST NOT derive from the client Host header:
// otherwise an authenticated user could send Host: <internal-target> and turn
// Collabora into an SSRF probe against the internal network while leaking the
// access token to that host. Prefer the explicit internal URL (the address
// Collabora reaches the app on), then the canonical app_url. Returns null when
// neither is configured, which disables editing rather than trusting the request.
async function wopiCallbackBase() {
  const internalUrl = (await settings.getOrEnv('wopi_internal_url') || '').replace(/\/$/, '');
  if (internalUrl) return internalUrl;
  const appUrl = (await settings.getOrEnv('app_url') || '').replace(/\/$/, '');
  return appUrl || null;
}

// Office file types Collabora can edit.
const COLLABORA_EDIT_EXTS = new Set(['docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'odt', 'ods', 'odp', 'rtf', 'csv']);

// Pull the WOPI `urlsrc` for a given extension out of Collabora's discovery XML.
// Collabora emits <app name="<mime>"><action name="edit|view" ext="docx" urlsrc="…"/></app>.
function discoveryUrlSrc(xml, ext) {
  const actions = String(xml || '').match(/<action\b[^>]*>/g) || [];
  let fallback = null;
  for (const tag of actions) {
    if ((/\bext="([^"]*)"/.exec(tag)?.[1] || '').toLowerCase() !== ext) continue;
    const urlsrc = /\burlsrc="([^"]*)"/.exec(tag)?.[1];
    if (!urlsrc) continue;
    const name = /\bname="([^"]*)"/.exec(tag)?.[1] || '';
    if (/edit/i.test(name)) return urlsrc; // prefer the edit action
    fallback = fallback || urlsrc;
  }
  return fallback;
}

// Build an in-browser Collabora editor URL for a document, or null when editing
// isn't configured (COLLABORA_URL unset), the type isn't editable, or discovery
// is unreachable. Rebases the discovery urlsrc onto the browser-facing origin and
// appends the WOPI callback (to the internal host Collabora can reach) + a token.
async function collaboraEditUrl(doc, ext, req) {
  if (!COLLABORA_EDIT_EXTS.has(ext)) return null;
  const enabled = String((await settings.getOrEnv('collabora_enabled')) || '').toLowerCase() === 'true';
  const configuredBase = (await settings.getOrEnv('collabora_url') || '').replace(/\/$/, '');
  if (!enabled && !configuredBase) return null; // editing not configured — read-only preview
  // Same-origin by default (editor proxied through this app); a configured
  // collabora_url overrides for setups that expose Collabora directly. Use the
  // real request origin (not publicAppBase, which can swap in a stale app_url) —
  // the editor iframe loads from the same origin the browser is already on.
  const browserBase = configuredBase || (await requestOrigin(req)).replace(/\/$/, '');
  // discoveryBase and wopiHost are both fetched SERVER-SIDE, so neither may derive
  // from the client Host header — otherwise an authenticated user could send
  // Host: <internal-target> and make the server (discovery) or Collabora (WOPI)
  // connect there. Only browserBase may reflect the request origin, since it merely
  // prefixes the URL the requester's own browser loads the iframe from.
  // Discovery: internal Collabora URL, then the configured external Collabora URL.
  const discoveryBase = ((await settings.getOrEnv('collabora_internal_url')) || configuredBase).replace(/\/$/, '');
  const wopiHost = await wopiCallbackBase();
  if (!discoveryBase || !wopiHost) {
    console.error('Collabora editing disabled: set collabora_internal_url or collabora_url for discovery, and wopi_internal_url or app_url for the WOPI callback — these server-side fetch hosts must not come from the client Host header.');
    return null;
  }

  let discovery;
  try {
    const r = await fetch(`${discoveryBase}/hosting/discovery`, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) throw new Error('discovery HTTP ' + r.status);
    discovery = await r.text();
  } catch (e) {
    console.error('Collabora discovery fetch failed:', e.message);
    return null;
  }

  const urlsrc = discoveryUrlSrc(discovery, ext);
  if (!urlsrc) return null;
  // Rebase the discovery urlsrc path onto the browser-facing origin so the client
  // loads the editor from a host it can actually reach (discovery may report an
  // internal host).
  let pathAndQuery;
  try { const u = new URL(urlsrc); pathAndQuery = u.pathname + u.search; }
  catch { pathAndQuery = urlsrc.startsWith('/') ? urlsrc : `/${urlsrc}`; }
  const sep = pathAndQuery.includes('?') ? (/[?&]$/.test(pathAndQuery) ? '' : '&') : '?';
  // The office route only requires `read`, so a read-only grantee can reach here.
  // Encode the user's ACTUAL write permission into the WOPI token; Collabora then
  // opens read-only for viewers, and PutFile is refused server-side (see wopi.js).
  const canWrite = !!(await documentAccess.getAccessibleDocument({
    id: doc.id, user: req.user, required: 'write', columns: 'd.id', deleted: 'active',
  }));
  const token = generateToken(doc.id, req.user.id, req.user.email, canWrite);
  const wopiSrc = encodeURIComponent(`${wopiHost}/wopi/files/${doc.id}`);
  return `${browserBase}${pathAndQuery}${sep}WOPISrc=${wopiSrc}&access_token=${token}`;
}

function clampChunkSize(value) {
  const n = Number.parseInt(value || DEFAULT_CHUNK_SIZE, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_CHUNK_SIZE;
  return Math.min(Math.max(n, 1024 * 1024), MAX_CHUNK_SIZE);
}

function uploadSessionClientShape(row) {
  const received = (row.received_chunks || []).map(Number).filter(Number.isInteger).sort((a, b) => a - b);
  return {
    id: row.id,
    name: row.name,
    size: Number(row.size || 0),
    mimeType: row.mime_type,
    chunkSize: Number(row.chunk_size || DEFAULT_CHUNK_SIZE),
    totalChunks: Number(row.total_chunks || 0),
    receivedChunks: received,
    receivedBytes: Number(row.received_bytes || 0),
    status: row.status,
    documentId: row.document_id || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at
  };
}

async function chunkRoot() {
  if (!(await storage.isLocalProvider())) {
    throw new Error('Resumable chunk uploads currently require local storage');
  }
  return path.join(await storage.localBase(), '.uploads');
}

// Free bytes on the storage volume. Fails OPEN (returns Infinity) if statfs isn't
// available or errors — a measurement problem must never block an upload.
async function freeDiskBytes() {
  try {
    if (typeof fs.statfs !== 'function') return Infinity;
    const st = await fs.statfs(await storage.localBase());
    return Number(st.bavail) * Number(st.bsize);
  } catch { return Infinity; }
}
// Minimum free space to keep after an upload (guards against filling the volume and
// taking the app down). Admin-tunable via min_free_disk_mb; default 2 GB.
async function minFreeDiskBytes() {
  const mb = parseInt((await settings.getOrEnv('min_free_disk_mb')) || '2048', 10);
  return (Number.isFinite(mb) && mb >= 0 ? mb : 2048) * 1024 * 1024;
}

async function chunkDir(sessionId) {
  return path.join(await chunkRoot(), String(sessionId));
}

// The at-rest key used for staged chunks — the SAME key storage.js uses for final
// files. Null when encryption isn't configured (the common case), in which case
// chunks are staged and streamed exactly as before.
async function chunkEncKey() {
  try { return encryption.resolveKey(await settings.getOrEnv('storage_encryption_key')); }
  catch { return null; }
}

// Read a stream fully into a buffer, aborting past maxBytes (used only on the
// encryption path, where the whole chunk is needed for AES-GCM). A chunk is small
// (chunk_size; default 8 MB), so this does not reintroduce whole-file buffering.
function readCappedBuffer(readable, maxBytes) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let bytes = 0;
    readable.on('data', c => {
      bytes += c.length;
      if (Number.isFinite(maxBytes) && maxBytes > 0 && bytes > maxBytes) {
        const err = new Error('Chunk exceeds the maximum allowed size');
        err.code = 'CHUNK_TOO_LARGE';
        readable.destroy(err);
        reject(err);
        return;
      }
      parts.push(c);
    });
    readable.on('error', reject);
    readable.on('end', () => resolve(Buffer.concat(parts)));
  });
}

async function writeChunk(sessionId, index, readable, maxBytes) {
  const dir = await chunkDir(sessionId);
  await fs.mkdir(dir, { recursive: true });
  const finalPath = path.join(dir, `${index}.part`);
  const tmpPath = `${finalPath}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  const key = await chunkEncKey();

  // U8: encrypt staged chunks at rest when a storage key is configured, so no
  // plaintext file data ever touches disk (the final stored file is already
  // encrypted; this closes the transient staging gap). Returns the PLAINTEXT byte
  // count, which is what the caller's size checks expect.
  if (key) {
    const buf = await readCappedBuffer(readable, maxBytes);
    try {
      await fs.writeFile(tmpPath, encryption.encrypt(buf, key));
      await fs.rename(tmpPath, finalPath);
    } catch (e) {
      await fs.unlink(tmpPath).catch(() => {});
      throw e;
    }
    return buf.length;
  }

  // No encryption: stream straight to disk (unchanged — low, constant memory).
  let bytes = 0;
  try {
    await new Promise((resolve, reject) => {
      const out = fsSync.createWriteStream(tmpPath);
      readable.on('data', chunk => {
        bytes += chunk.length;
        // Abort before an oversized chunk can fill the disk (rather than writing it
        // all and rejecting afterwards).
        if (Number.isFinite(maxBytes) && maxBytes > 0 && bytes > maxBytes) {
          const err = new Error('Chunk exceeds the maximum allowed size');
          err.code = 'CHUNK_TOO_LARGE';
          readable.destroy(err);
          out.destroy();
          reject(err);
        }
      });
      readable.on('error', reject);
      out.on('error', reject);
      out.on('finish', resolve);
      readable.pipe(out);
    });
  } catch (e) {
    await fs.unlink(tmpPath).catch(() => {});
    throw e;
  }
  await fs.rename(tmpPath, finalPath);
  return bytes;
}

async function removeUploadSessionFiles(sessionId) {
  await fs.rm(await chunkDir(sessionId), { recursive: true, force: true }).catch(() => {});
}

async function chunkedFileStream(session) {
  const key = await chunkEncKey();
  return Readable.from((async function* () {
    for (let i = 0; i < Number(session.total_chunks || 0); i += 1) {
      const p = path.join(await chunkDir(session.id), `${i}.part`);
      if (key) {
        // decrypt() is a no-op on chunks that lack the magic (e.g. staged before a
        // key was set), so a mid-session key change degrades gracefully to plaintext.
        yield encryption.decrypt(await fs.readFile(p), key);
      } else {
        for await (const chunk of fsSync.createReadStream(p)) yield chunk;
      }
    }
  })());
}

// content_hash (U6 re-upload dedupe) is added in place; a nullable TEXT column and a
// partial index are metadata-only changes, so this is instant even on a large table.
let _docColsEnsured = false;
async function ensureDocumentColumns() {
  if (_docColsEnsured) return;
  await db.query('ALTER TABLE documents ADD COLUMN IF NOT EXISTS content_hash TEXT');
  await db.query('CREATE INDEX IF NOT EXISTS documents_content_hash_idx ON documents(library_id, content_hash) WHERE content_hash IS NOT NULL AND deleted_at IS NULL');
  _docColsEnsured = true;
}

async function createDocumentRecord({ displayName, storagePath, mimetype, storedSize, user, sourceDetail, libraryId }) {
  await ensureDocumentColumns();
  let canIngest = false;
  let documentText = null;
  let contentHash = null;
  if (storedSize > 0 && storedSize <= TEXT_EXTRACTION_MAX_BYTES) {
    try {
      const buffer = await storage.download(storagePath);
      contentHash = crypto.createHash('sha256').update(buffer).digest('hex'); // U6: reuse the bytes we already read
      documentText = await extractText(buffer, displayName);
      canIngest = documentText !== null && documentText.trim().length > 0;
    } catch (e) {
      console.error('Text extraction failed (non-fatal):', e.message);
    }
  }
  const lib = libraryId || (await libraries.defaultLibraryId());

  // U6 dedupe: a byte-identical re-upload — same content hash, same name, same library,
  // visible to this user — returns the existing document instead of creating a
  // duplicate. Conservative by design: a changed file has a different hash and is never
  // skipped, so nothing is ever silently dropped. Only computed for files up to the
  // text-extraction size, where we already have the bytes in hand (no extra read).
  if (contentHash) {
    const existing = await db.queryOne(
      `SELECT ${DOCUMENT_COLUMNS} FROM documents d
       WHERE d.deleted_at IS NULL AND d.content_hash = $1 AND d.name = $2 AND d.library_id = $3
         AND ${documentAccess.condition('d', 4)}
       LIMIT 1`,
      [contentHash, displayName, lib, ...documentAccess.userParams(user, 'read')]
    );
    if (existing) {
      await storage.del(storagePath).catch(() => {}); // discard the redundant blob
      await logEvent(`upload dedupe · ${displayName}`, user.id, user.email);
      return { doc: existing, canIngest: false, deduped: true };
    }
  }

  const doc = await db.queryOne(
    `INSERT INTO documents (name, size, mime_type, storage_path, uploaded_by, uploaded_by_email, document_text, library_id, content_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING ${DOCUMENT_COLUMNS}`,
    [displayName, storedSize || 0, mimetype, storagePath, user.id, user.email, documentText, lib, contentHash]
  );
  await documentAccess.grantOwnerAdmin(doc.id, user);
  await logDocumentEvent(doc.id, 'uploaded', user.id, user.email, `${fileSizeLabelForEvent(storedSize || 0)} · ${sourceDetail}`);
  await logEvent(`upload · ${displayName}`, user.id, user.email);
  return { doc, canIngest };
}

// GET /api/files/local-download — serve file using short-lived token (local storage only)
router.get('/local-download', async (req, res) => {
  const entry = storage.validateLocalToken(req.query.token);
  if (!entry) return res.status(401).json({ error: 'Invalid or expired download token' });

  const path = require('path');
  const base = path.basename(entry.storagePath);
  const ext = path.extname(base).toLowerCase().replace('.', '');
  // Types we can safely render inline (for in-app preview). Anything not listed
  // downloads as an attachment, so unknown/executable content can't run in-origin.
  const INLINE_TYPES = {
    pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml',
    txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8',
    csv: 'text/plain; charset=utf-8', log: 'text/plain; charset=utf-8', json: 'application/json',
    // Media — rendered inline in a <video>/<audio> player.
    mp4: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg', m4v: 'video/mp4', mov: 'video/quicktime',
    mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg', oga: 'audio/ogg',
    aac: 'audio/aac', flac: 'audio/flac',
  };
  const inlineType = req.query.inline === '1' ? INLINE_TYPES[ext] : null;

  try {
    // For an inline MP4 whose moov atom is at the end (not web-optimized), serve a
    // fast-started view on the fly so it previews immediately instead of spinning
    // while the browser hunts the tail. Returns null (→ normal streaming) for any
    // other case, so this can only help, never break a download.
    let dl = null;
    if (inlineType && ['mp4', 'm4v', 'mov'].includes(ext) && await storage.isLocalProvider()) {
      try {
        const fsPlan = await mp4Faststart.plan(path.join(await storage.localBase(), entry.storagePath));
        if (fsPlan) dl = mp4Faststart.createStream(fsPlan, req.headers.range);
      } catch { /* fall back to normal streaming */ }
    }
    // Stream the file rather than buffering it in memory (no OOM, no 2 GiB ceiling).
    // Range enables <video>/<audio> seeking without re-fetching the whole file.
    if (!dl) dl = await storage.downloadStream(entry.storagePath, { rangeHeader: req.headers.range });
    const { stream, length, totalSize, range, unsatisfiable } = dl;
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Accept-Ranges', 'bytes');
    if (unsatisfiable) {
      res.setHeader('Content-Range', `bytes */${totalSize}`);
      return res.status(416).end();
    }
    if (inlineType) {
      res.setHeader('Content-Type', inlineType);
      res.setHeader('Content-Disposition', `inline; filename="${base}"`);
      // SVG can carry script — sandbox it so it can't execute if opened directly.
      if (ext === 'svg') res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    } else {
      res.setHeader('Content-Disposition', `attachment; filename="${base}"`);
    }
    if (range) {
      res.status(206);
      res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${totalSize}`);
    }
    if (length != null) res.setHeader('Content-Length', String(length));
    const { pipeline } = require('stream/promises');
    await pipeline(stream, res);
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: e.message });
    else res.destroy(e);
  }
});

// GET /api/files/share/:token — public, revocable, expiring share-link download.
router.get('/share/:token', async (req, res) => {
  await ensureShareLinksTable();
  const hash = tokenHash(req.params.token);
  try {
    const share = await db.queryOne(
      `SELECT s.*, d.name, d.mime_type, d.storage_path, d.deleted_at
       FROM document_share_links s
       JOIN documents d ON d.id = s.document_id
       WHERE s.token_hash = $1`,
      [hash]
    );
    if (!share || share.revoked_at || share.deleted_at) return res.status(404).json({ error: 'Share link not found' });
    if (share.expires_at && new Date(share.expires_at).getTime() < Date.now()) {
      return res.status(410).json({ error: 'Share link expired' });
    }
    const password = req.query.password || req.headers['x-share-password'];
    if (!verifySharePassword(password, share.password_salt, share.password_hash)) {
      return res.status(401).json({ error: 'Share password required' });
    }

    await db.query(
      'UPDATE document_share_links SET last_accessed_at = NOW(), access_count = access_count + 1 WHERE id = $1',
      [share.id]
    );
    await logDocumentEvent(share.document_id, 'share_downloaded', null, null, `public share link · ${requestAuditDetail(req)}`);
    await logEvent(`share download · ${share.name}`, null, null);
    // Notify whoever created the share link that their file was downloaded
    // (2-min dedupe so a browser's double-fetch doesn't double-notify).
    if (share.created_by_email) {
      try {
        await notifications.create({
          userId: share.created_by || null,
          userEmail: share.created_by_email,
          type: 'share_downloaded',
          title: 'Your shared file was downloaded',
          body: `"${share.name}" · via share link`,
          refType: 'document',
          refId: share.document_id,
          dedupeMinutes: 2,
        });
      } catch (e) { console.error('notification (share_downloaded) failed:', e.message); }
      emailEvents.send('share_downloaded', {
        to: share.created_by_email,
        subject: `Your shared file was downloaded: ${share.name}`,
        text: `"${share.name}" was just downloaded via a Memex share link you created.`,
      }).catch(() => {});
    }
    // Stream the file to the client instead of buffering it in memory (this is a
    // public endpoint, so buffering a large shared file would be a remote OOM vector).
    const { stream, length } = await storage.downloadStream(share.storage_path);
    res.setHeader('Content-Type', share.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(share.name)}"`);
    if (length != null) res.setHeader('Content-Length', String(length));
    const { pipeline } = require('stream/promises');
    await pipeline(stream, res);
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: e.message });
    else res.destroy(e);
  }
});

// GET /api/files
router.get('/', auth, async (req, res) => {
  try {
    await documentAccess.ensureDocumentAclTable();
    await libraries.ensureLibraries();
    await profiles.ensureProfiles();
    const libParam = req.query.library || null;
    const rows = await db.query(
      `SELECT ${DOCUMENT_COLUMNS}, up.display_name AS uploaded_by_name
       FROM documents d
       LEFT JOIN user_profiles up ON up.user_id = d.uploaded_by
       WHERE d.deleted_at IS NULL
         AND ${documentAccess.condition('d', 1)}
         AND ($6::uuid IS NULL OR d.library_id = $6)
       ORDER BY d.created_at DESC`,
      [...documentAccess.userParams(req.user, 'read'), libParam]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/files/library-transfer — move or copy selected files into a library
router.post('/library-transfer', auth, requireRole('admin', 'contributor'), async (req, res) => {
  try {
    await libraries.ensureLibraries();
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const libraryId = req.body?.libraryId;
    const mode = req.body?.mode === 'copy' ? 'copy' : 'move';
    if (!ids.length || !libraryId) return res.status(400).json({ error: 'ids and libraryId required' });
    if (!(await libraries.canAccessLibrary(req.user, libraryId))) return res.status(403).json({ error: 'no access to target library' });

    // Restrict to documents the caller can access.
    const accessible = await db.query(
      `SELECT d.id, d.name, d.mime_type, d.size, d.storage_path
       FROM documents d
       WHERE d.id = ANY($6::uuid[]) AND d.deleted_at IS NULL AND ${documentAccess.condition('d', 1)}`,
      [...documentAccess.userParams(req.user, 'read'), ids]
    );

    if (mode === 'move') {
      await db.query('UPDATE documents SET library_id = $1 WHERE id = ANY($2::uuid[])', [libraryId, accessible.map(d => d.id)]);
      return res.json({ ok: true, mode, count: accessible.length });
    }

    // copy: duplicate the stored object + create a new document record per file
    for (const d of accessible) {
      const sanitized = path.basename(d.name).replace(/[^a-zA-Z0-9._-]/g, '_');
      const newPath = `documents/${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${sanitized}`;
      await storage.copy(d.storage_path, newPath, d.mime_type);
      await createDocumentRecord({ displayName: d.name, storagePath: newPath, mimetype: d.mime_type, storedSize: Number(d.size) || 0, user: req.user, sourceDetail: 'copied', libraryId });
    }
    res.json({ ok: true, mode, count: accessible.length });
  } catch (e) {
    console.error('library-transfer failed:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/files/trash — list soft-deleted documents (admin/contributor)
router.get('/trash', auth, requireRole('admin', 'contributor'), async (req, res) => {
  try {
    await documentAccess.ensureDocumentAclTable();
    const rows = await db.query(
      `SELECT ${DOCUMENT_COLUMNS}
       FROM documents d
       WHERE d.deleted_at IS NOT NULL
         AND ${documentAccess.condition('d', 1)}
       ORDER BY d.deleted_at DESC`,
      documentAccess.userParams(req.user, 'write')
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/files/search?q=text — full-text search uploaded document text
router.get('/search', auth, async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json([]);

  try {
    await documentAccess.ensureDocumentAclTable();
    const rows = await db.query(
      `SELECT
         d.id, d.name, d.size, d.mime_type, d.storage_path, d.google_drive_id,
         d.uploaded_by, d.uploaded_by_email, d.created_at, d.deleted_at, d.deleted_by,
         ts_headline(
           'english',
           coalesce(d.document_text, ''),
           websearch_to_tsquery('english', $1),
           'StartSel=<<, StopSel=>>, MaxFragments=2, MaxWords=18, MinWords=5'
         ) AS search_headline,
         ts_rank(d.document_fts, websearch_to_tsquery('english', $1)) AS search_rank
       FROM documents d
       WHERE d.deleted_at IS NULL
         AND (
           d.document_fts @@ websearch_to_tsquery('english', $1)
           OR d.name ILIKE '%' || $1 || '%'
           OR d.uploaded_by_email ILIKE '%' || $1 || '%'
         )
         AND ${documentAccess.condition('d', 2)}
       ORDER BY search_rank DESC NULLS LAST, d.created_at DESC
       LIMIT 50`,
      [q, ...documentAccess.userParams(req.user, 'read')]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/files/upload
router.post('/upload', auth, requireRole('admin', 'contributor'), (req, res, next) => getUpload().then(mw => mw(req, res, next)).catch(next), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file required' });

  const path = require('path');
  const { buffer, originalname, mimetype, size } = req.file;
  const displayName = cleanDisplayName(req.body.displayName) || cleanDisplayName(originalname) || 'upload';
  const sanitizedName = path.basename(displayName).replace(/[^a-zA-Z0-9._-]/g, '_');
  const storagePath = `documents/${Date.now()}-${sanitizedName}`;

  try {
    await storage.upload(storagePath, buffer, mimetype);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  try {
    let canIngest = false;
    let documentText = null;
    try {
      documentText = await extractText(buffer, displayName);
      canIngest = documentText !== null && documentText.trim().length > 0;
    } catch (e) {
      console.error('Text extraction failed (non-fatal):', e.message);
    }

    const doc = await db.queryOne(
      `INSERT INTO documents (name, size, mime_type, storage_path, uploaded_by, uploaded_by_email, document_text, library_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${DOCUMENT_COLUMNS}`,
      [displayName, size, mimetype, storagePath, req.user.id, req.user.email, documentText, await libraries.resolveLibraryId(req)]
    );
    await documentAccess.grantOwnerAdmin(doc.id, req.user);
    await logDocumentEvent(doc.id, 'uploaded', req.user.id, req.user.email, `${fileSizeLabelForEvent(size)} · ${displayName}`);

    res.json({ doc, canIngest });
  } catch (e) {
    // The blob was already written; if the DB insert/grant/audit failed, delete it
    // so a failed upload can't orphan an encrypted blob with no row pointing at it
    // (mirrors the upload-stream path's cleanup).
    await storage.del(storagePath).catch(() => {});
    res.status(500).json({ error: e.message });
  }
});

// POST /api/files/upload-stream — stream request body directly into storage.
// The legacy multipart route above remains for compatibility, but the file-home
// UI uses this route so large files do not sit in server memory before writing.
router.post('/upload-stream', auth, requireRole('admin', 'contributor'), async (req, res) => {
  const path = require('path');
  const rawName = req.query.displayName || req.headers['x-file-name'];
  const displayName = cleanDisplayName(rawName) || 'upload';
  if (!isAllowedFile(displayName)) return res.status(415).json({ error: 'File type not allowed' });

  const sanitizedName = path.basename(displayName).replace(/[^a-zA-Z0-9._-]/g, '_');
  const storagePath = `documents/${Date.now()}-${sanitizedName}`;
  const mimetype = String(req.headers['content-type'] || 'application/octet-stream').split(';')[0] || 'application/octet-stream';
  const declaredSize = Number.parseInt(req.headers['content-length'] || '0', 10);

  const mb = await maxUploadMb();
  const maxBytes = mb * 1024 * 1024;
  // Fast reject when the declared size is already over the cap; the streaming guard
  // below is the authoritative check (Content-Length can be absent or spoofed).
  if (Number.isFinite(declaredSize) && declaredSize > maxBytes) {
    return res.status(413).json({ error: `File exceeds the ${mb} MB upload limit` });
  }

  let storedSize = declaredSize;
  try {
    // The cap is enforced inside uploadStream's own pipeline (see storage.capStream),
    // so an over-cap abort rejects here cleanly instead of crashing on a stream race.
    const result = await storage.uploadStream(storagePath, req, mimetype, { maxBytes });
    if (result && Number.isFinite(result.size) && result.size >= 0) storedSize = result.size;
  } catch (e) {
    await storage.del(storagePath).catch(() => {});
    if (e && e.code === 'UPLOAD_TOO_LARGE') return res.status(413).json({ error: `File exceeds the ${mb} MB upload limit` });
    return res.status(500).json({ error: e.message });
  }

  try {
    let canIngest = false;
    let documentText = null;
    if (storedSize > 0 && storedSize <= TEXT_EXTRACTION_MAX_BYTES) {
      try {
        const buffer = await storage.download(storagePath);
        documentText = await extractText(buffer, displayName);
        canIngest = documentText !== null && documentText.trim().length > 0;
      } catch (e) {
        console.error('Text extraction failed (non-fatal):', e.message);
      }
    }

    const doc = await db.queryOne(
      `INSERT INTO documents (name, size, mime_type, storage_path, uploaded_by, uploaded_by_email, document_text, library_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${DOCUMENT_COLUMNS}`,
      [displayName, storedSize || 0, mimetype, storagePath, req.user.id, req.user.email, documentText, await libraries.resolveLibraryId(req)]
    );
    await documentAccess.grantOwnerAdmin(doc.id, req.user);
    await logDocumentEvent(doc.id, 'uploaded', req.user.id, req.user.email, `${fileSizeLabelForEvent(storedSize || 0)} · streamed upload`);

    res.json({ doc, canIngest, streamed: true });
  } catch (e) {
    await storage.del(storagePath).catch(() => {});
    res.status(500).json({ error: e.message });
  }
});

// POST /api/files/uploads — create or resume a local-backed chunked upload session.
router.post('/uploads', auth, requireRole('admin', 'contributor'), async (req, res) => {
  await ensureUploadSessionsTable();
  const displayName = cleanDisplayName(req.body.displayName || req.body.name) || 'upload';
  if (!isAllowedFile(displayName)) return res.status(415).json({ error: 'File type not allowed' });

  const size = Number.parseInt(req.body.size || '0', 10);
  // Require a real (>0) size: it caps total_chunks and keeps the per-chunk size check
  // active (a 0 size would disable it). Reject anything over the upload limit up front.
  if (!Number.isFinite(size) || size <= 0) return res.status(400).json({ error: 'Valid file size required' });
  const mb = await maxUploadMb();
  if (size > mb * 1024 * 1024) return res.status(413).json({ error: `File exceeds the ${mb} MB upload limit` });

  const mimetype = String(req.body.mimeType || 'application/octet-stream').split(';')[0] || 'application/octet-stream';
  const chunkSize = clampChunkSize(req.body.chunkSize);
  const totalChunks = Math.max(1, Math.ceil(size / chunkSize));
  const sanitizedName = path.basename(displayName).replace(/[^a-zA-Z0-9._-]/g, '_');
  const storagePath = `documents/${Date.now()}-${sanitizedName}`;

  try {
    if (!(await storage.isLocalProvider())) {
      return res.status(400).json({ error: 'Resumable chunk uploads currently require local storage' });
    }
    // Disk-space guard: refuse to start an upload that would drive free space below
    // the floor. Reserve the whole declared size up front so a huge upload can't fill
    // the volume partway through. Fails open if free space can't be measured.
    if ((await freeDiskBytes()) - size < (await minFreeDiskBytes())) {
      return res.status(507).json({ error: 'Not enough free disk space on the server for this upload.' });
    }
    const session = await db.queryOne(
      `INSERT INTO upload_sessions
       (name, size, mime_type, storage_path, chunk_size, total_chunks, uploaded_by, uploaded_by_email)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [displayName, size, mimetype, storagePath, chunkSize, totalChunks, req.user.id, req.user.email]
    );
    await fs.mkdir(await chunkDir(session.id), { recursive: true });
    res.json({ session: uploadSessionClientShape(session) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/files/uploads/:sessionId — inspect resumable upload state.
router.get('/uploads/:sessionId', auth, requireRole('admin', 'contributor'), async (req, res) => {
  await ensureUploadSessionsTable();
  try {
    const session = await db.queryOne(
      'SELECT * FROM upload_sessions WHERE id = $1 AND uploaded_by = $2',
      [req.params.sessionId, req.user.id]
    );
    if (!session) return res.status(404).json({ error: 'Upload session not found' });
    res.json({ session: uploadSessionClientShape(session) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/files/uploads/:sessionId/chunks/:index — upload one raw chunk.
router.put('/uploads/:sessionId/chunks/:index', auth, requireRole('admin', 'contributor'), async (req, res) => {
  await ensureUploadSessionsTable();
  const index = Number.parseInt(req.params.index, 10);
  if (!Number.isInteger(index) || index < 0) return res.status(400).json({ error: 'Valid chunk index required' });

  try {
    const session = await db.queryOne(
      'SELECT * FROM upload_sessions WHERE id = $1 AND uploaded_by = $2',
      [req.params.sessionId, req.user.id]
    );
    if (!session) return res.status(404).json({ error: 'Upload session not found' });
    if (session.status !== 'active') return res.status(409).json({ error: `Upload session is ${session.status}` });
    if (index >= Number(session.total_chunks)) return res.status(400).json({ error: 'Chunk index out of range' });

    // Stop accepting chunks if the volume has dropped below the floor since the
    // session started, so a long upload can't fill the disk and take the app down.
    if ((await freeDiskBytes()) < (await minFreeDiskBytes())) {
      return res.status(507).json({ error: 'Server is low on disk space; upload paused. Try again later.' });
    }

    let bytes;
    try {
      // Cap each chunk at the session's chunk_size so an oversized chunk is aborted
      // mid-write instead of being fully staged to disk before validation.
      bytes = await writeChunk(session.id, index, req, Number(session.chunk_size || 0));
    } catch (e) {
      if (e && e.code === 'CHUNK_TOO_LARGE') return res.status(413).json({ error: 'Chunk exceeds the maximum allowed size' });
      throw e;
    }
    const expectedChunkBytes = index === Number(session.total_chunks) - 1
      ? Number(session.size || 0) - (Number(session.total_chunks || 0) - 1) * Number(session.chunk_size || 0)
      : Number(session.chunk_size || 0);
    if (Number(session.size || 0) > 0 && bytes !== expectedChunkBytes) {
      await fs.unlink(path.join(await chunkDir(session.id), `${index}.part`)).catch(() => {});
      return res.status(400).json({ error: `Chunk ${index} size mismatch`, expected: expectedChunkBytes, received: bytes });
    }
    const received = new Set((session.received_chunks || []).map(Number));
    received.add(index);
    const receivedChunks = Array.from(received).sort((a, b) => a - b);
    const expectedBytes = receivedChunks.reduce((sum, idx) => {
      const isLast = idx === Number(session.total_chunks) - 1;
      if (!isLast) return sum + Number(session.chunk_size || 0);
      const tail = Number(session.size || 0) - (Number(session.total_chunks || 0) - 1) * Number(session.chunk_size || 0);
      return sum + Math.max(0, tail);
    }, 0);
    const updated = await db.queryOne(
      `UPDATE upload_sessions
       SET received_chunks = $1, received_bytes = $2, updated_at = NOW()
       WHERE id = $3
       RETURNING *`,
      [receivedChunks, expectedBytes || bytes, session.id]
    );
    res.json({ session: uploadSessionClientShape(updated) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/files/uploads/:sessionId/complete — assemble chunks into final storage.
router.post('/uploads/:sessionId/complete', auth, requireRole('admin', 'contributor'), async (req, res) => {
  await ensureUploadSessionsTable();
  try {
    const session = await db.queryOne(
      'SELECT * FROM upload_sessions WHERE id = $1 AND uploaded_by = $2',
      [req.params.sessionId, req.user.id]
    );
    if (!session) return res.status(404).json({ error: 'Upload session not found' });
    if (session.status === 'complete' && session.document_id) {
      const doc = await db.queryOne(`SELECT ${DOCUMENT_COLUMNS} FROM documents WHERE id = $1`, [session.document_id]);
      return res.json({ doc, canIngest: false, session: uploadSessionClientShape(session), resumed: true });
    }
    if (session.status !== 'active') return res.status(409).json({ error: `Upload session is ${session.status}` });

    const received = new Set((session.received_chunks || []).map(Number));
    const missing = [];
    for (let i = 0; i < Number(session.total_chunks || 0); i += 1) {
      if (!received.has(i)) missing.push(i);
    }
    if (missing.length) return res.status(409).json({ error: 'Upload is missing chunks', missing });

    const stream = await chunkedFileStream(session);
    const result = await storage.uploadStream(session.storage_path, stream, session.mime_type);
    const storedSize = Number.isFinite(result?.size) && result.size >= 0 ? result.size : Number(session.size || 0);
    const { doc, canIngest } = await createDocumentRecord({
      displayName: session.name,
      storagePath: session.storage_path,
      mimetype: session.mime_type,
      storedSize,
      user: req.user,
      sourceDetail: 'resumable upload',
      libraryId: await libraries.resolveLibraryId(req)
    });

    const updated = await db.queryOne(
      `UPDATE upload_sessions
       SET status = 'complete', document_id = $1, completed_at = NOW(), updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [doc.id, session.id]
    );
    await removeUploadSessionFiles(session.id);
    res.json({ doc, canIngest, session: uploadSessionClientShape(updated), chunked: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/files/uploads/:sessionId — cancel an incomplete upload and remove chunks.
router.delete('/uploads/:sessionId', auth, requireRole('admin', 'contributor'), async (req, res) => {
  await ensureUploadSessionsTable();
  try {
    const session = await db.queryOne(
      'SELECT * FROM upload_sessions WHERE id = $1 AND uploaded_by = $2',
      [req.params.sessionId, req.user.id]
    );
    if (!session) return res.status(404).json({ error: 'Upload session not found' });
    if (session.status === 'active') await removeUploadSessionFiles(session.id);
    await db.query(
      `UPDATE upload_sessions
       SET status = 'canceled', updated_at = NOW()
       WHERE id = $1 AND status = 'active'`,
      [session.id]
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/files/:id/shares — list share links for a document.
router.get('/:id/shares', auth, requireRole('admin', 'contributor'), async (req, res) => {
  await ensureShareLinksTable();
  try {
    const doc = await documentAccess.getAccessibleDocument({
      id: req.params.id,
      user: req.user,
      required: 'read',
      columns: DOCUMENT_COLUMNS,
    });
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    const rows = await db.query(
      `SELECT id, document_id, expires_at, revoked_at, created_at, created_by_email,
              last_accessed_at, access_count, password_hash
       FROM document_share_links
       WHERE document_id = $1
       ORDER BY created_at DESC`,
      [doc.id]
    );
    res.json({ shares: rows.map(row => shareLinkClientShape(row)) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/files/:id/access — list internal user access grants for a document.
router.get('/:id/access', auth, requireRole('admin', 'contributor'), async (req, res) => {
  try {
    const doc = await documentAccess.getAccessibleDocument({
      id: req.params.id,
      user: req.user,
      required: 'admin',
      columns: 'd.id, d.uploaded_by, d.uploaded_by_email',
    });
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    const grants = await documentAccess.listGrants(doc.id);
    res.json({ grants });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/files/:id/access — grant or update internal user access.
router.put('/:id/access', auth, requireRole('admin', 'contributor'), async (req, res) => {
  try {
    const doc = await documentAccess.getAccessibleDocument({
      id: req.params.id,
      user: req.user,
      required: 'admin',
      columns: 'd.id, d.name',
    });
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    const grant = await documentAccess.grantUserAccess(doc.id, {
      email: req.body?.email,
      permission: req.body?.permission || 'read',
      grantedBy: req.user,
    });
    await logDocumentEvent(doc.id, 'access_granted', req.user.id, req.user.email, `${grant.subject_email} · ${grant.permission}`);
    await logEvent(`access grant · ${doc.name} · ${grant.subject_email}`, req.user.id, req.user.email);
    // Notify the grantee (skip self-grants).
    if (grant.subject_email && grant.subject_email.toLowerCase() !== String(req.user.email || '').toLowerCase()) {
      try {
        await notifications.create({
          userEmail: grant.subject_email,
          type: 'share_granted',
          title: `${req.user.email} shared a file with you`,
          body: `"${doc.name}" · ${grant.permission} access`,
          refType: 'document',
          refId: doc.id,
        });
      } catch (e) { console.error('notification (share_granted) failed:', e.message); }
      emailEvents.send('share_granted', {
        to: grant.subject_email,
        subject: `${req.user.email} shared a file with you`,
        text: `${req.user.email} gave you ${grant.permission} access to "${doc.name}" in Memex.\n\nSign in to Memex to open it.`,
      }).catch(() => {});
    }
    res.json({ grant });
  } catch (e) {
    const status = /required|Permission/.test(e.message) ? 400 : 500;
    res.status(status).json({ error: e.message });
  }
});

// DELETE /api/files/:id/access/:grantId — revoke an internal user access grant.
router.delete('/:id/access/:grantId', auth, requireRole('admin', 'contributor'), async (req, res) => {
  try {
    const doc = await documentAccess.getAccessibleDocument({
      id: req.params.id,
      user: req.user,
      required: 'admin',
      columns: 'd.id, d.name',
    });
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    const grant = await documentAccess.revokeUserAccess(doc.id, req.params.grantId);
    if (!grant) return res.status(404).json({ error: 'Access grant not found' });
    await logDocumentEvent(doc.id, 'access_revoked', req.user.id, req.user.email, `${grant.subject_email} · ${grant.permission}`);
    await logEvent(`access revoke · ${doc.name} · ${grant.subject_email}`, req.user.id, req.user.email);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/files/shares — list share links across documents.
router.get('/shares', auth, requireRole('admin', 'contributor'), async (req, res) => {
  await ensureShareLinksTable();
  try {
    await documentAccess.ensureDocumentAclTable();
    const rows = await db.query(
      `SELECT s.id, s.document_id, d.name AS document_name, s.expires_at, s.revoked_at,
              s.created_at, s.created_by_email, s.last_accessed_at, s.access_count,
              s.password_hash, d.deleted_at
       FROM document_share_links s
       JOIN documents d ON d.id = s.document_id
       WHERE ${documentAccess.condition('d', 1)}
       ORDER BY s.revoked_at IS NULL DESC, s.expires_at NULLS LAST, s.created_at DESC
       LIMIT 250`,
      documentAccess.userParams(req.user, 'read')
    );
    res.json({ shares: rows.map(row => ({
      ...shareLinkClientShape(row),
      document_name: row.document_name,
      document_deleted: !!row.deleted_at
    })) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/files/:id/shares — create a secure public share link.
router.post('/:id/shares', auth, requireRole('admin', 'contributor'), async (req, res) => {
  await ensureShareLinksTable();
  try {
    const doc = await documentAccess.getAccessibleDocument({
      id: req.params.id,
      user: req.user,
      required: 'write',
      columns: DOCUMENT_COLUMNS,
    });
    if (!doc) return res.status(404).json({ error: 'Document not found' });

    const expiresInDays = Number.parseInt(req.body?.expiresInDays || '7', 10);
    const safeDays = Number.isFinite(expiresInDays) && expiresInDays > 0 ? Math.min(expiresInDays, 365) : 7;
    const expiresAt = req.body?.neverExpires ? null : new Date(Date.now() + safeDays * 24 * 60 * 60 * 1000).toISOString();
    const token = crypto.randomBytes(32).toString('base64url');
    const { salt, hash } = passwordParts(String(req.body?.password || '').trim());

    const share = await db.queryOne(
      `INSERT INTO document_share_links
       (document_id, token_hash, password_salt, password_hash, expires_at, created_by, created_by_email)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, document_id, expires_at, revoked_at, created_at, created_by_email,
                 last_accessed_at, access_count, password_hash`,
      [doc.id, tokenHash(token), salt, hash, expiresAt, req.user.id, req.user.email]
    );
    const url = `${await publicAppBase(req)}/api/files/share/${token}`;
    await logDocumentEvent(doc.id, 'share_created', req.user.id, req.user.email, `${expiresAt ? `expires ${expiresAt}` : 'no expiration'}${hash ? ' · password protected' : ''}`);
    await logEvent(`share create · ${doc.name}`, req.user.id, req.user.email);
    res.json({ share: shareLinkClientShape(share, url) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/files/:id/shares/:shareId — revoke a share link.
router.delete('/:id/shares/:shareId', auth, requireRole('admin', 'contributor'), async (req, res) => {
  await ensureShareLinksTable();
  try {
    const doc = await documentAccess.getAccessibleDocument({
      id: req.params.id,
      user: req.user,
      required: 'write',
      columns: 'd.id',
    });
    if (!doc) return res.status(404).json({ error: 'Share link not found' });
    const share = await db.queryOne(
      `UPDATE document_share_links
       SET revoked_at = NOW(), revoked_by = $1, revoked_by_email = $2
       WHERE id = $3 AND document_id = $4 AND revoked_at IS NULL
       RETURNING id, document_id`,
      [req.user.id, req.user.email, req.params.shareId, req.params.id]
    );
    if (!share) return res.status(404).json({ error: 'Share link not found' });
    await logDocumentEvent(share.document_id, 'share_revoked', req.user.id, req.user.email, `share ${req.params.shareId}`);
    await logEvent(`share revoke · ${req.params.id}`, req.user.id, req.user.email);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// GET /api/files/:id/url
router.get('/:id/url', auth, async (req, res) => {
  try {
    const doc = await documentAccess.getAccessibleDocument({
      id: req.params.id,
      user: req.user,
      required: 'read',
      columns: `${DOCUMENT_COLUMNS}, d.document_text`,
      deleted: 'active',
    });
    if (!doc) return res.status(404).json({ error: 'Document not found' });

    const url = await storage.getUrl(doc.storage_path, 3600);
    await logEvent(`download · ${doc.name}`, req.user.id, req.user.email);
    // Also record the read in the tamper-evident chain — "who accessed this file"
    // is the most important audit event and was previously only in activity_log.
    await logDocumentEvent(doc.id, 'downloaded', req.user.id, req.user.email, doc.name);
    res.json({ url, name: doc.name });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/files/:id/office
router.get('/:id/office', auth, async (req, res) => {
  try {
    const doc = await documentAccess.getAccessibleDocument({
      id: req.params.id,
      user: req.user,
      required: 'read',
      columns: `${DOCUMENT_COLUMNS}, d.document_text`,
      deleted: 'active',
    });
    if (!doc) return res.status(404).json({ error: 'Document not found' });

    const signedUrl = await storage.getUrl(doc.storage_path, 3600);
    const ext = doc.name.split('.').pop().toLowerCase();

    const viewUrl = `https://view.officeapps.live.com/op/view.aspx?src=${encodeURIComponent(signedUrl)}`;

    // Self-hosted in-browser editing via Collabora/WOPI (no Microsoft/personal
    // accounts). Null when editing isn't configured (COLLABORA_URL unset) or the
    // type isn't editable — the client then offers read-only preview only.
    let editUrl = null;
    try { editUrl = await collaboraEditUrl(doc, ext, req); }
    catch (e) { console.error('Collabora edit URL failed:', e.message); }

    await logEvent(`view · ${doc.name}`, req.user.id, req.user.email);
    // Mirror the read into the tamper-evident chain (see /:id/url above).
    await logDocumentEvent(doc.id, 'viewed', req.user.id, req.user.email, doc.name);
    res.json({ viewUrl, editUrl, ext });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/files/:id/google
router.post('/:id/google', auth, async (req, res) => {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
    return res.status(400).json({
      error: 'Google Drive integration is not configured. Set GOOGLE_SERVICE_ACCOUNT_KEY in your environment.'
    });
  }

  try {
    const doc = await documentAccess.getAccessibleDocument({
      id: req.params.id,
      user: req.user,
      required: 'write',
      columns: DOCUMENT_COLUMNS,
      deleted: 'active',
    });
    if (!doc) return res.status(404).json({ error: 'Document not found' });

    let buffer;
    try {
      buffer = await storage.download(doc.storage_path);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
    const ext = doc.name.split('.').pop().toLowerCase();

    const googleMimeTypes = {
      docx: 'application/vnd.google-apps.document',
      doc:  'application/vnd.google-apps.document',
      xlsx: 'application/vnd.google-apps.spreadsheet',
      xls:  'application/vnd.google-apps.spreadsheet',
      pptx: 'application/vnd.google-apps.presentation',
      ppt:  'application/vnd.google-apps.presentation',
    };

    const { google } = require('googleapis');

    let credentials;
    try {
      credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
    } catch {
      return res.status(500).json({ error: 'Invalid GOOGLE_SERVICE_ACCOUNT_KEY — must be valid JSON' });
    }

    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/drive'],
    });

    const drive = google.drive({ version: 'v3', auth });

    const fileMetadata = {
      name: doc.name,
      mimeType: googleMimeTypes[ext] || doc.mime_type,
      ...(process.env.GOOGLE_DRIVE_FOLDER_ID ? { parents: [process.env.GOOGLE_DRIVE_FOLDER_ID] } : {}),
    };

    const { Readable } = require('stream');
    const { data: driveFile } = await drive.files.create({
      requestBody: fileMetadata,
      media: { mimeType: doc.mime_type, body: Readable.from(buffer) },
      fields: 'id, webViewLink',
    });

    try {
      await drive.permissions.create({
        fileId: driveFile.id,
        requestBody: { type: 'user', role: 'writer', emailAddress: req.user.email },
      });
    } catch (shareErr) {
      console.error('Google Drive share failed (non-fatal):', shareErr.message);
    }

    await db.query('UPDATE documents SET google_drive_id = $1 WHERE id = $2', [driveFile.id, doc.id]);
    res.json({ editUrl: driveFile.webViewLink, driveId: driveFile.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/files/:id/google/export
router.post('/:id/google/export', auth, requireRole('admin', 'contributor'), async (req, res) => {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
    return res.status(400).json({
      error: 'Google Drive integration is not configured. Set GOOGLE_SERVICE_ACCOUNT_KEY in your environment.'
    });
  }

  try {
    const doc = await documentAccess.getAccessibleDocument({
      id: req.params.id,
      user: req.user,
      required: 'write',
      columns: DOCUMENT_COLUMNS,
      deleted: 'active',
    });
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    if (!doc.google_drive_id) return res.status(400).json({ error: 'Document has not been pushed to Google Drive' });

    const ext = doc.name.split('.').pop().toLowerCase();
    const exportMimeTypes = {
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      doc:  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      xls:  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      ppt:  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    };
    const exportMime = exportMimeTypes[ext];
    if (!exportMime) return res.status(400).json({ error: `Export not supported for .${ext} files` });

    const { google } = require('googleapis');

    let credentials;
    try {
      credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
    } catch {
      return res.status(500).json({ error: 'Invalid GOOGLE_SERVICE_ACCOUNT_KEY — must be valid JSON' });
    }

    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/drive'],
    });
    const drive = google.drive({ version: 'v3', auth });

    const { data: exportStream } = await drive.files.export(
      { fileId: doc.google_drive_id, mimeType: exportMime },
      { responseType: 'stream' }
    );

    const chunks = [];
    await new Promise((resolve, reject) => {
      exportStream.on('data', chunk => chunks.push(chunk));
      exportStream.on('end', resolve);
      exportStream.on('error', reject);
    });
    const buffer = Buffer.concat(chunks);

    await saveDocumentVersion(doc, req.user, 'google_export');
    await storage.upload(doc.storage_path, buffer, exportMime);
    let documentText = null;
    let textExtracted = false;
    try {
      documentText = await extractText(buffer, doc.name);
      textExtracted = true;
    } catch (e) {
      console.error('Text extraction after Google export failed (non-fatal):', e.message);
    }
    if (textExtracted) {
      await db.query('UPDATE documents SET size = $1, mime_type = $2, document_text = $3 WHERE id = $4', [buffer.length, exportMime, documentText, doc.id]);
    } else {
      await db.query('UPDATE documents SET size = $1, mime_type = $2 WHERE id = $3', [buffer.length, exportMime, doc.id]);
    }
    await logDocumentEvent(doc.id, 'updated', req.user.id, req.user.email, `Google export · ${fileSizeLabelForEvent(buffer.length)}`);
    res.json({ success: true, size: buffer.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/files/:id/history — admin-only file audit timeline and versions
router.get('/:id/history', auth, requireRole('admin'), async (req, res) => {
  try {
    const doc = await documentAccess.getAccessibleDocument({
      id: req.params.id,
      user: req.user,
      required: 'admin',
      columns: DOCUMENT_COLUMNS,
      deleted: 'any',
    });
    if (!doc) return res.status(404).json({ error: 'Document not found' });

    const [events, versions, retention] = await Promise.all([
      db.query(
        `SELECT id, event_type, actor_email, detail, created_at
         FROM document_events
         WHERE document_id = $1
         ORDER BY created_at DESC
         LIMIT 100`,
        [req.params.id]
      ),
      db.query(
        `SELECT id, version_number, name, size, mime_type, saved_at, saved_by_email, source
         FROM document_versions
         WHERE document_id = $1
         ORDER BY version_number DESC`,
        [req.params.id]
      ),
      trashRetentionDays()
    ]);

    res.json({ doc, events, versions, retention_days: retention });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/files/:id/restore-version/:versionId — restore a previous stored file version
router.post('/:id/restore-version/:versionId', auth, requireRole('admin', 'contributor'), async (req, res) => {
  try {
    const doc = await documentAccess.getAccessibleDocument({
      id: req.params.id,
      user: req.user,
      required: 'write',
      columns: `${DOCUMENT_COLUMNS}, d.document_text`,
      deleted: 'any',
    });
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    const version = await db.queryOne(
      `SELECT id, version_number, name, size, mime_type, storage_path, document_text
       FROM document_versions
       WHERE id = $1 AND document_id = $2`,
      [req.params.versionId, req.params.id]
    );
    if (!version) return res.status(404).json({ error: 'Version not found' });

    await saveDocumentVersion(doc, req.user, 'before_version_restore');
    await storage.copy(version.storage_path, doc.storage_path, version.mime_type);
    const updated = await db.queryOne(
      `UPDATE documents
       SET name = $1, size = $2, mime_type = $3, document_text = $4,
           deleted_at = NULL, deleted_by = NULL, deleted_by_email = NULL,
           restored_at = NOW(), restored_by = $5, restored_by_email = $6
       WHERE id = $7
       RETURNING ${DOCUMENT_COLUMNS}`,
      [version.name, version.size || 0, version.mime_type, version.document_text || null, req.user.id, req.user.email, doc.id]
    );

    await logDocumentEvent(doc.id, 'version_restored', req.user.id, req.user.email, `restored version ${version.version_number}`);
    await logEvent(`version restore · ${updated.name} · v${version.version_number}`, req.user.id, req.user.email);
    res.json({ doc: updated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/files/:id
// DELETE /api/files/:id — soft-delete (move to trash); storage object is retained
router.delete('/:id', auth, requireRole('admin', 'contributor'), async (req, res) => {
  try {
    const doc = await documentAccess.getAccessibleDocument({
      id: req.params.id,
      user: req.user,
      required: 'write',
      columns: DOCUMENT_COLUMNS,
      deleted: 'active',
    });
    if (!doc) return res.status(404).json({ error: 'Document not found' });

    await db.query('UPDATE documents SET deleted_at = NOW(), deleted_by = $2, deleted_by_email = $3 WHERE id = $1', [req.params.id, req.user.id, req.user.email]);
    await logDocumentEvent(doc.id, 'trashed', req.user.id, req.user.email, `retention ${await trashRetentionDays()} days`);
    await logEvent(`trash · ${doc.name}`, req.user.id, req.user.email);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/files/:id/rename — change a document's display name (preserves its folder path)
router.put('/:id/rename', auth, requireRole('admin', 'contributor'), async (req, res) => {
  try {
    const doc = await documentAccess.getAccessibleDocument({
      id: req.params.id, user: req.user, required: 'write', columns: DOCUMENT_COLUMNS, deleted: 'active',
    });
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    // Sanitize the new name the same way uploads are (strip HTML-significant and
    // control characters, neutralize traversal segments) so a rename cannot store a
    // name the upload path would never have accepted.
    const name = cleanDisplayName(req.body?.name).slice(0, 400);
    if (!name) return res.status(400).json({ error: 'name required' });
    const updated = await db.queryOne('UPDATE documents SET name = $2 WHERE id = $1 RETURNING *', [req.params.id, name]);
    await logDocumentEvent(doc.id, 'renamed', req.user.id, req.user.email, `${doc.name} → ${name}`);
    res.json({ success: true, name: updated.name });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Per-user "recently opened" tracking, powering the Recent rail.
let _recentEnsured = false;
async function ensureRecentOpens() {
  if (_recentEnsured) return;
  await db.query(`CREATE TABLE IF NOT EXISTS recent_opens (
    user_id UUID NOT NULL, document_id UUID NOT NULL,
    opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, document_id))`);
  await db.query('CREATE INDEX IF NOT EXISTS recent_opens_user_idx ON recent_opens(user_id, opened_at DESC)');
  _recentEnsured = true;
}

// GET /api/files/recent — documents the caller has opened, most recent first
router.get('/recent', auth, async (req, res) => {
  try {
    await ensureRecentOpens();
    const rows = await db.query(
      `SELECT d.id, d.name, d.size, d.mime_type, d.created_at, d.uploaded_by, d.uploaded_by_email, d.library_id, r.opened_at
       FROM recent_opens r JOIN documents d ON d.id = r.document_id
       WHERE r.user_id = $1 AND d.deleted_at IS NULL AND ${documentAccess.condition('d', 2)}
       ORDER BY r.opened_at DESC LIMIT 40`,
      [req.user.id, ...documentAccess.userParams(req.user, 'read')]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/files/:id/open — record that the caller opened this document
router.post('/:id/open', auth, async (req, res) => {
  try {
    const doc = await documentAccess.getAccessibleDocument({ id: req.params.id, user: req.user, required: 'read', columns: 'id', deleted: 'active' });
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    await ensureRecentOpens();
    await db.query(
      `INSERT INTO recent_opens (user_id, document_id, opened_at) VALUES ($1, $2, NOW())
       ON CONFLICT (user_id, document_id) DO UPDATE SET opened_at = NOW()`,
      [req.user.id, doc.id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Build a safe, optionally-foldered document name (no traversal, single basename per segment).
function safeDocName(folder, base) {
  const clean = s => String(s || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').trim();
  const f = clean(folder), b = clean(base);
  // Strip HTML-significant and control characters per segment (matches upload
  // sanitization) while still rejecting traversal segments outright.
  const segs = [...f.split('/'), b].map(s => s.trim().replace(/[^a-zA-Z0-9._ -]/g, '_')).filter(Boolean);
  if (segs.some(s => s === '..' || s === '.')) return null;
  return segs.join('/').slice(0, 400) || null;
}

// POST /api/files/create — create a blank document of a supported type
router.post('/create', auth, requireRole('admin', 'contributor'), async (req, res) => {
  try {
    const ext = String(req.body?.type || '').toLowerCase();
    if (!blankDocs.SUPPORTED.includes(ext)) return res.status(400).json({ error: 'Unsupported file type' });
    const rawName = String(req.body?.name || '').trim().replace(new RegExp('\\.' + ext + '$', 'i'), '');
    if (!rawName) return res.status(400).json({ error: 'name required' });
    const fullName = safeDocName(req.body?.folder, `${rawName}.${ext}`);
    if (!fullName) return res.status(400).json({ error: 'invalid name' });
    const blank = blankDocs.blankFile(ext, rawName);

    const path = require('path');
    const sanitized = path.basename(fullName).replace(/[^a-zA-Z0-9._-]/g, '_');
    const storagePath = `documents/${Date.now()}-${sanitized}`;
    await storage.upload(storagePath, blank.buffer, blank.mime);
    const { doc } = await createDocumentRecord({
      displayName: fullName, storagePath, mimetype: blank.mime, storedSize: blank.buffer.length,
      user: req.user, sourceDetail: 'created', libraryId: req.body?.library_id || null,
    });
    res.json(doc);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/files/folder — create an (empty) folder via a hidden .keep marker
router.post('/folder', auth, requireRole('admin', 'contributor'), async (req, res) => {
  try {
    const folderPath = safeDocName(req.body?.path, '');
    if (!folderPath) return res.status(400).json({ error: 'path required' });
    const markerName = `${folderPath}/.keep`;
    const path = require('path');
    const storagePath = `documents/${Date.now()}-keep`;
    await storage.upload(storagePath, Buffer.alloc(0), 'application/octet-stream');
    const doc = await db.queryOne(
      `INSERT INTO documents (name, size, mime_type, storage_path, uploaded_by, uploaded_by_email, library_id)
       VALUES ($1, 0, $2, $3, $4, $5, $6) RETURNING ${DOCUMENT_COLUMNS}`,
      [markerName, 'application/octet-stream', storagePath, req.user.id, req.user.email, req.body?.library_id || (await libraries.defaultLibraryId())]
    );
    await documentAccess.grantOwnerAdmin(doc.id, req.user);
    res.json({ ok: true, path: folderPath });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/files/folder/rename — rename a folder (re-prefix every file under it)
router.post('/folder/rename', auth, requireRole('admin', 'contributor'), async (req, res) => {
  try {
    const oldPath = safeDocName(req.body?.path, '');
    const rawName = String(req.body?.name || '').trim();
    if (!oldPath || !rawName) return res.status(400).json({ error: 'path and name required' });
    if (/[\/\\]/.test(rawName) || rawName === '..' || rawName === '.') return res.status(400).json({ error: 'invalid name' });
    // Strip HTML-significant and control characters (single folder segment).
    const newName = rawName.replace(/[^a-zA-Z0-9._ -]/g, '_');
    const parent = oldPath.split('/').slice(0, -1).join('/');
    const newPath = parent ? `${parent}/${newName}` : newName;
    const rows = await db.query(
      `UPDATE documents d SET name = $2 || substring(d.name from $3::int)
       WHERE d.deleted_at IS NULL AND d.name LIKE $1 || '/%' AND ${documentAccess.condition('d', 4)}
       RETURNING d.id`,
      [oldPath, newPath, oldPath.length + 1, ...documentAccess.userParams(req.user, 'write')]
    );
    await logEvent(`folder rename · ${oldPath} → ${newPath}`, req.user.id, req.user.email);
    res.json({ ok: true, path: newPath, count: rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/files/folder/delete — move a whole folder's contents to Trash
router.post('/folder/delete', auth, requireRole('admin', 'contributor'), async (req, res) => {
  try {
    const folderPath = safeDocName(req.body?.path, '');
    if (!folderPath) return res.status(400).json({ error: 'path required' });
    const rows = await db.query(
      `UPDATE documents d SET deleted_at = NOW(), deleted_by = $2, deleted_by_email = $3
       WHERE d.deleted_at IS NULL AND d.name LIKE $1 || '/%' AND ${documentAccess.condition('d', 4)}
       RETURNING d.id`,
      [folderPath, req.user.id, req.user.email, ...documentAccess.userParams(req.user, 'write')]
    );
    await logEvent(`folder trash · ${folderPath} (${rows.length})`, req.user.id, req.user.email);
    res.json({ ok: true, count: rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/files/folder/reparent — move a folder under a different parent (drag-drop)
router.post('/folder/reparent', auth, requireRole('admin', 'contributor'), async (req, res) => {
  try {
    const oldPath = safeDocName(req.body?.path, '');
    const target = safeDocName(req.body?.target, '') || ''; // '' = move to root
    if (!oldPath) return res.status(400).json({ error: 'path required' });
    const base = oldPath.split('/').pop();
    const newPath = target ? `${target}/${base}` : base;
    if (newPath === oldPath) return res.json({ ok: true, path: oldPath, count: 0 }); // already there
    if (target === oldPath || target.startsWith(oldPath + '/')) return res.status(400).json({ error: "Can't move a folder into itself" });
    const rows = await db.query(
      `UPDATE documents d SET name = $2 || substring(d.name from $3::int)
       WHERE d.deleted_at IS NULL AND d.name LIKE $1 || '/%' AND ${documentAccess.condition('d', 4)}
       RETURNING d.id`,
      [oldPath, newPath, oldPath.length + 1, ...documentAccess.userParams(req.user, 'write')]
    );
    await logEvent(`folder move · ${oldPath} → ${newPath}`, req.user.id, req.user.email);
    res.json({ ok: true, path: newPath, count: rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/files/folder/move — move a folder's contents to another library
router.post('/folder/move', auth, requireRole('admin', 'contributor'), async (req, res) => {
  try {
    const folderPath = safeDocName(req.body?.path, '');
    if (!folderPath) return res.status(400).json({ error: 'path required' });
    const libraryId = req.body?.library_id || (await libraries.defaultLibraryId());
    const rows = await db.query(
      `UPDATE documents d SET library_id = $2
       WHERE d.deleted_at IS NULL AND d.name LIKE $1 || '/%' AND ${documentAccess.condition('d', 3)}
       RETURNING d.id`,
      [folderPath, libraryId, ...documentAccess.userParams(req.user, 'write')]
    );
    res.json({ ok: true, count: rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/files/folder/zip?path=... — download a folder's files as a compressed zip
router.get('/folder/zip', auth, async (req, res) => {
  try {
    const folderPath = safeDocName(req.query.path, '');
    if (!folderPath) return res.status(400).json({ error: 'path required' });
    const docs = await db.query(
      `SELECT d.id, d.name, d.storage_path, d.size FROM documents d
       WHERE d.deleted_at IS NULL AND d.name LIKE $1 || '/%' AND d.name NOT LIKE '%/.keep' AND ${documentAccess.condition('d', 2)}
       ORDER BY d.name`,
      [folderPath, ...documentAccess.userParams(req.user, 'read')]
    );
    if (!docs.length) return res.status(404).json({ error: 'No files in this folder' });
    const total = docs.reduce((s, d) => s + Number(d.size || 0), 0);
    if (total > FOLDER_ZIP_MAX_BYTES) return res.status(413).json({ error: 'Folder is too large to zip (over 500 MB)' });
    const base = folderPath.split('/').pop().replace(/[^a-zA-Z0-9._-]/g, '_');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${base}.zip"`);
    // Stream the archive (one file buffered at a time) rather than building the
    // whole ZIP in memory — bounds peak RAM regardless of folder size.
    await require('stream/promises').pipeline(zipStream(folderZipEntries(docs, folderPath)), res);
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: e.message });
    else res.destroy(e);
  }
});

// Lazy ZIP entries for a folder's documents, each named relative to the folder's
// own parent so the archive unpacks into a single top-level folder. load() fetches
// one file's bytes on demand, so zipStream only ever holds one file in memory.
function folderZipEntries(docs, folderPath) {
  const parent = folderPath.split('/').slice(0, -1).join('/');
  return docs.map(d => ({
    name: parent ? d.name.slice(parent.length + 1) : d.name,
    load: () => storage.download(d.storage_path),
  }));
}

// GET /api/files/folder/links?path=... — list the caller's folder download links.
router.get('/folder/links', auth, requireRole('admin', 'contributor'), async (req, res) => {
  await ensureFolderShareLinksTable();
  try {
    const folderPath = safeDocName(req.query.path, '');
    if (!folderPath) return res.status(400).json({ error: 'path required' });
    const adminAll = (req.user.role === 'admin');
    const rows = await db.query(
      `SELECT id, folder_path, document_ids, expires_at, revoked_at, created_at,
              created_by_email, last_accessed_at, access_count, password_hash
       FROM folder_share_links
       WHERE folder_path = $1 ${adminAll ? '' : 'AND created_by = $2'}
       ORDER BY revoked_at IS NULL DESC, created_at DESC
       LIMIT 100`,
      adminAll ? [folderPath] : [folderPath, req.user.id]
    );
    res.json({ shares: rows.map(r => folderShareClientShape(r)) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/files/folder/links — mint a public download link for a folder.
router.post('/folder/links', auth, requireRole('admin', 'contributor'), async (req, res) => {
  await ensureFolderShareLinksTable();
  try {
    const folderPath = safeDocName(req.body?.path, '');
    if (!folderPath) return res.status(400).json({ error: 'path required' });
    // Snapshot exactly the files the CREATOR may re-publish under this folder.
    // Requires 'write' (not 'read') to mint a public link — same bar the per-file
    // share (POST /:id/shares) enforces, so a read-only grantee can't re-expose files.
    const docs = await db.query(
      `SELECT d.id, d.size FROM documents d
       WHERE d.deleted_at IS NULL AND d.name LIKE $1 || '/%' AND d.name NOT LIKE '%/.keep' AND ${documentAccess.condition('d', 2)}`,
      [folderPath, ...documentAccess.userParams(req.user, 'write')]
    );
    if (!docs.length) return res.status(404).json({ error: 'No files in this folder to share' });
    const total = docs.reduce((s, d) => s + Number(d.size || 0), 0);
    if (total > FOLDER_ZIP_MAX_BYTES) return res.status(413).json({ error: 'Folder is too large to share as a link (over 500 MB)' });

    const expiresInDays = Number.parseInt(req.body?.expiresInDays || '7', 10);
    const safeDays = Number.isFinite(expiresInDays) && expiresInDays > 0 ? Math.min(expiresInDays, 365) : 7;
    const expiresAt = req.body?.neverExpires ? null : new Date(Date.now() + safeDays * 24 * 60 * 60 * 1000).toISOString();
    const token = crypto.randomBytes(32).toString('base64url');
    const { salt, hash } = passwordParts(String(req.body?.password || '').trim());

    const share = await db.queryOne(
      `INSERT INTO folder_share_links
       (folder_path, document_ids, token_hash, password_salt, password_hash, expires_at, created_by, created_by_email)
       VALUES ($1, $2::uuid[], $3, $4, $5, $6, $7, $8)
       RETURNING id, folder_path, document_ids, expires_at, revoked_at, created_at,
                 created_by_email, last_accessed_at, access_count, password_hash`,
      [folderPath, docs.map(d => d.id), tokenHash(token), salt, hash, expiresAt, req.user.id, req.user.email]
    );
    const url = `${await publicAppBase(req)}/api/files/folder/share/${token}`;
    await logEvent(`folder share create · ${folderPath} (${docs.length})`, req.user.id, req.user.email);
    res.json({ share: folderShareClientShape(share, url) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/files/folder/links/:shareId — revoke a folder download link.
router.delete('/folder/links/:shareId', auth, requireRole('admin', 'contributor'), async (req, res) => {
  await ensureFolderShareLinksTable();
  try {
    const adminAll = (req.user.role === 'admin');
    const share = await db.queryOne(
      `UPDATE folder_share_links
       SET revoked_at = NOW(), revoked_by = $1, revoked_by_email = $2
       WHERE id = $3 AND revoked_at IS NULL ${adminAll ? '' : 'AND created_by = $4'}
       RETURNING id, folder_path`,
      adminAll ? [req.user.id, req.user.email, req.params.shareId] : [req.user.id, req.user.email, req.params.shareId, req.user.id]
    );
    if (!share) return res.status(404).json({ error: 'Folder share link not found' });
    await logEvent(`folder share revoke · ${share.folder_path}`, req.user.id, req.user.email);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/files/folder/share/:token — public, revocable, expiring folder ZIP download.
router.get('/folder/share/:token', async (req, res) => {
  await ensureFolderShareLinksTable();
  const hash = tokenHash(req.params.token);
  try {
    const share = await db.queryOne('SELECT * FROM folder_share_links WHERE token_hash = $1', [hash]);
    if (!share || share.revoked_at) return res.status(404).json({ error: 'Share link not found' });
    if (share.expires_at && new Date(share.expires_at).getTime() < Date.now()) {
      return res.status(410).json({ error: 'Share link expired' });
    }
    const password = req.query.password || req.headers['x-share-password'];
    if (!verifySharePassword(password, share.password_salt, share.password_hash)) {
      return res.status(401).json({ error: 'Share password required' });
    }
    // Serve only the frozen snapshot set, skipping any file deleted since creation.
    const ids = Array.isArray(share.document_ids) ? share.document_ids : [];
    const docs = ids.length ? await db.query(
      `SELECT id, name, storage_path, size FROM documents
       WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL ORDER BY name`,
      [ids]
    ) : [];
    if (!docs.length) return res.status(404).json({ error: 'These files are no longer available' });
    const total = docs.reduce((s, d) => s + Number(d.size || 0), 0);
    if (total > FOLDER_ZIP_MAX_BYTES) return res.status(413).json({ error: 'Folder is too large to download' });

    await db.query('UPDATE folder_share_links SET last_accessed_at = NOW(), access_count = access_count + 1 WHERE id = $1', [share.id]);
    await logEvent(`folder share download · ${share.folder_path}`, null, null);
    if (share.created_by_email) {
      try {
        await notifications.create({
          userId: share.created_by || null,
          userEmail: share.created_by_email,
          type: 'share_downloaded',
          title: 'Your shared folder was downloaded',
          body: `"${share.folder_path.split('/').pop()}" · via folder link`,
          dedupeMinutes: 2,
        });
      } catch (e) { console.error('notification (folder share_downloaded) failed:', e.message); }
      emailEvents.send('share_downloaded', {
        to: share.created_by_email,
        subject: `Your shared folder was downloaded: ${share.folder_path.split('/').pop()}`,
        text: `The folder "${share.folder_path}" was just downloaded via a Memex share link you created.`,
      }).catch(() => {});
    }
    const base = share.folder_path.split('/').pop().replace(/[^a-zA-Z0-9._-]/g, '_');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${base}.zip"`);
    // Stream (one file in memory at a time) — this is a public, unauthenticated
    // route, so buffering the whole archive would be a remote-OOM vector.
    await require('stream/promises').pipeline(zipStream(folderZipEntries(docs, share.folder_path)), res);
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: e.message });
    else res.destroy(e);
  }
});

// GET /api/files/folder/members?path=... — who has been granted access across a folder.
router.get('/folder/members', auth, requireRole('admin', 'contributor'), async (req, res) => {
  try {
    await documentAccess.ensureDocumentAclTable();
    const folderPath = safeDocName(req.query.path, '');
    if (!folderPath) return res.status(400).json({ error: 'path required' });
    // Only surface grants on files the caller can administer, and collapse the
    // per-file rows into one line per person (with how many files they can reach).
    const rows = await db.query(
      `SELECT acl.subject_id,
              max(acl.subject_email) AS subject_email,
              CASE WHEN count(DISTINCT acl.permission) > 1 THEN 'mixed' ELSE max(acl.permission) END AS permission,
              count(*) AS doc_count,
              max(acl.created_at) AS created_at
       FROM document_acl acl
       JOIN documents d ON d.id = acl.document_id
       WHERE d.deleted_at IS NULL AND d.name LIKE $1 || '/%' AND ${documentAccess.condition('d', 2)}
         AND lower(acl.subject_id) <> lower($${2 + documentAccess.userParams(req.user, 'admin').length})
       GROUP BY acl.subject_id
       ORDER BY subject_email`,
      [folderPath, ...documentAccess.userParams(req.user, 'admin'), String(req.user.email || '').toLowerCase()]
    );
    res.json({ grants: rows.map(r => ({ ...r, doc_count: Number(r.doc_count) })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/files/folder/members — grant one person access to every file in a folder.
router.post('/folder/members', auth, requireRole('admin', 'contributor'), async (req, res) => {
  try {
    await documentAccess.ensureDocumentAclTable();
    const folderPath = safeDocName(req.body?.path, '');
    if (!folderPath) return res.status(400).json({ error: 'path required' });
    const email = documentAccess.normalizeEmail(req.body?.email);
    // Reject anything that isn't a plain address (no quotes/spaces/angle brackets) —
    // defense in depth so a crafted value can't ride into the UI or outbound mail.
    if (!/^[^\s@"'<>]+@[^\s@"'<>]+\.[^\s@"'<>]+$/.test(email)) return res.status(400).json({ error: 'Valid user email is required' });
    const permission = req.body?.permission || 'read';
    if (!documentAccess.validPermission(permission)) return res.status(400).json({ error: 'Permission must be read, write, or admin' });
    // Only files the caller administers; skip the folder marker.
    const rows = await db.query(
      `INSERT INTO document_acl (document_id, subject_type, subject_id, subject_email, permission, granted_by, granted_by_email)
       SELECT d.id, 'user', $2, $2, $3, $4, $5 FROM documents d
       WHERE d.deleted_at IS NULL AND d.name LIKE $1 || '/%' AND d.name NOT LIKE '%/.keep'
         AND ${documentAccess.condition('d', 6)}
       ON CONFLICT (document_id, subject_type, subject_id)
       DO UPDATE SET permission = EXCLUDED.permission, subject_email = EXCLUDED.subject_email,
                     granted_by = EXCLUDED.granted_by, granted_by_email = EXCLUDED.granted_by_email
       RETURNING document_id`,
      [folderPath, email, permission, req.user.id, String(req.user.email || '').toLowerCase(), ...documentAccess.userParams(req.user, 'admin')]
    );
    if (!rows.length) return res.status(404).json({ error: 'No files you manage in this folder' });
    await logEvent(`folder access grant · ${folderPath} · ${email} · ${permission} (${rows.length})`, req.user.id, req.user.email);
    if (email !== String(req.user.email || '').toLowerCase()) {
      const folderName = folderPath.split('/').pop();
      try {
        await notifications.create({
          userEmail: email,
          type: 'share_granted',
          title: `${req.user.email} shared a folder with you`,
          body: `"${folderName}" · ${rows.length} file${rows.length === 1 ? '' : 's'} · ${permission} access`,
        });
      } catch (e) { console.error('notification (folder share_granted) failed:', e.message); }
      emailEvents.send('share_granted', {
        to: email,
        subject: `${req.user.email} shared a folder with you`,
        text: `${req.user.email} gave you ${permission} access to the folder "${folderPath}" (${rows.length} files) in Memex.\n\nSign in to Memex to open it.`,
      }).catch(() => {});
    }
    res.json({ ok: true, count: rows.length, permission });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/files/folder/members — revoke a person's access across a folder.
router.delete('/folder/members', auth, requireRole('admin', 'contributor'), async (req, res) => {
  try {
    await documentAccess.ensureDocumentAclTable();
    const folderPath = safeDocName(req.body?.path, '');
    const email = documentAccess.normalizeEmail(req.body?.email);
    if (!folderPath || !email) return res.status(400).json({ error: 'path and email required' });
    if (email === String(req.user.email || '').toLowerCase()) return res.status(400).json({ error: "You can't revoke your own access" });
    const rows = await db.query(
      `DELETE FROM document_acl acl USING documents d
       WHERE acl.document_id = d.id AND acl.subject_type = 'user' AND lower(acl.subject_id) = lower($2)
         AND d.name LIKE $1 || '/%' AND ${documentAccess.condition('d', 3)}
       RETURNING acl.document_id`,
      [folderPath, email, ...documentAccess.userParams(req.user, 'admin')]
    );
    await logEvent(`folder access revoke · ${folderPath} · ${email} (${rows.length})`, req.user.id, req.user.email);
    res.json({ ok: true, count: rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/files/folder/copy — duplicate a folder's files into another library.
router.post('/folder/copy', auth, requireRole('admin', 'contributor'), async (req, res) => {
  try {
    await libraries.ensureLibraries();
    const folderPath = safeDocName(req.body?.path, '');
    if (!folderPath) return res.status(400).json({ error: 'path required' });
    const libraryId = req.body?.library_id || (await libraries.defaultLibraryId());
    if (!(await libraries.canAccessLibrary(req.user, libraryId))) return res.status(403).json({ error: 'no access to target library' });
    const docs = await db.query(
      `SELECT d.id, d.name, d.mime_type, d.size, d.storage_path FROM documents d
       WHERE d.deleted_at IS NULL AND d.name LIKE $1 || '/%' AND d.name NOT LIKE '%/.keep' AND ${documentAccess.condition('d', 2)}`,
      [folderPath, ...documentAccess.userParams(req.user, 'read')]
    );
    if (!docs.length) return res.status(404).json({ error: 'No files in this folder' });
    if (docs.length > FOLDER_COPY_MAX_FILES) return res.status(413).json({ error: `Too many files to copy at once (over ${FOLDER_COPY_MAX_FILES})` });
    for (const d of docs) {
      const sanitized = path.basename(d.name).replace(/[^a-zA-Z0-9._-]/g, '_');
      const newPath = `documents/${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${sanitized}`;
      await storage.copy(d.storage_path, newPath, d.mime_type);
      await createDocumentRecord({ displayName: d.name, storagePath: newPath, mimetype: d.mime_type, storedSize: Number(d.size) || 0, user: req.user, sourceDetail: 'copied', libraryId });
    }
    await logEvent(`folder copy · ${folderPath} → library ${libraryId} (${docs.length})`, req.user.id, req.user.email);
    res.json({ ok: true, count: docs.length });
  } catch (e) { console.error('folder copy failed:', e); res.status(500).json({ error: e.message }); }
});

// PUT /api/files/:id/content — overwrite a text file's content (md/txt/csv) and re-index
router.put('/:id/content', auth, requireRole('admin', 'contributor'), async (req, res) => {
  try {
    const doc = await documentAccess.getAccessibleDocument({ id: req.params.id, user: req.user, required: 'write', columns: DOCUMENT_COLUMNS, deleted: 'active' });
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    const ext = (doc.name.split('.').pop() || '').toLowerCase();
    if (!['md', 'txt', 'csv', 'log', 'json'].includes(ext)) return res.status(400).json({ error: 'Only text files are editable in-app' });
    const content = typeof req.body?.content === 'string' ? req.body.content : '';
    const buffer = Buffer.from(content, 'utf8');
    await storage.upload(doc.storage_path, buffer, doc.mime_type || 'text/plain');
    let documentText = null;
    try { documentText = await extractText(buffer, doc.name); } catch { /* non-fatal */ }
    await db.query('UPDATE documents SET size = $2, document_text = $3 WHERE id = $1', [doc.id, buffer.length, documentText]);
    await logDocumentEvent(doc.id, 'edited', req.user.id, req.user.email, `${buffer.length} bytes`);
    res.json({ ok: true, size: buffer.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/files/:id/restore — restore a soft-deleted document from trash
router.post('/:id/restore', auth, requireRole('admin', 'contributor'), async (req, res) => {
  try {
    const doc = await documentAccess.getAccessibleDocument({
      id: req.params.id,
      user: req.user,
      required: 'write',
      columns: DOCUMENT_COLUMNS,
      deleted: 'deleted',
    });
    if (!doc) return res.status(404).json({ error: 'Document not found in trash' });

    await db.query(
      `UPDATE documents
       SET deleted_at = NULL, deleted_by = NULL, deleted_by_email = NULL,
           restored_at = NOW(), restored_by = $2, restored_by_email = $3
       WHERE id = $1`,
      [req.params.id, req.user.id, req.user.email]
    );
    await logDocumentEvent(doc.id, 'restored', req.user.id, req.user.email, 'restored from trash');
    await logEvent(`restore · ${doc.name}`, req.user.id, req.user.email);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/files/:id/purge — permanently delete a trashed document (admin only)
router.delete('/:id/purge', auth, requireRole('admin'), async (req, res) => {
  try {
    const doc = await documentAccess.getAccessibleDocument({
      id: req.params.id,
      user: req.user,
      required: 'admin',
      columns: DOCUMENT_COLUMNS,
      deleted: 'deleted',
    });
    if (!doc) return res.status(404).json({ error: 'Document not found in trash' });

    await logDocumentEvent(doc.id, 'purged', req.user.id, req.user.email, 'permanent delete');
    await storage.del(doc.storage_path);
    await db.query('DELETE FROM documents WHERE id = $1', [req.params.id]);
    await logEvent(`purge · ${doc.name}`, req.user.id, req.user.email);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function sseHeaders(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
}

// POST /api/files/ask — ask Claude about a selected set of documents (SSE streaming)
router.post('/ask', auth, async (req, res) => {
  const { ids, question } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids required' });
  if (!question || !String(question).trim()) return res.status(400).json({ error: 'question required' });

  sseHeaders(res);
  try {
    await documentAccess.ensureDocumentAclTable();
    const docs = await db.query(
      `SELECT ${DOCUMENT_COLUMNS}, document_text FROM documents
       WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL
         AND ${documentAccess.condition('documents', 2)}`,
      [ids, ...documentAccess.userParams(req.user, 'read')]
    );
    if (!docs.length) { res.write(`data: ${JSON.stringify({ error: 'No matching documents found' })}\n\n`); return res.end(); }

    const PER_DOC = 20000;
    const TOTAL_BUDGET = 80000;
    let combined = '';
    let used = 0;
    const included = [];
    for (const doc of docs) {
      if (used >= TOTAL_BUDGET) break;
      let text = doc.document_text || '';
      if (!text || !text.trim()) {
        try {
          const buffer = await storage.download(doc.storage_path);
          text = (await extractText(buffer, doc.name)) || '';
        } catch { text = ''; }
      }
      if (!text.trim()) continue;
      const slice = text.slice(0, Math.min(PER_DOC, TOTAL_BUDGET - used));
      combined += `\n\n=== ${doc.name} ===\n${slice}`;
      used += slice.length;
      included.push(doc.name);
    }
    if (!combined.trim()) { res.write(`data: ${JSON.stringify({ error: 'Could not read text from the selected documents (they may be images or unsupported types)' })}\n\n`); return res.end(); }

    const system = `You answer questions about the SPECIFIC documents the user selected. Ground every claim in these documents and cite them by filename. If the answer is not present in them, say so plainly rather than guessing.\n\nSelected documents:\n${combined}`;
    const [ai, model] = await Promise.all([anthropic(), MODEL()]);
    const stream = ai.messages.stream({
      model,
      max_tokens: 1400,
      system,
      messages: [{ role: 'user', content: String(question) }],
    });

    for await (const chunk of await stream) {
      if (chunk.type === 'content_block_delta' && chunk.delta?.text) {
        res.write(`data: ${JSON.stringify({ text: chunk.delta.text })}\n\n`);
      }
    }

    const final = await stream.finalMessage();
    await db.query(
      'INSERT INTO api_usage (user_id, user_email, operation, model, input_tokens, output_tokens) VALUES ($1, $2, $3, $4, $5, $6)',
      [req.user.id, req.user.email, 'ask-documents', model, final.usage.input_tokens, final.usage.output_tokens]
    );
    await logEvent(`ask · ${included.length} doc${included.length === 1 ? '' : 's'} · ${String(question).slice(0, 40)}`, req.user.id, req.user.email);
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (e) {
    res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
    res.end();
  }
});

// ─── Inbound upload links (file requests) ────────────────────────────────────
// A public link that lets a non-member upload files WITHOUT an account. Uploads
// are attributed to the member who created the link and land in the link's
// destination library/folder; the creator gets an in-app notification.
let uploadLinksEnsured = false;
async function ensureUploadLinksTable() {
  if (uploadLinksEnsured) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS upload_links (
      id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      token_hash        TEXT        NOT NULL UNIQUE,
      label             TEXT,
      library_id        UUID,
      folder_path       TEXT,
      password_salt     TEXT,
      password_hash     TEXT,
      expires_at        TIMESTAMPTZ,
      revoked_at        TIMESTAMPTZ,
      created_by        UUID,
      created_by_email  TEXT,
      notify_email      BOOLEAN     NOT NULL DEFAULT TRUE,
      notify_alert      BOOLEAN     NOT NULL DEFAULT TRUE,
      upload_count      INTEGER     NOT NULL DEFAULT 0,
      last_used_at      TIMESTAMPTZ,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.query('CREATE INDEX IF NOT EXISTS upload_links_active_idx ON upload_links(token_hash) WHERE revoked_at IS NULL');
  await db.query('CREATE INDEX IF NOT EXISTS upload_links_owner_idx ON upload_links(created_by, created_at DESC)');
  await db.query('ALTER TABLE upload_links ADD COLUMN IF NOT EXISTS notify_email BOOLEAN NOT NULL DEFAULT TRUE');
  await db.query('ALTER TABLE upload_links ADD COLUMN IF NOT EXISTS notify_alert BOOLEAN NOT NULL DEFAULT TRUE');
  uploadLinksEnsured = true;
}

function normalizeFolderPath(p) {
  return String(p || '').split('/').map(s => s.trim()).filter(Boolean).join('/');
}

function uploadLinkClientShape(row, url = null) {
  return {
    id: row.id,
    label: row.label,
    library_id: row.library_id,
    folder_path: row.folder_path,
    expires_at: row.expires_at,
    revoked_at: row.revoked_at,
    created_at: row.created_at,
    created_by_email: row.created_by_email,
    upload_count: Number(row.upload_count || 0),
    last_used_at: row.last_used_at,
    has_password: !!row.password_hash,
    notify_email: row.notify_email !== false,
    notify_alert: row.notify_alert !== false,
    url,
  };
}

async function loadActiveUploadLink(token) {
  await ensureUploadLinksTable();
  const row = await db.queryOne('SELECT * FROM upload_links WHERE token_hash = $1', [tokenHash(token)]);
  if (!row || row.revoked_at) return { error: 'notfound' };
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return { error: 'expired' };
  return { row };
}

// POST /api/files/upload-links — create a file-request link (member-facing).
router.post('/upload-links', auth, requireRole('admin', 'contributor'), async (req, res) => {
  await ensureUploadLinksTable();
  try {
    const token = crypto.randomBytes(32).toString('hex');
    const { salt, hash } = passwordParts(req.body?.password);
    const expiresAt = req.body?.expiresAt ? new Date(req.body.expiresAt) : null;
    if (expiresAt && isNaN(expiresAt.getTime())) return res.status(400).json({ error: 'Invalid expiry date' });
    const libraryId = req.body?.libraryId || (await libraries.defaultLibraryId());
    const folderPath = normalizeFolderPath(req.body?.folderPath) || null;
    const label = (req.body?.label || '').toString().slice(0, 200) || null;
    const notifyEmail = req.body?.notifyEmail !== false; // default on
    const notifyAlert = req.body?.notifyAlert !== false; // default on
    const row = await db.queryOne(
      `INSERT INTO upload_links (token_hash, label, library_id, folder_path, password_salt, password_hash, expires_at, created_by, created_by_email, notify_email, notify_alert)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [tokenHash(token), label, libraryId, folderPath, salt, hash, expiresAt, req.user.id, String(req.user.email || '').toLowerCase(), notifyEmail, notifyAlert]
    );
    const url = `${await publicAppBase(req)}/u/${token}`;
    await logEvent(`upload link create · ${label || 'file request'}`, req.user.id, req.user.email);
    res.json({ link: uploadLinkClientShape(row, url) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/files/upload-links — list my active links (admins see all).
router.get('/upload-links', auth, requireRole('admin', 'contributor'), async (req, res) => {
  await ensureUploadLinksTable();
  try {
    const rows = await db.query(
      `SELECT * FROM upload_links
       WHERE revoked_at IS NULL AND (created_by = $1 OR $2 = 'admin')
       ORDER BY created_at DESC`,
      [req.user.id, req.user.role || '']
    );
    res.json({ links: rows.map(r => uploadLinkClientShape(r)) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/files/upload-links/:id — revoke.
router.delete('/upload-links/:id', auth, requireRole('admin', 'contributor'), async (req, res) => {
  await ensureUploadLinksTable();
  try {
    const row = await db.queryOne(
      `UPDATE upload_links SET revoked_at = NOW()
       WHERE id = $1 AND revoked_at IS NULL AND (created_by = $2 OR $3 = 'admin') RETURNING id`,
      [req.params.id, req.user.id, req.user.role || '']
    );
    if (!row) return res.status(404).json({ error: 'Upload link not found' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/files/upload-link/:token/info — public: describe the link for the page.
router.get('/upload-link/:token/info', async (req, res) => {
  try {
    const { row, error } = await loadActiveUploadLink(req.params.token);
    if (error) return res.status(error === 'expired' ? 410 : 404).json({ error });
    res.json({ label: row.label || null, needsPassword: !!row.password_hash });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/files/upload-link/:token — public: accept an upload (no account).
router.post('/upload-link/:token', (req, res, next) => getUpload().then(mw => mw(req, res, next)).catch(next), async (req, res) => {
  try {
    const { row, error } = await loadActiveUploadLink(req.params.token);
    if (error) return res.status(error === 'expired' ? 410 : 404).json({ error });
    if (!verifySharePassword(req.body?.password || req.headers['x-upload-password'], row.password_salt, row.password_hash)) {
      return res.status(401).json({ error: 'Upload password required' });
    }
    if (!req.file) return res.status(400).json({ error: 'file required' });
    const path = require('path');
    const { buffer, originalname, mimetype, size } = req.file;
    const base = cleanDisplayName(originalname) || 'upload';
    // Folder uploads send each file's webkitRelativePath so the tree is preserved
    // under the destination folder. Drop traversal segments; keep the structure.
    const rel = String(req.body?.relativePath || '').split('/').map(s => s.trim())
      .filter(s => s && s !== '.' && s !== '..').join('/');
    const nested = rel || base;
    const displayName = row.folder_path ? `${row.folder_path}/${nested}` : nested;
    const sanitizedName = path.basename(base).replace(/[^a-zA-Z0-9._-]/g, '_');
    const storagePath = `documents/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${sanitizedName}`;
    await storage.upload(storagePath, buffer, mimetype);
    const owner = { id: row.created_by, email: row.created_by_email };
    const uploaderName = (req.body?.uploaderName || '').toString().slice(0, 120).trim();
    const { doc } = await createDocumentRecord({
      displayName, storagePath, mimetype, storedSize: size, user: owner,
      sourceDetail: `via upload link${uploaderName ? ` · from ${uploaderName}` : ''}`,
      libraryId: row.library_id,
    });
    await db.query('UPDATE upload_links SET upload_count = upload_count + 1, last_used_at = NOW() WHERE id = $1', [row.id]);
    // In-app alert (per-link opt-out).
    if (row.notify_alert !== false && row.created_by_email) {
      try {
        await notifications.create({
          userId: row.created_by,
          userEmail: row.created_by_email,
          type: 'upload_received',
          title: uploaderName ? `${uploaderName} uploaded a file` : 'New file uploaded',
          body: `"${base}"${row.label ? ` · ${row.label}` : ''}`,
          refType: 'document',
          refId: doc.id,
        });
      } catch (e) { console.error('notification (upload_received) failed:', e.message); }
    }
    // Email alert — gated by BOTH the per-link opt-out and the admin's global
    // upload-received toggle. Best-effort; no-op when email isn't configured.
    if (row.notify_email !== false && row.created_by_email) {
      const who = uploaderName || 'Someone';
      emailEvents.send('upload_received', {
        to: row.created_by_email,
        subject: `New upload${row.label ? ` · ${row.label}` : ''}: ${base}`,
        text: `${who} uploaded "${base}" via your Memex upload link${row.label ? ` (${row.label})` : ''}.\n\nSign in to Memex to view it.`,
      }).catch(() => {});
    }
    res.json({ ok: true, name: base });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
// Exposed for unit testing.
module.exports.publicAppBase = publicAppBase;
module.exports.uploadLinkClientShape = uploadLinkClientShape;
module.exports.normalizeFolderPath = normalizeFolderPath;
module.exports.discoveryUrlSrc = discoveryUrlSrc;
module.exports.collaboraEditUrl = collaboraEditUrl;
module.exports.createDocumentRecord = createDocumentRecord; // reused by the Seafile migration
module.exports.writeChunk = writeChunk;
module.exports.chunkedFileStream = chunkedFileStream;

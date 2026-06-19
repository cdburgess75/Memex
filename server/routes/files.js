'use strict';
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const multer = require('multer');
const Anthropic = require('@anthropic-ai/sdk');
const { generateToken } = require('../lib/wopiTokens');
const storage = require('../lib/storage');
const db = require('../lib/db');
const settings = require('../lib/settings');
const documentAccess = require('../lib/documentAccess');
const libraries = require('../lib/libraries');
const { extractText } = require('../lib/textExtraction');
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

const ALLOWED_FILE_EXTS = ['.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt', '.pdf', '.txt', '.md', '.csv'];
const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024;
const MAX_CHUNK_SIZE = 64 * 1024 * 1024;
let uploadSessionsEnsured = false;
let shareLinksEnsured = false;

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
  return ALLOWED_FILE_EXTS.includes(fileExt(name));
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
  const mb = parseInt(await settings.getOrEnv('max_upload_mb') || '50', 10);
  return Number.isFinite(mb) && mb > 0 ? mb : 50;
}

let _uploadMb = 0;
let _uploadMw = null;
async function getUpload() {
  const mb = await maxUploadMb();
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

function buildContext(pages) {
  return (pages || [])
    .filter(p => p.id !== 'overview')
    .map(p => `### [[${p.title}]]  (${p.category})\n${p.content}`)
    .join('\n\n---\n\n');
}

async function logEvent(event, userId, userEmail) {
  await db.query(
    'INSERT INTO activity_log (event, user_id, user_email) VALUES ($1, $2, $3)',
    [event, userId, userEmail]
  );
}

async function logDocumentEvent(documentId, eventType, userId, userEmail, detail = null) {
  await db.query(
    'INSERT INTO document_events (document_id, event_type, actor_id, actor_email, detail) VALUES ($1, $2, $3, $4, $5)',
    [documentId, eventType, userId, userEmail, detail]
  );
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
  if (configured) return configured;
  return `${req.protocol}://${req.get('host')}`;
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

async function chunkDir(sessionId) {
  return path.join(await chunkRoot(), String(sessionId));
}

async function writeChunk(sessionId, index, readable) {
  const dir = await chunkDir(sessionId);
  await fs.mkdir(dir, { recursive: true });
  const finalPath = path.join(dir, `${index}.part`);
  const tmpPath = `${finalPath}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  let bytes = 0;
  await new Promise((resolve, reject) => {
    const out = fsSync.createWriteStream(tmpPath);
    readable.on('data', chunk => { bytes += chunk.length; });
    readable.on('error', reject);
    out.on('error', reject);
    out.on('finish', resolve);
    readable.pipe(out);
  });
  await fs.rename(tmpPath, finalPath);
  return bytes;
}

async function removeUploadSessionFiles(sessionId) {
  await fs.rm(await chunkDir(sessionId), { recursive: true, force: true }).catch(() => {});
}

async function chunkedFileStream(session) {
  return Readable.from((async function* () {
    for (let i = 0; i < Number(session.total_chunks || 0); i += 1) {
      const stream = fsSync.createReadStream(path.join(await chunkDir(session.id), `${i}.part`));
      for await (const chunk of stream) yield chunk;
    }
  })());
}

async function createDocumentRecord({ displayName, storagePath, mimetype, storedSize, user, sourceDetail, libraryId }) {
  let canIngest = false;
  let documentText = null;
  const extractionLimit = (await maxUploadMb()) * 1024 * 1024;
  if (storedSize > 0 && storedSize <= extractionLimit) {
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
    [displayName, storedSize || 0, mimetype, storagePath, user.id, user.email, documentText, libraryId || (await libraries.defaultLibraryId())]
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

  let buffer;
  try {
    buffer = await storage.download(entry.storagePath);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  const path = require('path');
  res.setHeader('Content-Disposition', `attachment; filename="${path.basename(entry.storagePath)}"`);
  res.send(buffer);
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

    const buffer = await storage.download(share.storage_path);
    await db.query(
      'UPDATE document_share_links SET last_accessed_at = NOW(), access_count = access_count + 1 WHERE id = $1',
      [share.id]
    );
    await logDocumentEvent(share.document_id, 'share_downloaded', null, null, `public share link · ${requestAuditDetail(req)}`);
    await logEvent(`share download · ${share.name}`, null, null);
    res.setHeader('Content-Type', share.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(share.name)}"`);
    res.send(buffer);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/files
router.get('/', auth, async (req, res) => {
  try {
    await documentAccess.ensureDocumentAclTable();
    await libraries.ensureLibraries();
    const libParam = req.query.library || null;
    const rows = await db.query(
      `SELECT ${DOCUMENT_COLUMNS}
       FROM documents d
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

  let storedSize = declaredSize;
  try {
    const result = await storage.uploadStream(storagePath, req, mimetype);
    if (result && Number.isFinite(result.size) && result.size >= 0) storedSize = result.size;
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  try {
    let canIngest = false;
    let documentText = null;
    const extractionLimit = (await maxUploadMb()) * 1024 * 1024;
    if (storedSize > 0 && storedSize <= extractionLimit) {
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
  if (!Number.isFinite(size) || size < 0) return res.status(400).json({ error: 'Valid file size required' });

  const mimetype = String(req.body.mimeType || 'application/octet-stream').split(';')[0] || 'application/octet-stream';
  const chunkSize = clampChunkSize(req.body.chunkSize);
  const totalChunks = Math.max(1, Math.ceil(size / chunkSize));
  const sanitizedName = path.basename(displayName).replace(/[^a-zA-Z0-9._-]/g, '_');
  const storagePath = `documents/${Date.now()}-${sanitizedName}`;

  try {
    if (!(await storage.isLocalProvider())) {
      return res.status(400).json({ error: 'Resumable chunk uploads currently require local storage' });
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

    const bytes = await writeChunk(session.id, index, req);
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
    await logDocumentEvent(req.params.id, 'share_revoked', req.user.id, req.user.email, `share ${req.params.shareId}`);
    await logEvent(`share revoke · ${req.params.id}`, req.user.id, req.user.email);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/files/:id/ingest
router.post('/:id/ingest', auth, requireRole('admin', 'contributor'), async (req, res) => {
  const { focus } = req.body;

  try {
    const doc = await documentAccess.getAccessibleDocument({
      id: req.params.id,
      user: req.user,
      required: 'read',
      columns: `${DOCUMENT_COLUMNS}, d.document_text`,
      deleted: 'active',
    });
    if (!doc) return res.status(404).json({ error: 'Document not found' });

    let buffer;
    try {
      buffer = await storage.download(doc.storage_path);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }

    let text;
    try {
      text = doc.document_text || await extractText(buffer, doc.name);
    } catch (e) {
      return res.status(422).json({ error: `Text extraction failed: ${e.message}` });
    }

    if (!text || !text.trim()) {
      return res.status(422).json({ error: 'Could not extract text from this file' });
    }

    const pages = await db.query('SELECT * FROM pages');
    const ctx = buildContext(pages);

    const system = `You maintain a team knowledge base. Ingest the source the user provides.

Existing pages:
${ctx || '(empty — this is the first source)'}

Return ONLY valid JSON, no markdown fences, in this shape:
{"summary":"2-3 sentence summary","pages":[{"id":"kebab-slug","title":"Page Title","category":"concept|entity|source|analysis","content":"# Page Title\\n\\nMarkdown body. Use [[Page Title]] to link related pages. Use ## for subheads and - for bullets."}]}

Create or update 2-4 pages. Prefer updating an existing page (reuse its exact id) when the source adds to it. Always include one "source" page summarizing this document. Cross-link generously with [[page links]].${focus ? '\nUser emphasis: ' + focus : ''}`;

    const [ai, model] = await Promise.all([anthropic(), MODEL()]);
    const message = await ai.messages.create({
      model,
      max_tokens: 1400,
      system,
      messages: [{ role: 'user', content: 'Source:\n\n' + text.slice(0, 8000) }],
    });

    await db.query(
      'INSERT INTO api_usage (user_id, user_email, operation, model, input_tokens, output_tokens) VALUES ($1, $2, $3, $4, $5, $6)',
      [req.user.id, req.user.email, 'ingest', model, message.usage.input_tokens, message.usage.output_tokens]
    );

    const raw = message.content.map(b => b.text || '').join('');
    let parsed;
    try {
      parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    } catch {
      return res.status(422).json({ error: 'Claude returned invalid JSON — try again' });
    }

    const touched = [];
    for (const p of (parsed.pages || [])) {
      const existing = await db.queryOne('SELECT id, sources FROM pages WHERE id = $1', [p.id]);
      let row;
      if (existing) {
        row = await db.queryOne(
          `UPDATE pages SET title = $1, category = $2, content = $3, sources = $4,
           updated_at = $5, updated_by = $6 WHERE id = $7 RETURNING *`,
          [p.title, p.category, p.content, (existing.sources || 0) + 1, new Date().toISOString(), req.user.id, p.id]
        );
      } else {
        row = await db.queryOne(
          `INSERT INTO pages (id, title, category, content, sources, created_by, updated_by)
           VALUES ($1, $2, $3, $4, 1, $5, $6) RETURNING *`,
          [p.id, p.title, p.category, p.content, req.user.id, req.user.id]
        );
      }
      if (row) touched.push(row);
    }

    await logEvent(`ingest · ${touched.length} pages · ${parsed.pages?.[0]?.title || doc.name}`, req.user.id, req.user.email);
    res.json({ summary: parsed.summary, pages: touched });
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

    let editUrl = null;
    const appUrl = process.env.APP_URL;
    if (appUrl) {
      const wopiApps = {
        docx: 'https://word-edit.officeapps.live.com/op/edit.aspx',
        doc:  'https://word-edit.officeapps.live.com/op/edit.aspx',
        xlsx: 'https://excel.officeapps.live.com/op/edit.aspx',
        xls:  'https://excel.officeapps.live.com/op/edit.aspx',
        pptx: 'https://powerpoint.officeapps.live.com/op/edit.aspx',
        ppt:  'https://powerpoint.officeapps.live.com/op/edit.aspx',
      };
      const wopiApp = wopiApps[ext];
      if (wopiApp) {
        const token = generateToken(doc.id, req.user.id, req.user.email);
        const wopiSrc = encodeURIComponent(`${appUrl}/wopi/files/${doc.id}`);
        editUrl = `${wopiApp}?WOPISrc=${wopiSrc}&access_token=${token}`;
      }
    }

    await logEvent(`view · ${doc.name}`, req.user.id, req.user.email);
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
    let name = String(req.body?.name || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').trim();
    if (!name) return res.status(400).json({ error: 'name required' });
    if (name.split('/').some(seg => seg === '..' || seg === '.')) return res.status(400).json({ error: 'invalid name' });
    name = name.slice(0, 400);
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
       ORDER BY r.opened_at DESC LIMIT 8`,
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

module.exports = router;

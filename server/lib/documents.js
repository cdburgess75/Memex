'use strict';
// Core document-creation service shared across every upload path (staff upload,
// chunked/streamed upload, public upload-link, folder copy, blank-doc create) and
// the admin Seafile migration. Extracted from routes/files.js (ST-1) so the file
// sub-routers share one insert/dedupe/index/notify pipeline. Also home to the
// canonical document column list and the traversal-safe name helper.
const crypto = require('crypto');
const db = require('./db');
const storage = require('./storage');
const libraries = require('./libraries');
const documentAccess = require('./documentAccess');
const { extractText } = require('./textExtraction');
const { logEvent, logDocumentEvent } = require('./fileEvents');

const DOCUMENT_COLUMNS = `
  id, name, size, mime_type, storage_path, google_drive_id, uploaded_by,
  uploaded_by_email, created_at, deleted_at, deleted_by, deleted_by_email,
  restored_at, restored_by, restored_by_email
`;

// Text extraction downloads the whole file into memory, so its size gate is capped
// independently of max_upload_mb — a multi-GB file must never be buffered to index it.
const TEXT_EXTRACTION_MAX_BYTES = 25 * 1024 * 1024;

function fileSizeLabelForEvent(size) {
  const n = Number(size || 0);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) { value /= 1024; idx += 1; }
  return `${value >= 10 || idx === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[idx]}`;
}

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

function recordUploadNotify(user, displayName, libraryId) {
  try {
    const full = String(displayName || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const parts = full.split('/').filter(Boolean);
    const base = parts.pop() || 'file';
    // Bucket by the TOP folder (or the library root), so dropping one folder —
    // however deep — collapses to a single "uploaded a folder (N files)" summary
    // rather than one per subfolder.
    const topFolder = parts.length ? parts[0] : null;
    require('./uploadNotify').record({
      libraryId: libraryId || null, folderPath: topFolder || '',
      uploaderEmail: user.email, uploaderName: user.name,
      fileName: base, folderName: topFolder,
    });
  } catch (e) { console.error('uploadNotify record:', e.message); }
}

async function createDocumentRecord({ displayName, storagePath, mimetype, storedSize, user, sourceDetail, libraryId, notifyUpload = false }) {
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
  // Notify the library owner + folder followers (summary-batched), on real user
  // uploads only — not copies/migrations, which pass notifyUpload:false.
  if (notifyUpload) recordUploadNotify(user, displayName, lib);
  return { doc, canIngest };
}

module.exports = {
  DOCUMENT_COLUMNS,
  TEXT_EXTRACTION_MAX_BYTES,
  fileSizeLabelForEvent,
  safeDocName,
  recordUploadNotify,
  createDocumentRecord,
};

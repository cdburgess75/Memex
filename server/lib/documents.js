'use strict';
// Core document-creation service shared across every upload path (staff upload,
// chunked/streamed upload, public upload-link, folder copy, blank-doc create) and
// the folder sub-router. Extracted from routes/files.js (ST-1) so the file
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
  id, name, size, mime_type, storage_path, uploaded_by,
  uploaded_by_email, created_at, deleted_at, deleted_by, deleted_by_email,
  restored_at, restored_by, restored_by_email, library_id
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

// Folder paths are matched exactly against stored names, never rewritten: a folder
// created by an outside upload can be called "Tax & Co" or "Cafe" with an accent, and
// rewriting that on the way in would miss it. Only the separators are tidied
// (backslashes become '/', repeated slashes collapse, slashes at either end go).
//
// folderLookupPath -- the path of an EXISTING folder, for finding it. It refuses only
//   what no stored name can contain: a '.' or '..' segment, a C0 control character, or
//   more than 1000 characters. Anything an upload could have stored stays reachable,
//   so a folder with an odd name can at least be renamed.
// canonicalFolderPath -- the stricter shape a folder must have to be SHARED; it is the
//   key of library_grants.folder_path, whose CHECK (migration 0007) spells out the
//   same rules. On top of the above: no control character at all (C1 and DEL too), no
//   segment that starts or ends in whitespace (names are trimmed when stored), and at
//   most 400 characters / 1024 bytes.
const FOLDER_LOOKUP_MAX_CHARS = 1000;
const FOLDER_PATH_MAX_CHARS = 400;
const FOLDER_PATH_MAX_BYTES = 1024;
function tidyFolderPath(raw) {
  return typeof raw === 'string' ? raw.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\/+|\/+$/g, '') : '';
}
function folderLookupPath(raw) {
  const path = tidyFolderPath(raw);
  if (!path || /[\x00-\x1f]/.test(path) || Array.from(path).length > FOLDER_LOOKUP_MAX_CHARS) return null;
  if (path.split('/').some(seg => seg === '.' || seg === '..')) return null;
  return path;
}
function canonicalFolderPath(raw) {
  const path = folderLookupPath(raw);
  if (!path || /\p{Cc}/u.test(path)) return null;
  if (Array.from(path).length > FOLDER_PATH_MAX_CHARS || Buffer.byteLength(path, 'utf8') > FOLDER_PATH_MAX_BYTES) return null;
  if (path.split('/').some(seg => /^\s|\s$/u.test(seg))) return null;
  return path;
}

// Where something moved or renamed INTO a folder path lands. The longest leading part
// of the path that is already a folder the caller can see in this library is kept
// exactly as stored; only the rest -- folders this move brings into being -- is cleaned
// the way any new folder name is (safeDocName). So a folder dropped on
// "Smith & Co (2025)" lands inside it rather than beside it in a rewritten
// "Smith _ Co _2025_", and a file and a folder moved together into a new "R&D" both
// land in the same "R_D". Returns '' for the root, or null for a path that can't name
// a folder (a '..' segment, nothing left once cleaned).
async function destinationFolder(raw, libraryId, user) {
  const segs = tidyFolderPath(raw).split('/').map(seg => seg.trim()).filter(Boolean);
  if (!segs.length) return '';
  const prefixes = [];
  for (let n = segs.length; n >= 1; n--) {
    const prefix = folderLookupPath(segs.slice(0, n).join('/'));
    if (prefix) prefixes.push(prefix);
  }
  let keep = 0;
  if (prefixes.length) {
    const found = await db.queryOne(
      `SELECT p FROM unnest($1::text[]) AS p
       WHERE EXISTS (SELECT 1 FROM documents d
                     WHERE d.deleted_at IS NULL AND d.library_id = $2 AND starts_with(d.name, p || '/')
                       AND ${documentAccess.condition('d', 3)})
       ORDER BY char_length(p) DESC LIMIT 1`,
      [prefixes, libraryId, ...documentAccess.userParams(user, 'read')]
    );
    if (found) keep = found.p.split('/').length;
  }
  const kept = segs.slice(0, keep).join('/');
  if (keep === segs.length) return kept;
  const made = safeDocName(segs.slice(keep).join('/'), '');
  if (!made) return null;
  return kept ? `${kept}/${made}` : made;
}

function recordUploadNotify(user, displayName, libraryId, documentId = null) {
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
      fileName: base, folderName: topFolder, documentId,
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
  // that this user could EDIT — returns the existing document instead of creating a
  // duplicate. Edit, not merely read: absorbing an upload into a document is a change
  // to that document, and at read level one person's upload could land as someone
  // else's file, owned by them, in a place the uploader can only look at. Conservative by design: a changed file has a different hash and is never
  // skipped, so nothing is ever silently dropped. Only computed for files up to the
  // text-extraction size, where we already have the bytes in hand (no extra read).
  if (contentHash) {
    const existing = await db.queryOne(
      `SELECT ${DOCUMENT_COLUMNS} FROM documents d
       WHERE d.deleted_at IS NULL AND d.content_hash = $1 AND d.name = $2 AND d.library_id = $3
         AND ${documentAccess.condition('d', 4)}
       LIMIT 1`,
      [contentHash, displayName, lib, ...documentAccess.userParams(user, 'write')]
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
  if (notifyUpload) recordUploadNotify(user, displayName, lib, doc.id);
  return { doc, canIngest };
}

module.exports = {
  DOCUMENT_COLUMNS,
  TEXT_EXTRACTION_MAX_BYTES,
  fileSizeLabelForEvent,
  safeDocName,
  canonicalFolderPath,
  folderLookupPath,
  destinationFolder,
  recordUploadNotify,
  createDocumentRecord,
};

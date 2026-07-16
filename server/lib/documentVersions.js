'use strict';
// Bounded version history. Every replace / Office save / export appends a full copy
// of the file as a new document_versions row + blob; without a cap this grows without
// limit. saveDocumentVersion lives in both routes/files.js and routes/wopi.js, so the
// pruning shared by both lives here.
const db = require('./db');
const storage = require('./storage');
const settings = require('./settings');

// Newest N versions to keep. 0 = unlimited. Default 25.
async function maxDocumentVersions() {
  const n = parseInt((await settings.getOrEnv('max_document_versions')) || '25', 10);
  return Number.isFinite(n) && n >= 0 ? n : 25;
}

// Delete version rows beyond the newest N for a document, removing each version's blob
// too (a plain document delete CASCADEs the rows but would orphan the objects on disk).
async function pruneOldVersions(documentId) {
  const max = await maxDocumentVersions();
  if (!max) return { deleted: 0 };
  let old = [];
  try {
    old = await db.query(
      'SELECT id, storage_path FROM document_versions WHERE document_id = $1 ORDER BY version_number DESC OFFSET $2',
      [documentId, max]
    );
  } catch { return { deleted: 0 }; }
  let deleted = 0;
  for (const v of old) {
    if (v.storage_path) await storage.del(v.storage_path).catch(() => {});
    try { await db.query('DELETE FROM document_versions WHERE id = $1', [v.id]); deleted += 1; } catch { /* keep going */ }
  }
  return { deleted };
}

module.exports = { maxDocumentVersions, pruneOldVersions };

'use strict';
// Saving a text file from the built-in editor (routes/files.js: GET /:id/text, PUT /:id/content).
//
// A REVISION is the sha256 of the file's bytes. The editor is handed one when it loads the
// file and sends it back with each save, so a save made over a file that changed elsewhere
// meanwhile (another tab, another person, a restored version, a fresh upload) is refused
// rather than silently winning. It is computed from the bytes, so every path that changes
// them is covered without a column to keep in step.
//
// A SITTING is one person editing one file with no gap longer than SITTING_MS between their
// recorded edits. Autosave saves every few seconds, so the first save of a sitting is the one
// that keeps the previous content as a version and makes the one "edited" entry in the
// activity log (and tells the file's owner and followers); later saves in the sitting do
// none of that.
const crypto = require('crypto');
const db = require('./db');

const SITTING_MS = 10 * 60 * 1000;
// Beyond this the editor shows the first part only, read-only, so a save never throws the
// rest away. Characters, as the page counts them.
const MAX_CHARS = 500000;

const revisionOf = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 24);

// When this person last made a recorded edit of this file; null if never.
async function lastEditAt(documentId, userId) {
  const row = await db.queryOne(
    `SELECT created_at FROM document_events
      WHERE document_id = $1 AND actor_id = $2 AND event_type = 'edited'
      ORDER BY created_at DESC LIMIT 1`,
    [documentId, userId]
  );
  return row ? new Date(row.created_at) : null;
}

async function startsSitting(documentId, userId, now = Date.now()) {
  const last = await lastEditAt(documentId, userId);
  return !last || now - last.getTime() > SITTING_MS;
}

module.exports = { SITTING_MS, MAX_CHARS, revisionOf, lastEditAt, startsSitting };

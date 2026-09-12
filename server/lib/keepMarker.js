'use strict';
// A share must never sit on a folder with nothing in it. A folder is only a name prefix,
// so an empty shared name is a trap: the next folder to take that name would be shared
// with whoever the old share named, without anyone deciding it.
//
// So when the last live document leaves a shared folder -- trashed, renamed out, moved to
// another library -- the folder is kept: a hidden, library-owned '.keep' marker is planted
// at that path. The folder stays, empty and still shared, which is what Seafile does too.
// The marker grants nothing: it has no uploader, and it is library content, so only the
// library's owner, its shares and admins reach it, exactly as the folder's other files.
const crypto = require('crypto');
const { prefixRange } = require('./documents');

// Call ONCE per request, after the writes that removed the documents, with the names
// those documents had. Returns the markers planted, for the caller to upload the (empty)
// objects for AFTER the transaction commits.
async function keepSharedFoldersAlive(q, libraryId, names) {
  const list = [...new Set((names || []).filter(Boolean).map(String))];
  if (!libraryId || !list.length) return [];
  // Lock the covering share rows first: without that, two "last file" removals can each
  // see the other's file as still live and neither plants anything. No DISTINCT (Postgres
  // refuses FOR UPDATE with it), and two people sharing one path are two rows: hold both.
  const rows = await q.query(
    `SELECT g.id, g.folder_path FROM library_grants g
      WHERE g.id IN (SELECT g2.id FROM library_grants g2, unnest($2::text[]) AS n
                      WHERE g2.library_id = $1 AND g2.folder_path <> ''
                        AND starts_with(n, g2.folder_path || '/'))
      ORDER BY g.folder_path, g.id
      FOR UPDATE`,
    [libraryId, list]
  );
  const planted = [];
  for (const folderPath of [...new Set(rows.map(r => r.folder_path))]) {
    const storagePath = `documents/${crypto.randomUUID()}-keep`;
    const made = await q.query(
      `INSERT INTO documents (name, size, mime_type, storage_path, uploaded_by,
                              uploaded_by_email, library_id, library_scoped)
       SELECT $2 || '/.keep', 0, 'application/octet-stream', $3, NULL, NULL, $1, true
        WHERE NOT EXISTS (SELECT 1 FROM documents d
                           WHERE d.library_id = $1 AND d.deleted_at IS NULL
                             AND ${prefixRange('d', '$2')})
       RETURNING id`,
      [libraryId, folderPath, storagePath]
    );
    if (made.length) planted.push({ path: folderPath, id: made[0].id, storagePath });
  }
  return planted;
}

module.exports = { keepSharedFoldersAlive };

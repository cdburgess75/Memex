#!/usr/bin/env node
'use strict';
// The one-off repair for shares that were already pointing at nothing.
//
// A folder is only a name prefix, so a share on a path with no files under it is a trap:
// the next folder to take that name is shared with whoever the old share named, without
// anyone deciding it. Every route that can empty a folder now keeps it alive with a
// hidden, library-owned '.keep' marker (server/lib/keepMarker.js) -- but shares made
// before that existed can already be sitting on an empty name.
//
// This finds them and does one of two things:
//
//   default   plant a '.keep', so the folder exists and the share goes on meaning what
//             it meant. Nobody gains or loses access: a marker has no uploader and is
//             library content, so exactly the people the share already named can see it.
//   --retire  end the share instead, recorded in library_grants_ended, for a box where
//             the empty ones are known to be stale.
//
//   docker compose exec -T app node scripts/piece4-keep-shared-folders.js            # dry run
//   docker compose exec -T app node scripts/piece4-keep-shared-folders.js --apply
//   docker compose exec -T app node scripts/piece4-keep-shared-folders.js --apply --retire
//
// The table it prints is written to the audit log either way -- including a dry run --
// so there is a permanent record of which outside addresses this kept alive, taken at
// the moment somebody looked.
const crypto = require('crypto');

const db = require('../server/lib/db');
const auditLog = require('../server/lib/auditLog');
const folderLocks = require('../server/lib/folderLocks');

const APPLY = process.argv.includes('--apply');
const RETIRE = process.argv.includes('--retire');
const say = (line) => { if (require.main === module) console.log(line); };

// Shares whose folder holds nothing live. The same predicate the access self-check uses
// for invariant D, so what this fixes is exactly what that counts.
const DORMANT = `
  SELECT g.id, g.library_id, g.folder_path, g.subject_type, g.subject_email, g.group_id,
         g.permission, g.created_at, l.name AS library_name
    FROM library_grants g JOIN libraries l ON l.id = g.library_id
   WHERE g.folder_path <> ''
     AND NOT EXISTS (SELECT 1 FROM documents d
                      WHERE d.library_id = g.library_id AND d.deleted_at IS NULL
                        AND d.name ~>=~ (g.folder_path || '/') AND d.name ~<~ (g.folder_path || '0'))
   ORDER BY l.name, g.folder_path, g.subject_email`;

const subjectOf = (r) => (r.subject_type === 'group' ? `group ${r.group_id}` : r.subject_email);

async function run({ apply = APPLY, retire = RETIRE } = {}) {
  const rows = await db.query(DORMANT);
  say(`${rows.length} share${rows.length === 1 ? '' : 's'} on a folder with nothing in it`);
  for (const r of rows) {
    say(`  ${r.library_name} · ${r.folder_path} · ${subjectOf(r)} · ${r.permission} · made ${new Date(r.created_at).toISOString().slice(0, 10)}`);
  }
  // The record is written whether or not anything is changed: a dry run is still somebody
  // finding out which outside addresses hold a share of an empty folder.
  await auditLog.append({
    documentId: null,
    eventType: retire ? 'library_unshared' : 'folder_created',
    actorId: null,
    actorEmail: 'system@piece4-repair',
    detail: `${apply ? 'applied' : 'dry run'}${retire ? ' (retire)' : ' (keep)'} · ${rows.length} dormant share(s): `
      + rows.map(r => `${r.library_name}/${r.folder_path} → ${subjectOf(r)} (${r.permission})`).join('; '),
  }).catch((e) => say(`  (the audit record could not be written: ${e.message})`));

  if (!rows.length || !apply) {
    say(apply ? 'nothing to do' : 'dry run — nothing changed. Re-run with --apply.');
    return { found: rows.length, planted: 0, retired: 0 };
  }

  const byLibrary = new Map();
  for (const r of rows) {
    if (!byLibrary.has(String(r.library_id))) byLibrary.set(String(r.library_id), []);
    byLibrary.get(String(r.library_id)).push(r);
  }

  let planted = 0;
  let retired = 0;
  const objects = [];
  for (const [libraryId, shares] of byLibrary) {
    // One transaction per library, holding the same lock every folder operation takes, so
    // this cannot interleave with somebody renaming a folder while it runs.
    await db.withTransaction(async (client) => {
      await folderLocks.session(client, 'folder');
      await folderLocks.tree(client, [libraryId], 'exclusive');
      const paths = [...new Set(shares.map(s => s.folder_path))];
      if (retire) {
        const { rows: op } = await client.query(
          `INSERT INTO folder_ops (library_id, kind, path, actor_email)
           VALUES ($1, 'release_keep', $2, 'system@piece4-repair') RETURNING op_id`,
          [libraryId, paths[0]]
        );
        const { rows: gone } = await client.query(
          `WITH gone AS (
             DELETE FROM library_grants g
              WHERE g.library_id = $1 AND g.folder_path = ANY($2::text[])
              RETURNING g.*)
           INSERT INTO library_grants_ended
             (op_id, grant_id, library_id, folder_path, subject_type, subject_email, group_id,
              permission, granted_at, cause, ended_by_email)
           SELECT $3, gone.id, gone.library_id, gone.folder_path, gone.subject_type, gone.subject_email,
                  gone.group_id, gone.permission, gone.created_at, 'folder_purged', 'system@piece4-repair'
             FROM gone RETURNING id`,
          [libraryId, paths, op[0].op_id]
        );
        retired += gone.length;
        return;
      }
      // Every marker this plants is recorded under one folder_ops row, so the set stays
      // distinguishable forever: the Share panel shows these once, as folders that had no
      // content at release, rather than silently switching off the "this folder is empty"
      // warning across the whole install.
      const { rows: op } = await client.query(
        `INSERT INTO folder_ops (library_id, kind, path, actor_email)
         VALUES ($1, 'release_keep', $2, 'system@piece4-repair') RETURNING op_id`,
        [libraryId, paths[0]]
      );
      for (const folderPath of paths) {
        const storagePath = `documents/${crypto.randomUUID()}-keep`;
        const { rows: made } = await client.query(
          `INSERT INTO documents (name, size, mime_type, storage_path, uploaded_by,
                                  uploaded_by_email, library_id, library_scoped)
           SELECT $2 || '/.keep', 0, 'application/octet-stream', $3, NULL, NULL, $1, true
            WHERE NOT EXISTS (SELECT 1 FROM documents d
                               WHERE d.library_id = $1 AND d.deleted_at IS NULL
                                 AND d.name ~>=~ ($2 || '/') AND d.name ~<~ ($2 || '0'))
           RETURNING id`,
          [libraryId, folderPath, storagePath]
        );
        if (made.length) {
          planted += 1;
          objects.push(storagePath);
          await client.query('INSERT INTO folder_op_documents (op_id, document_id) VALUES ($1, $2)', [op[0].op_id, made[0].id]);
        }
      }
    });
  }

  // The empty objects, after the rows are committed: a marker whose object is missing is
  // a download that fails, not a share that leaks.
  if (objects.length) {
    const storage = require('../server/lib/storage');
    for (const objectPath of objects) await storage.upload(objectPath, Buffer.alloc(0), 'application/octet-stream').catch(() => {});
  }
  say(retire ? `retired ${retired} share(s)` : `planted ${planted} marker(s)`);
  return { found: rows.length, planted, retired };
}

module.exports = { run, DORMANT };

if (require.main === module) {
  run()
    .then(async () => { await db.end(); process.exit(0); })
    .catch(async (e) => { console.log(`PIECE 4 REPAIR ERROR ${e.message}`); try { await db.end(); } catch { /* closed */ } process.exit(2); });
}

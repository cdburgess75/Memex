'use strict';
// Folders found by name, across every library the caller can read. Folders are not rows:
// they are the directories of the files a person can see (and of the .keep markers that
// keep an emptied shared folder alive), exactly as the rail's folder index derives them
// (routes/files.js GET /folders), so a folder a person cannot see into is never found.
// Matching is on the folder's own name (its last segment), case-insensitively.
const db = require('./db');
const documentAccess = require('./documentAccess');

const escapeLike = (s) => String(s).replace(/[\\%_]/g, (c) => '\\' + c);

async function searchFolders(user, q, { limit = 50 } = {}) {
  const needle = String(q || '').trim();
  if (!needle) return [];
  const p = documentAccess.userParams(user, 'read');
  const rows = await db.query(
    `WITH v AS MATERIALIZED (
       SELECT d.library_id, btrim(d.name, '/') AS name FROM documents d
        WHERE d.deleted_at IS NULL AND ${documentAccess.condition('d', 1)}
          AND strpos(btrim(d.name, '/'), '/') > 0
     ), dirs AS (
       SELECT library_id, regexp_replace(name, '/[^/]*$', '') AS dir,
              count(*) FILTER (WHERE name !~ '(^|/)\\.keep$')::int AS n
         FROM v GROUP BY 1, 2
     ), every AS (
       SELECT library_id, array_to_string(parts[1:i], '/') AS path, sum(n)::int AS count
         FROM (SELECT library_id, string_to_array(dir, '/') AS parts, n FROM dirs) s,
              generate_series(1, array_length(parts, 1)) i
        GROUP BY 1, 2
     )
     SELECT e.library_id, l.name AS library_name, e.path, e.count
       FROM every e LEFT JOIN libraries l ON l.id = e.library_id
      WHERE regexp_replace(e.path, '^.*/', '') ILIKE '%' || $6 || '%'
      ORDER BY lower(regexp_replace(e.path, '^.*/', '')), lower(l.name), e.path
      LIMIT $7`,
    [...p, escapeLike(needle), limit]
  );
  return rows.map((r) => ({
    library_id: r.library_id, library_name: r.library_name || '', path: r.path, name: r.path.split('/').pop(),
    folder: r.path.includes('/') ? r.path.slice(0, r.path.lastIndexOf('/')) : '', count: r.count,
  }));
}

module.exports = { searchFolders };

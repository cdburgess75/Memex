'use strict';
// "Pin for everyone in this group" (migrations/0024_pinned_by_default.sql): a group's
// whole-library share can put the library in each member's pinned list, once.
//
// It is given lazily, when the person's preferences are read (sign-in, and every page
// load), so it reaches people who are in the group already, people who join it later,
// and people who have never signed in yet -- with nothing to run when membership changes.
// Each library is given at most once per person (pin_defaults_applied), so unpinning it
// sticks.
const db = require('./db');

// Libraries due to this person: a pin-by-default share with a group they are in --
// matched on their VERIFIED address only, like every share -- on a library that is not
// archived, and not given to them before.
const DUE_SQL = `
  SELECT l.id, l.name
    FROM libraries l
   WHERE l.archived_at IS NULL
     AND EXISTS (SELECT 1 FROM library_grants g
                  WHERE g.library_id = l.id AND g.pin_by_default
                    AND g.subject_type = 'group' AND g.folder_path = ''
                    AND g.group_id IN (
                      SELECT gm.group_id FROM group_members gm
                       WHERE lower(gm.member_email) = (SELECT ur.verified_email FROM user_roles ur WHERE ur.user_id = $1)))
     AND NOT EXISTS (SELECT 1 FROM pin_defaults_applied a WHERE a.user_id = $1 AND a.library_id = l.id)
   ORDER BY lower(l.name), l.id`;

// Adds any due libraries to the person's pins and records them as given. Returns the ids
// it added (in name order), [] when there was nothing to do.
async function apply(userId) {
  if (!userId) return [];
  // Cheap check first: on almost every page load there is nothing due.
  const due = await db.query(DUE_SQL, [userId]);
  if (!due.length) return [];
  return db.withTransaction(async (client) => {
    // Recording first, and keeping only the rows THIS call inserted, means two page loads
    // at once give a library once between them, never twice.
    const ids = due.map(r => String(r.id));
    const { rows } = await client.query(
      `INSERT INTO pin_defaults_applied (user_id, library_id)
       SELECT $1, x::uuid FROM unnest($2::text[]) x
       ON CONFLICT DO NOTHING RETURNING library_id`,
      [userId, ids]
    );
    const fresh = new Set(rows.map(r => String(r.library_id)));
    const add = ids.filter(id => fresh.has(id));
    if (!add.length) return [];
    // Appended after the person's own pins, skipping any they already have.
    await client.query(
      `INSERT INTO user_preferences (user_id, pinned_libraries, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (user_id) DO UPDATE
         SET pinned_libraries = user_preferences.pinned_libraries || coalesce(
               (SELECT jsonb_agg(x ORDER BY o) FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY AS t(x, o)
                 WHERE NOT user_preferences.pinned_libraries @> jsonb_build_array(x)), '[]'::jsonb),
             updated_at = NOW()`,
      [userId, JSON.stringify(add)]
    );
    return add;
  });
}

// Turns the default on or off for one share. Only a group's share of a whole library can
// carry it (the table refuses anything else too). null when the share is not there.
async function setForShare(libraryId, shareId, on) {
  return db.queryOne(
    `UPDATE library_grants SET pin_by_default = $3, updated_at = NOW()
      WHERE id = $2 AND library_id = $1 AND subject_type = 'group' AND folder_path = ''
      RETURNING id`,
    [libraryId, shareId, !!on]
  );
}

module.exports = { apply, setForShare };

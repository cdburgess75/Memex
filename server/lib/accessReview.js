'use strict';
// Access-review evidence: for each user, their role (+ when it was assigned), what they
// can reach and why, and when they were last active. Produced for periodic (e.g.
// quarterly) review + sign-off, and exportable as CSV.
//
// What a person can reach comes from: owning a library; a share of a library or of a
// folder in it -- to them, or to a group they belong to -- at Read-Write or Read-only
// (viewers only ever read); and files shared with them one by one. Shares match only an
// address Keycloak has verified, so an account without one is flagged, and addresses
// that hold shares but have no verified account yet are listed separately. Library
// member lists predate sharing: they only decide who sees a library LISTED, never its
// files, and are reported as such.
const db = require('./db');
const { csvCell } = require('./csv');

const lc = (s) => String(s || '').toLowerCase();
const LEVEL = { write: 'Read-Write', read: 'Read-only' };

// "Clients (Read-Write, direct)", "Clients / Mender (Read-only, via group "Acctg")"
function describe(a) {
  return `${a.library}${a.folder ? ` / ${a.folder}` : ''} (${a.level}, ${a.via === 'direct' ? 'direct' : `via group ${JSON.stringify(a.via)}`})`;
}

// Pure assembler over already-fetched rows (kept separate so it is unit-testable
// without a database).
function assemble({ roles, profiles, memberships, libraries, lastActivity, shares, grants, groups, groupMembers }, now = new Date()) {
  const libName = new Map((libraries || []).map(l => [String(l.id), l.name]));
  const groupName = new Map((groups || []).map(g => [String(g.id), g.name]));
  const nameByEmail = new Map((profiles || []).map(p => [lc(p.email), p.display_name]));
  const lastByEmail = new Map((lastActivity || []).map(a => [lc(a.user_email), a.last]));
  const shareByEmail = new Map((shares || []).map(s => [lc(s.subject_email), Number(s.n) || 0]));
  const membersOf = new Map();
  for (const m of groupMembers || []) {
    const k = String(m.group_id);
    if (!membersOf.has(k)) membersOf.set(k, new Set());
    membersOf.get(k).add(lc(m.email || m.member_email));
  }
  const groupsOf = (email) => [...membersOf.entries()].filter(([, set]) => set.has(email)).map(([gid]) => gid);

  const memByEmail = new Map();
  const memberedLibIds = new Set();
  for (const m of memberships || []) {
    memberedLibIds.add(String(m.library_id));
    const k = lc(m.subject_email);
    if (!memByEmail.has(k)) memByEmail.set(k, []);
    memByEmail.get(k).push(libName.get(String(m.library_id)) || String(m.library_id));
  }
  const sharedLibIds = new Set((grants || []).map(g => String(g.library_id)));
  // No members and no shares: listed to every signed-in user -- which gives no access to
  // the files in it (only their owners, and shares, do).
  const openLibraries = (libraries || [])
    .filter(l => !memberedLibIds.has(String(l.id)) && !sharedLibIds.has(String(l.id))).map(l => l.name);

  // What an address reaches through shares, as the given role would get it.
  function accessFor(email, role) {
    const mine = new Set(groupsOf(email));
    const out = [];
    for (const g of grants || []) {
      let via = null;
      if (g.subject_type === 'user' && lc(g.subject_email) === email) via = 'direct';
      else if (g.subject_type === 'group' && mine.has(String(g.group_id))) via = groupName.get(String(g.group_id)) || String(g.group_id);
      if (!via) continue;
      out.push({
        library: libName.get(String(g.library_id)) || String(g.library_id),
        folder: g.folder_path || '',
        // what the share gives THIS person: write only to a contributor (an admin has
        // everything anyway; an address with no account yet is shown at the share's level)
        level: g.permission === 'write' && (role === 'contributor' || role === 'admin' || role === undefined) ? LEVEL.write : LEVEL.read,
        via,
      });
    }
    const sort = (a, b) => (`${a.library}/${a.folder}`).localeCompare(`${b.library}/${b.folder}`);
    return { libraryAccess: out.filter(a => !a.folder).sort(sort), folderAccess: out.filter(a => a.folder).sort(sort), groups: [...mine].map(gid => groupName.get(gid) || gid).sort() };
  }

  const verifiedAccounts = new Set();
  const users = (roles || []).map(r => {
    const k = lc(r.email);
    const verified = r.verified_email ? lc(r.verified_email) : null;
    if (verified) verifiedAccounts.add(verified);
    const reach = verified ? accessFor(verified, r.role) : { libraryAccess: [], folderAccess: [], groups: [] };
    return {
      email: r.email,
      name: nameByEmail.get(k) || '',
      role: r.role,
      roleAssignedAt: r.assigned_at || null,
      emailVerified: !!verified,
      owns: (libraries || []).filter(l => l.owner_id && r.user_id && String(l.owner_id) === String(r.user_id)).map(l => l.name).sort(),
      libraryAccess: reach.libraryAccess.map(describe),
      folderAccess: reach.folderAccess.map(describe),
      groups: reach.groups,
      // Member lists: who sees a library listed. No file access comes from them.
      libraries: r.role === 'admin' ? ['all (admin)'] : (memByEmail.get(k) || []).sort(),
      directShares: shareByEmail.get(k) || 0,
      lastActivity: lastByEmail.get(k) || null,
    };
  });

  // Addresses that hold shares (directly or through a group) with no verified account
  // yet: they get the access as soon as they sign in with that address verified.
  const pending = new Set();
  for (const g of grants || []) {
    if (g.subject_type === 'user') pending.add(lc(g.subject_email));
    else for (const e of membersOf.get(String(g.group_id)) || []) pending.add(e);
  }
  const pendingShares = [...pending].filter(e => e && !verifiedAccounts.has(e)).sort().map(email => {
    const reach = accessFor(email, undefined);
    return { email, libraryAccess: reach.libraryAccess.map(describe), folderAccess: reach.folderAccess.map(describe) };
  }).filter(p => p.libraryAccess.length || p.folderAccess.length);

  return { generatedAt: now.toISOString(), userCount: users.length, openLibraries, users, pendingShares };
}

async function build() {
  const [roles, profiles, memberships, libraries, lastActivity, shares, grants, groups, groupMembers] = await Promise.all([
    db.query('SELECT user_id, email, role, assigned_at, verified_email FROM user_roles ORDER BY email'),
    db.query('SELECT email, display_name FROM user_profiles'),
    db.query('SELECT subject_email, library_id FROM library_members'),
    db.query('SELECT id, name, owner_id FROM libraries'),
    db.query('SELECT user_email, MAX(created_at) AS last FROM activity_log GROUP BY user_email'),
    // Files shared with a person one by one: address-keyed rows on files not in Trash
    // (an uploader's own owner row is keyed by their id, not an address).
    db.query(`SELECT lower(acl.subject_email) AS subject_email, COUNT(*) AS n
                FROM document_acl acl JOIN documents d ON d.id = acl.document_id
               WHERE acl.subject_email IS NOT NULL AND lower(acl.subject_id) = lower(acl.subject_email) AND d.deleted_at IS NULL
               GROUP BY lower(acl.subject_email)`),
    db.query('SELECT library_id, folder_path, subject_type, subject_email, group_id, permission FROM library_grants'),
    db.query('SELECT id, name FROM groups'),
    db.query('SELECT group_id, lower(member_email) AS email FROM group_members'),
  ]);
  return assemble({ roles, profiles, memberships, libraries, lastActivity, shares, grants, groups, groupMembers });
}

const iso = (v) => (v instanceof Date ? v.toISOString() : (v || ''));

function toCsv(report) {
  const lines = [];
  // Header comment lines go through csvCell too: a library name (contributor-
  // controllable) with an embedded newline would otherwise split the comment into a new
  // physical row that could start with a formula.
  lines.push(csvCell(`# Memex access review: generated ${report.generatedAt}`));
  if (report.openLibraries.length) lines.push(csvCell(`# Listed to every signed-in user (no file access): ${report.openLibraries.join('; ')}`));
  lines.push(['email', 'name', 'role', 'role_assigned', 'email_verified', 'owns', 'library_access', 'folder_access', 'groups', 'listed_in', 'direct_shares', 'last_activity'].join(','));
  for (const u of report.users) {
    lines.push([
      u.email, u.name, u.role, iso(u.roleAssignedAt), u.emailVerified ? 'yes' : 'no', u.owns.join('; '),
      u.libraryAccess.join('; '), u.folderAccess.join('; '), u.groups.join('; '), u.libraries.join('; '),
      u.directShares, iso(u.lastActivity),
    ].map(csvCell).join(','));
  }
  // Addresses with shares but no verified account yet, in the same columns.
  for (const p of report.pendingShares || []) {
    lines.push([p.email, '', 'no verified account', '', 'no', '', p.libraryAccess.join('; '), p.folderAccess.join('; '), '', '', '', '']
      .map(csvCell).join(','));
  }
  return lines.join('\n');
}

module.exports = { assemble, build, toCsv, describe };

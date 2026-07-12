'use strict';
// Access-review evidence: for each user, their role (+ when it was assigned),
// which libraries they can reach, how many documents are directly shared with
// them, and when they were last active. Produced for periodic (e.g. quarterly)
// review + sign-off, and exportable as CSV.
const db = require('./db');
const { csvCell } = require('./csv');

const lc = (s) => String(s || '').toLowerCase();

// Pure assembler over already-fetched rows (kept separate so it is unit-testable
// without a database).
function assemble({ roles, profiles, memberships, libraries, lastActivity, shares }, now = new Date()) {
  const libName = new Map((libraries || []).map(l => [String(l.id), l.name]));
  const nameByEmail = new Map((profiles || []).map(p => [lc(p.email), p.display_name]));
  const lastByEmail = new Map((lastActivity || []).map(a => [lc(a.user_email), a.last]));
  const shareByEmail = new Map((shares || []).map(s => [lc(s.subject_email), Number(s.n) || 0]));

  const memByEmail = new Map();
  const memberedLibIds = new Set();
  for (const m of memberships || []) {
    memberedLibIds.add(String(m.library_id));
    const k = lc(m.subject_email);
    if (!memByEmail.has(k)) memByEmail.set(k, []);
    memByEmail.get(k).push(libName.get(String(m.library_id)) || String(m.library_id));
  }
  // A library with no explicit members is "open": any signed-in user can reach it.
  const openLibraries = (libraries || []).filter(l => !memberedLibIds.has(String(l.id))).map(l => l.name);

  const users = (roles || []).map(r => {
    const k = lc(r.email);
    return {
      email: r.email,
      name: nameByEmail.get(k) || '',
      role: r.role,
      roleAssignedAt: r.assigned_at || null,
      libraries: r.role === 'admin' ? ['all (admin)'] : (memByEmail.get(k) || []).sort(),
      directShares: shareByEmail.get(k) || 0,
      lastActivity: lastByEmail.get(k) || null,
    };
  });

  return { generatedAt: now.toISOString(), userCount: users.length, openLibraries, users };
}

async function build() {
  const [roles, profiles, memberships, libraries, lastActivity, shares] = await Promise.all([
    db.query('SELECT user_id, email, role, assigned_at FROM user_roles ORDER BY email'),
    db.query('SELECT email, display_name FROM user_profiles'),
    db.query('SELECT subject_email, library_id FROM library_members'),
    db.query('SELECT id, name FROM libraries'),
    db.query('SELECT user_email, MAX(created_at) AS last FROM activity_log GROUP BY user_email'),
    db.query("SELECT subject_email, COUNT(*) AS n FROM document_acl WHERE subject_email IS NOT NULL GROUP BY subject_email"),
  ]);
  return assemble({ roles, profiles, memberships, libraries, lastActivity, shares });
}

const iso = (v) => (v instanceof Date ? v.toISOString() : (v || ''));

function toCsv(report) {
  const lines = [];
  // Header comment lines go through csvCell too: a library name (contributor-
  // controllable) with an embedded newline would otherwise split the "# Open
  // libraries" line into a new physical row that could start with a formula.
  lines.push(csvCell(`# Memex access review: generated ${report.generatedAt}`));
  if (report.openLibraries.length) lines.push(csvCell(`# Open libraries (all signed-in users): ${report.openLibraries.join('; ')}`));
  lines.push(['email', 'name', 'role', 'role_assigned', 'libraries', 'direct_shares', 'last_activity'].join(','));
  for (const u of report.users) {
    lines.push([
      u.email, u.name, u.role, iso(u.roleAssignedAt), u.libraries.join('; '), u.directShares, iso(u.lastActivity),
    ].map(csvCell).join(','));
  }
  return lines.join('\n');
}

module.exports = { assemble, build, toCsv };

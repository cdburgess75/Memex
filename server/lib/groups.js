'use strict';
// Groups — named lists of people, owned by whoever creates them.
// Schema: migrations/0006_groups.sql. Groups grant nothing on their own yet; the
// access predicate starts reading them when libraries can be shared with a group.
const db = require('./db');

// One validator for every address a group can hold. Deliberately the stricter of the
// shapes already in the codebase (folders.js member grants): no quotes, spaces or
// angle brackets, so a crafted value cannot ride into the UI or into outbound mail.
const EMAIL_RE = /^[^\s@"'<>]+@[^\s@"'<>]+\.[^\s@"'<>]+$/;
const NAME_MAX = 80;

// Route ids come straight from the URL; checking the shape first means a bad id is a
// clean 404 rather than a Postgres cast error surfacing as a 500.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(v) { return UUID_RE.test(String(v || '')); }

function normalizeEmail(email) { return String(email || '').trim().toLowerCase(); }
function validEmail(email) { return EMAIL_RE.test(email); }

// Names: trimmed, internal whitespace collapsed, no control characters, bounded.
// Returns the cleaned name or null when nothing usable is left. Whitespace is folded
// to a single space FIRST: tabs and newlines are control characters too, and stripping
// them before collapsing would glue a pasted "Accounts<TAB>Payable" into one word.
function cleanName(raw) {
  const name = String(raw || '').replace(/\s+/g, ' ').replace(/[\x00-\x1f\x7f]/g, '').trim();
  if (!name || name.length > NAME_MAX) return null;
  return name;
}

// Owner or global admin. A group with no recorded owner is manageable by admins only.
function canManage(user, group) {
  if (!user || !group) return false;
  if (user.role === 'admin') return true;
  return !!group.owner_id && String(group.owner_id) === String(user.id);
}

// What a caller can see: admins every group; everyone else the groups they own or
// belong to. Each row says whether the caller may manage it, so the client does not
// have to re-derive the rule.
async function listGroups(user) {
  const isAdmin = user?.role === 'admin';
  const rows = await db.query(
    `SELECT g.id, g.name, g.owner_id, g.owner_email, g.created_at,
            (SELECT count(*) FROM group_members m WHERE m.group_id = g.id)::int AS member_count,
            EXISTS (SELECT 1 FROM group_members m WHERE m.group_id = g.id AND lower(m.member_email) = lower($2)) AS is_member
       FROM groups g
      WHERE $1
         OR g.owner_id = $3
         OR EXISTS (SELECT 1 FROM group_members m WHERE m.group_id = g.id AND lower(m.member_email) = lower($2))
      ORDER BY lower(g.name)`,
    [isAdmin, normalizeEmail(user?.email), user?.id || null]
  );
  return rows.map(r => ({ ...r, can_manage: canManage(user, r) }));
}

async function getGroup(id) {
  if (!isUuid(id)) return null;
  return db.queryOne(
    `SELECT id, name, owner_id, owner_email, created_by, created_by_email, created_at, updated_at
       FROM groups WHERE id = $1`,
    [id]
  );
}

// Anyone who may see a group: admin, owner, or a member of it.
async function canView(user, group) {
  if (!user || !group) return false;
  if (canManage(user, group)) return true;
  const row = await db.queryOne(
    'SELECT 1 FROM group_members WHERE group_id = $1 AND lower(member_email) = lower($2)',
    [group.id, normalizeEmail(user.email)]
  );
  return !!row;
}

// Postgres raises 23505 on the case-insensitive name index; callers turn it into a 409.
function isDuplicateName(e) { return e && e.code === '23505'; }

async function createGroup({ name, user }) {
  return db.queryOne(
    `INSERT INTO groups (name, owner_id, owner_email, created_by, created_by_email)
     VALUES ($1, $2, $3, $2, $3)
     RETURNING id, name, owner_id, owner_email, created_at`,
    [name, user?.id || null, normalizeEmail(user?.email) || null]
  );
}

async function renameGroup(id, name) {
  return db.queryOne(
    `UPDATE groups SET name = $2, updated_at = NOW() WHERE id = $1
     RETURNING id, name, owner_id, owner_email, created_at`,
    [id, name]
  );
}

async function deleteGroup(id) {
  return db.queryOne('DELETE FROM groups WHERE id = $1 RETURNING id, name', [id]);
}

// Members come back with a display name where Depot knows one (anyone who has set up a
// profile) and whether they have ever signed in — an outside contact is usually added
// before their first login, and the owner should be able to see that at a glance.
async function listMembers(groupId) {
  return db.query(
    `SELECT m.id, m.member_email, m.added_by_email, m.created_at,
            p.display_name,
            EXISTS (SELECT 1 FROM user_roles r WHERE lower(r.email) = lower(m.member_email)) AS has_signed_in
       FROM group_members m
       LEFT JOIN user_profiles p ON lower(p.email) = lower(m.member_email)
      WHERE m.group_id = $1
      ORDER BY lower(m.member_email)`,
    [groupId]
  );
}

// Adding someone already in the group is a no-op that returns their existing row, so a
// double-click or a retried request never errors and never creates a duplicate.
async function addMember(groupId, { email, user }) {
  const inserted = await db.queryOne(
    `INSERT INTO group_members (group_id, member_email, added_by, added_by_email)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (group_id, lower(member_email)) DO NOTHING
     RETURNING id, member_email, added_by_email, created_at`,
    [groupId, email, user?.id || null, normalizeEmail(user?.email) || null]
  );
  if (inserted) return { member: inserted, added: true };
  const existing = await db.queryOne(
    `SELECT id, member_email, added_by_email, created_at
       FROM group_members WHERE group_id = $1 AND lower(member_email) = lower($2)`,
    [groupId, email]
  );
  return { member: existing, added: false };
}

async function removeMember(groupId, memberId) {
  if (!isUuid(memberId)) return null;
  return db.queryOne(
    'DELETE FROM group_members WHERE id = $1 AND group_id = $2 RETURNING id, member_email',
    [memberId, groupId]
  );
}

// Hand a group to someone else. The new owner is identified by a user who has signed
// in (so there is a user id to own it); an outside contact who never has cannot own one.
async function transferOwner(groupId, { ownerId, ownerEmail }) {
  return db.queryOne(
    `UPDATE groups SET owner_id = $2, owner_email = $3, updated_at = NOW() WHERE id = $1
     RETURNING id, name, owner_id, owner_email, created_at`,
    [groupId, ownerId, normalizeEmail(ownerEmail)]
  );
}

module.exports = {
  EMAIL_RE, NAME_MAX,
  isUuid, normalizeEmail, validEmail, cleanName, canManage, canView, isDuplicateName,
  listGroups, getGroup, createGroup, renameGroup, deleteGroup,
  listMembers, addMember, removeMember, transferOwner,
};

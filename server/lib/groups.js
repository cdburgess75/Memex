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

// RFC 5321 caps a path at 254 characters; anything longer is not an address, and an
// unbounded one can exceed the btree row limit on the membership indexes.
const EMAIL_MAX = 254;

function normalizeEmail(email) { return typeof email === 'string' ? email.trim().toLowerCase() : ''; }

// Characters that render as nothing. \p{C} is every control, format, surrogate,
// private-use and unassigned code point; Default_Ignorable_Code_Point adds the
// invisible ones that are NOT in \p{C} — the combining grapheme joiner, variation
// selectors, Hangul fillers, Khmer and Mongolian format marks.
const INVISIBLE = /[\p{C}\p{Default_Ignorable_Code_Point}]/u;
const INVISIBLE_ALL = /[\p{C}\p{Default_Ignorable_Code_Point}]/gu;
// Whitespace, plus U+2800 BRAILLE PATTERN BLANK, which renders as a space but is not \s.
const BLANKS = /[\s\u2800]+/g;

// EMAIL_RE's [^\s...] alone lets through NUL (which Postgres rejects, surfacing as a
// 500), and invisible or bidi characters that make an address display as someone
// else's while never matching their sign-in; a lone surrogate would also corrupt the
// audit chain's hash.
function validEmail(email) {
  return typeof email === 'string' && email.length <= EMAIL_MAX && !INVISIBLE.test(email) && EMAIL_RE.test(email);
}

// Names: normalised, whitespace collapsed, invisible characters removed, bounded.
// Returns the cleaned name or null when nothing usable is left.
//
// The unique index exists so two groups can never both read "All Staff". A name that
// differs only by a zero-width space, a soft hyphen, a variation selector or a
// right-to-left override looks identical on screen yet is a different string, so it
// would slip past the index — exactly the lookalike it is there to stop. NFKC folds
// compatibility forms (full-width letters, ligatures) onto their plain equivalents for
// the same reason. This does not catch cross-script homoglyphs (a Cyrillic "А"); the
// piece-2 group picker shows each group's owner and size so two similar names can be
// told apart.
//
// Order matters. Whitespace is folded to a space BEFORE invisibles are stripped,
// because tabs and newlines are themselves \p{C}, and stripping first would glue a
// pasted "Accounts<TAB>Payable" into one word. NFKC runs AFTER stripping, because
// removing a character can leave text that is no longer normalised: "Cafe" + ZWSP + a
// combining accent would otherwise end as "Cafe" + U+0301, which renders like the
// one-code-point "Café". (No code point normalises INTO an invisible one — checked
// across all of Unicode — so one NFKC pass at this point is enough.) Stripping and
// NFKC can both leave extra spaces, so whitespace is collapsed again.
function cleanName(raw) {
  if (typeof raw !== 'string') return null;
  const name = raw
    .replace(BLANKS, ' ')
    .replace(INVISIBLE_ALL, '')
    .normalize('NFKC')
    .replace(BLANKS, ' ')
    .trim();
  if (!name || name.length > NAME_MAX) return null;
  return name;
}

// The owner is identified by user id, never by email: a second account that happens to
// use the same address is a different person as far as ownership goes. Postgres
// compares UUIDs case-insensitively, so this does too.
function isOwner(user, group) {
  if (!user?.id || !group?.owner_id) return false;
  return String(group.owner_id).toLowerCase() === String(user.id).toLowerCase();
}

// Global admins manage every group; otherwise the owner does — but only while they are
// a contributor. Viewers never manage groups (creating one needs contributor, and a
// handover refuses viewers); an owner who is later demoted to viewer keeps the group
// but loses the controls, the same way a demoted user loses document permission
// administration. An allow-list, so an unknown role fails closed. A group with no
// recorded owner is manageable by admins only.
function canManage(user, group) {
  if (!user || !group) return false;
  if (user.role === 'admin') return true;
  if (user.role !== 'contributor') return false;
  return isOwner(user, group);
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

// Anyone who may see a group: admin, owner, or a member of it. The owner branch stands
// on its own rather than going through canManage, so a demoted owner still sees the
// group listGroups offers them — the list and the group itself must never disagree.
async function canView(user, group) {
  if (!user || !group) return false;
  if (canManage(user, group) || isOwner(user, group)) return true;
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

// Renames and handovers are conditional on the group still looking the way it did when
// the caller was authorised: the name (or owner) read by the permission check must
// still be the current one. Otherwise two concurrent handovers both succeed and the
// last one silently reverses the first — an admin taking a group away from its owner
// could be undone by the owner's own request that was already in flight — and the audit
// records a "from" value that was no longer true. Null means nothing matched: the group
// is gone, or it changed; the caller tells the two apart.
async function renameGroup(id, name, expectedName) {
  return db.queryOne(
    `UPDATE groups SET name = $2, updated_at = NOW() WHERE id = $1 AND name = $3
     RETURNING id, name, owner_id, owner_email, created_at`,
    [id, name, expectedName]
  );
}

async function deleteGroup(id) {
  return db.queryOne('DELETE FROM groups WHERE id = $1 RETURNING id, name', [id]);
}

// Members come back with a display name where Depot knows one (anyone who has set up a
// profile) and whether they have ever signed in — an outside contact is usually added
// before their first login, and the owner should be able to see that at a glance.
// user_profiles is keyed by user id and its email is not unique — a recreated account
// leaves a second row with the same address. A JOIN would then return the member twice,
// so the name comes from a scalar subquery that picks the most recently updated profile.
async function listMembers(groupId) {
  return db.query(
    `SELECT m.id, m.member_email, m.added_by_email, m.created_at,
            (SELECT p.display_name FROM user_profiles p
              WHERE lower(p.email) = lower(m.member_email) AND coalesce(p.display_name, '') <> ''
              ORDER BY p.updated_at DESC LIMIT 1) AS display_name,
            EXISTS (SELECT 1 FROM user_roles r WHERE lower(r.email) = lower(m.member_email)) AS has_signed_in
       FROM group_members m
      WHERE m.group_id = $1
      ORDER BY lower(m.member_email)`,
    [groupId]
  );
}

// Adding someone already in the group is a no-op that returns their existing row, so a
// double-click or a retried request never errors and never creates a duplicate.
//
// Two races are handled rather than surfacing as a 500 or a wrong message:
//  - the group is deleted before the INSERT: the foreign key refuses the row (23503),
//    reported as { member: null } so the route answers 404;
//  - the INSERT conflicts on an existing row that a concurrent removal then deletes
//    before the follow-up SELECT: nothing is found, so the INSERT is simply tried once
//    more — the person was not in the group after all, and adding them is correct.
async function addMember(groupId, { email, user }) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let inserted;
    try {
      inserted = await db.queryOne(
        `INSERT INTO group_members (group_id, member_email, added_by, added_by_email)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (group_id, lower(member_email)) DO NOTHING
         RETURNING id, member_email, added_by_email, created_at`,
        [groupId, email, user?.id || null, normalizeEmail(user?.email) || null]
      );
    } catch (e) {
      if (e && e.code === '23503') return { member: null, added: false };
      throw e;
    }
    if (inserted) return { member: inserted, added: true };
    const existing = await db.queryOne(
      `SELECT id, member_email, added_by_email, created_at
         FROM group_members WHERE group_id = $1 AND lower(member_email) = lower($2)`,
      [groupId, email]
    );
    if (existing) return { member: existing, added: false };
  }
  return { member: null, added: false };
}

async function removeMember(groupId, memberId) {
  if (!isUuid(memberId)) return null;
  return db.queryOne(
    'DELETE FROM group_members WHERE id = $1 AND group_id = $2 RETURNING id, member_email',
    [memberId, groupId]
  );
}

// Who may become an owner. user_roles is keyed by user id and its email is not unique:
// a recreated sign-in or a reused address leaves more than one row. Taking the first
// match would hand the group to a dead or unrelated account, and the audit would still
// name the address as if it were right — so ambiguity is reported, never guessed.
// Ambiguity is judged across EVERY account with the address, before roles are looked
// at: filtering to eligible roles first would quietly pick the old contributor account
// when the person's live account is a newer viewer one.
// Viewers are excluded: the creation route keeps them from managing groups, and a
// transfer must not be a way round that.
async function resolveOwnerCandidate(email) {
  const rows = await db.query(
    'SELECT user_id, email, role FROM user_roles WHERE lower(email) = lower($1)',
    [email]
  );
  if (!rows.length) return { status: 'unknown' };
  if (new Set(rows.map(r => String(r.user_id))).size > 1) return { status: 'ambiguous' };
  const row = rows[0];
  if (row.role !== 'admin' && row.role !== 'contributor') return { status: 'viewer' };
  return { status: 'ok', user: row };
}

// Hand a group to someone else. The new owner is identified by a user who has signed
// in (so there is a user id to own it); an outside contact who never has cannot own one.
// Conditional on the owner the caller was authorised against (see renameGroup); IS NOT
// DISTINCT FROM so an ownerless group, which only admins manage, can be handed over.
async function transferOwner(groupId, { ownerId, ownerEmail, expectedOwnerId }) {
  return db.queryOne(
    `UPDATE groups SET owner_id = $2, owner_email = $3, updated_at = NOW()
      WHERE id = $1 AND owner_id IS NOT DISTINCT FROM $4
     RETURNING id, name, owner_id, owner_email, created_at`,
    [groupId, ownerId, normalizeEmail(ownerEmail), expectedOwnerId ?? null]
  );
}

module.exports = {
  EMAIL_RE, NAME_MAX,
  isUuid, normalizeEmail, validEmail, cleanName, isOwner, canManage, canView, isDuplicateName,
  listGroups, getGroup, createGroup, renameGroup, deleteGroup,
  listMembers, addMember, removeMember, transferOwner, resolveOwnerCandidate, EMAIL_MAX,
};

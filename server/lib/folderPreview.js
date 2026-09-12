'use strict';
// "Who gains and who loses if I move this folder?", answered before anything is moved.
//
// It is worked out from reads alone, because the model says it can be: a folder door is
// the one-row probe accessKeys already uses, and condition() admits somebody through it
// exactly when a key reaches every file behind it. So the access a folder carries is
// "the door it is at now", and the access it would have is "the door where it is going,
// plus the shares that travel with it". Nothing is written, nothing is locked, and the
// test suite checks the answer against actually doing the operation.
const crypto = require('crypto');
const db = require('./db');
const accessKeys = require('./accessKeys');
const folderPaths = require('./folderPaths');

const RANK = { read: 1, write: 2, admin: 3 };
const higher = (a, b) => ((RANK[a] || 0) >= (RANK[b] || 0) ? a : b) || null;

// The shares at a folder or anywhere under it: the ones that travel with it.
async function grantsAtOrBelow(q, libraryId, path) {
  if (!path) return [];
  return q.query(
    `SELECT g.id, g.folder_path, g.permission, g.subject_type, g.subject_email, g.group_id
       FROM library_grants g
      WHERE g.library_id = $1 AND g.folder_path <> ''
        AND (g.folder_path = $2 OR starts_with(g.folder_path, $2 || '/'))
      ORDER BY g.folder_path, g.id`,
    [libraryId, path]
  );
}

// One map per account of what the door gives them, merged.
function mergeLevels(...maps) {
  const out = new Map();
  for (const m of maps) for (const [id, level] of m) out.set(id, higher(out.get(id), level));
  return out;
}

// What the operation would change, as two maps: before and after.
async function levelsAround(q, op) {
  const { libraryId, path, newPath, targetLibraryId } = op;
  const before = await accessKeys.gates(q, { kind: 'folder', libraryId, path });
  const carried = await grantsAtOrBelow(q, libraryId, path);
  if (op.op === 'delete') {
    // the shares at or below end; what is left is whatever the door still gives
    const ending = carried.map(g => g.id);
    const after = await accessKeys.gates(q, { kind: 'folder', libraryId, path, excludeGrantIds: ending });
    return { before, after, carried, ending: carried };
  }
  if (op.op === 'library_move') {
    // nothing travels: sharing belongs to the library it was made in
    const after = await accessKeys.gates(q, { kind: 'folder', libraryId: targetLibraryId, path: newPath });
    return { before, after, carried, ending: carried };
  }
  // rename and move within a library: the destination door, plus the shares that travel
  // with the folder itself (the ones below it never opened this door, and still don't)
  const atFolder = carried.filter(g => g.folder_path === path).map(g => g.id);
  const after = mergeLevels(
    await accessKeys.gates(q, { kind: 'folder', libraryId, path: newPath }),
    await accessKeys.grantLevels(q, atFolder)
  );
  return { before, after, carried, ending: [] };
}

// The answer's own hash: everything the answer depends on is in the answer, so hashing
// it covers a share added above the destination, a group's membership changing, an owner
// changing -- not just the shares at the two paths. The mutating request echoes it and
// is refused if it no longer matches.
function fingerprint({ before, after, carried, op }) {
  const pairs = (m) => [...m].map(([id, level]) => `${id}|${level}`).sort().join(',');
  const shares = carried.map(g => `${g.id}|${g.permission}|${g.folder_path}`).sort().join(',');
  const body = [op.libraryId, op.targetLibraryId || '', op.path, op.newPath || '', pairs(before), pairs(after), shares].join('\n');
  return `sha256:${crypto.createHash('sha256').update(body).digest('hex')}`;
}

// Who gains, who loses, who changes level. Admins are counted, never named: they can open
// everything anyway, and a manager who isn't an admin is not shown admin names.
function diff(before, after, people) {
  const out = { lose: [], gain: [], changed: [], admins_unaffected: 0 };
  const ids = new Set([...before.keys(), ...after.keys()]);
  for (const id of ids) {
    const person = people.get(id);
    if (!person) continue;
    if (person.is_admin) { out.admins_unaffected++; continue; }
    const was = before.get(id) || null;
    const now = after.get(id) || null;
    if (was === now) continue;
    const entry = { email: person.email, name: person.name, before: was, after: now };
    if (!now) out.lose.push(entry);
    else if (!was) out.gain.push(entry);
    else out.changed.push(entry);
  }
  const byName = (a, b) => String(a.name || a.email || '').localeCompare(String(b.name || b.email || ''));
  out.lose.sort(byName); out.gain.sort(byName); out.changed.sort(byName);
  return out;
}

// `canManage`: { source, target } -- each side is only shown to whoever manages that
// library. Otherwise even a count is a probe, so the count goes too.
async function preview(op, { canManageSource, canManageTarget }) {
  return accessKeys.withSnapshot(async (q) => {
    const { before, after, carried, ending } = await levelsAround(q, op);
    const people = await accessKeys.peopleAt(q, [...new Set([...before.keys(), ...after.keys()])]);
    const d = diff(before, after, people);
    const out = {
      op: op.op,
      lose_visible: !!canManageSource,
      gain_visible: !!canManageTarget,
      lose: canManageSource ? d.lose : null,
      changed: canManageSource && canManageTarget ? d.changed : null,
      gain: canManageTarget ? d.gain : null,
      admins_unaffected: d.admins_unaffected,
      shares_moving: canManageSource ? carried.length - ending.length : null,
      shares_ending: canManageSource ? ending.map(g => ({ folder_path: g.folder_path, subject_type: g.subject_type, subject_email: g.subject_email, permission: g.permission })) : null,
      fingerprint: fingerprint({ before, after, carried, op }),
      generated_at: new Date().toISOString(),
    };
    return out;
  });
}

module.exports = { preview, levelsAround, grantsAtOrBelow, diff, fingerprint, mergeLevels };

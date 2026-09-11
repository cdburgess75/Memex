'use strict';
// Groups — mounted at /api/groups by server/index.js.
//
// Whoever creates a group owns and manages it; global admins can manage any group.
// A group you can neither manage nor belong to answers 404 rather than 403 when you
// address it by id, so ids and memberships of other people's groups do not leak.
// Group NAMES are deliberately one workspace-wide namespace — two groups may never
// both be called "All Staff" — so a 409 on create or rename does reveal that a name is
// taken. That follows from the uniqueness rule and cannot be hidden without breaking it.
//
// Every mutation re-checks the write's result: a request can pass the permission check
// and then find the group gone because a concurrent request deleted it, and that must
// answer 404 rather than dereference null into a 500. Renames and handovers are also
// conditional on the group being unchanged since the check (see lib renameGroup), and
// answer 409 when someone else changed it first.
//
// What a caller sees depends on whether they manage the group. Members — who may be
// outside contacts — see who else is in it (names and addresses, as in Seafile), but
// not the owner's working detail: who added whom, which addresses have a Depot
// account, the original creator.
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const { serverError } = require('../lib/httpError');
const groups = require('../lib/groups');
const libraryShares = require('../lib/libraryShares');

// Membership changes will decide who can open other people's libraries once groups
// can be granted access, so every change is chained. A failure is logged loudly —
// the repo's convention for security-relevant events (routes/admin.js) — rather than
// swallowed, but it never fails the request that already succeeded.
//
// Details lead with the group id and quote every user-supplied value (JSON string
// syntax), because names and addresses may themselves contain arrows, parentheses and
// pasted ids: unquoted, a group called 'Payroll (<the real Payroll id>)' would make its
// own events read as the real Payroll's, and two different renames could record the
// same text.
const q = (v) => JSON.stringify(v ?? null);
async function audit(req, eventType, detail) {
  try {
    await require('../lib/auditLog').append({
      eventType, actorId: req.user.id, actorEmail: req.user.email, detail,
    });
  } catch (e) { console.error(`audit ${eventType} failed:`, e.message); }
}

// Load a group and apply the visibility rule. Sends the response and returns null when
// the caller may not proceed; otherwise returns the group.
async function loadVisible(req, res) {
  const group = await groups.getGroup(req.params.id);
  if (!group || !(await groups.canView(req.user, group))) { res.status(404).json({ error: 'Group not found' }); return null; }
  return group;
}

async function loadManageable(req, res) {
  const group = await loadVisible(req, res);
  if (!group) return null;
  if (!groups.canManage(req.user, group)) { res.status(403).json({ error: 'Only the group owner or an admin can change this group' }); return null; }
  return group;
}

// A conditional write matched nothing: the group is gone (404), or someone else changed
// it after this request was authorised (409 — reload and look again).
async function changedOrGone(res, groupId, changedMessage = 'Someone else changed this group just now. Reload it and try again.') {
  if (!(await groups.getGroup(groupId))) return res.status(404).json({ error: 'Group not found' });
  return res.status(409).json({ error: changedMessage });
}

// GET /api/groups — groups the caller owns or belongs to (admins: every group)
router.get('/', auth, async (req, res) => {
  try { res.json(await groups.listGroups(req.user)); }
  catch (e) { serverError(res, e); }
});

// POST /api/groups — create a group; the creator becomes its owner. Same bar as
// creating a library: admins and contributors, not viewers.
router.post('/', auth, requireRole('admin', 'contributor'), async (req, res) => {
  try {
    const name = groups.cleanName(req.body?.name);
    if (!name) return res.status(400).json({ error: `Give the group a name (up to ${groups.NAME_MAX} characters)` });
    let group;
    try { group = await groups.createGroup({ name, user: req.user }); }
    catch (e) {
      if (groups.isDuplicateName(e)) return res.status(409).json({ error: `There is already a group called "${name}"` });
      throw e;
    }
    await audit(req, 'group_created', `group ${group.id} ${q(group.name)}`);
    res.status(201).json({ ...group, member_count: 0, can_manage: true, is_member: false });
  } catch (e) { serverError(res, e); }
});

// GET /api/groups/:id
router.get('/:id', auth, async (req, res) => {
  try {
    const group = await loadVisible(req, res);
    if (!group) return;
    const manage = groups.canManage(req.user, group);
    // share_count: how many library and folder shares membership of this group carries,
    // so the app can say what removing someone (or deleting the group) takes away.
    if (manage) return res.json({ ...group, can_manage: true, share_count: await libraryShares.countForGroup(group.id) });
    const { id, name, owner_id, owner_email, created_at } = group;
    res.json({ id, name, owner_id, owner_email, created_at, can_manage: false });
  } catch (e) { serverError(res, e); }
});

// PUT /api/groups/:id — rename
router.put('/:id', auth, async (req, res) => {
  try {
    const group = await loadManageable(req, res);
    if (!group) return;
    const name = groups.cleanName(req.body?.name);
    if (!name) return res.status(400).json({ error: `Give the group a name (up to ${groups.NAME_MAX} characters)` });
    // Nothing to change: answer as a success without writing or auditing a non-event.
    if (name === group.name) return res.json({ ...group, can_manage: true });
    let updated;
    try { updated = await groups.renameGroup(group.id, name, group.name); }
    catch (e) {
      if (groups.isDuplicateName(e)) return res.status(409).json({ error: `There is already a group called "${name}"` });
      // Two groups swapping names at the same instant can deadlock on the unique index;
      // Postgres cancels one of them, which is a retry, not a server fault.
      if (e && e.code === '40P01') return res.status(409).json({ error: 'Another change to groups got in the way. Try again.' });
      throw e;
    }
    if (!updated) return changedOrGone(res, group.id);
    await audit(req, 'group_renamed', `group ${group.id} ${q(group.name)} → ${q(updated.name)}`);
    res.json({ ...updated, can_manage: true });
  } catch (e) { serverError(res, e); }
});

// DELETE /api/groups/:id — members go with it (ON DELETE CASCADE)
router.delete('/:id', auth, async (req, res) => {
  try {
    const group = await loadManageable(req, res);
    if (!group) return;
    const members = await groups.listMembers(group.id);
    // Deleting a group removes its shares with it (ON DELETE CASCADE); count them first
    // so the chain records what access went away.
    const shareCount = await libraryShares.countForGroup(group.id);
    // Only the request that actually removed the row records the deletion; a second,
    // concurrent delete finds nothing and must not write a duplicate audit entry.
    const deleted = await groups.deleteGroup(group.id);
    if (!deleted) return res.status(404).json({ error: 'Group not found' });
    await audit(req, 'group_deleted', `group ${group.id} ${q(group.name)}, ${members.length} member(s), ${shareCount} share(s) removed`);
    res.json({ ok: true });
  } catch (e) { serverError(res, e); }
});

// GET /api/groups/:id/members — owners, admins and members may see who is in it.
// Non-managers get names and addresses only (see the header).
router.get('/:id/members', auth, async (req, res) => {
  try {
    const group = await loadVisible(req, res);
    if (!group) return;
    const rows = await groups.listMembers(group.id);
    if (groups.canManage(req.user, group)) return res.json(rows);
    res.json(rows.map(({ member_email, display_name }) => ({ member_email, display_name })));
  } catch (e) { serverError(res, e); }
});

// POST /api/groups/:id/members — add someone by email. People outside the
// organisation are allowed; that is how a client contact joins a working group.
router.post('/:id/members', auth, async (req, res) => {
  try {
    const group = await loadManageable(req, res);
    if (!group) return;
    const email = groups.normalizeEmail(req.body?.email);
    if (!groups.validEmail(email)) return res.status(400).json({ error: 'Enter a valid email address' });
    const { member, added } = await groups.addMember(group.id, { email, user: req.user });
    // Neither inserted nor found: the group went away mid-request (404), or — far rarer —
    // the person's row kept vanishing under concurrent removals (409, try again).
    if (!member) return changedOrGone(res, group.id, 'The group changed while you were adding them. Try again.');
    // The chain records the stored, normalised address — never the raw request body.
    if (added) await audit(req, 'group_member_added', `group ${group.id} ${q(group.name)} + ${q(member.member_email)}`);
    res.status(added ? 201 : 200).json({ ...member, already_member: !added });
  } catch (e) { serverError(res, e); }
});

// DELETE /api/groups/:id/members/:memberId
router.delete('/:id/members/:memberId', auth, async (req, res) => {
  try {
    const group = await loadManageable(req, res);
    if (!group) return;
    const removed = await groups.removeMember(group.id, req.params.memberId);
    if (!removed) return res.status(404).json({ error: 'That person is not in this group' });
    await audit(req, 'group_member_removed', `group ${group.id} ${q(group.name)} - ${q(removed.member_email)}`);
    res.json({ ok: true });
  } catch (e) { serverError(res, e); }
});

// PUT /api/groups/:id/owner — hand the group to someone else. The new owner must
// have signed in to Depot, so there is a user id for them to own it with.
//
// Why a handover is refused says something about the target account: its role, or that
// two accounts share the address. Admins can see all of that anyway and need the exact
// reason to fix it, so they get it. Anyone else gets one answer for both — otherwise a
// contributor could learn colleagues' roles by trying handovers from a scratch group.
// ("Hasn't signed in" stays specific: a group owner already sees that for every member.)
// Every refusal is chained, so repeated probing shows up in the audit log.
router.put('/:id/owner', auth, async (req, res) => {
  try {
    const group = await loadManageable(req, res);
    if (!group) return;
    const email = groups.normalizeEmail(req.body?.email);
    if (!groups.validEmail(email)) return res.status(400).json({ error: 'Enter a valid email address' });
    const candidate = await groups.resolveOwnerCandidate(email);
    if (candidate.status !== 'ok') {
      await audit(req, 'group_owner_change_refused', `group ${group.id} ${q(group.name)} → ${q(email)}: ${candidate.status}`);
      if (candidate.status === 'unknown') return res.status(400).json({ error: `${email} hasn't signed in to Depot yet, so they can't own a group` });
      if (req.user.role !== 'admin') return res.status(400).json({ error: `${email} can't own this group. Ask an admin for help.` });
      if (candidate.status === 'viewer') return res.status(400).json({ error: `${email} can only view files, so they can't own a group` });
      return res.status(409).json({ error: `More than one Depot account uses ${email}. Sort that out in Admin before handing this group over.` });
    }
    // Already theirs: nothing to change or record.
    if (groups.isOwner({ id: candidate.user.user_id }, group)) {
      return res.json({ ...group, can_manage: groups.canManage(req.user, group) });
    }
    const updated = await groups.transferOwner(group.id, {
      ownerId: candidate.user.user_id, ownerEmail: candidate.user.email, expectedOwnerId: group.owner_id,
    });
    if (!updated) return changedOrGone(res, group.id);
    await audit(req, 'group_owner_changed', `group ${group.id} ${q(group.name)} owner ${q(group.owner_email)} → ${q(updated.owner_email)}`);
    res.json({ ...updated, can_manage: groups.canManage(req.user, updated) });
  } catch (e) { serverError(res, e); }
});

module.exports = router;

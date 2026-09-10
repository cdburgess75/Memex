'use strict';
// Groups — mounted at /api/groups by server/index.js.
//
// Whoever creates a group owns and manages it; global admins can manage any group.
// A group you can neither manage nor belong to answers 404 rather than 403, so the
// existence and name of other people's groups do not leak.
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const { serverError } = require('../lib/httpError');
const db = require('../lib/db');
const groups = require('../lib/groups');

// Membership changes will decide who can open other people's libraries once groups
// can be granted access, so every change is chained. A failure is logged loudly —
// the repo's convention for security-relevant events (routes/admin.js) — rather than
// swallowed, but it never fails the request that already succeeded.
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
    await audit(req, 'group_created', `${group.name} (${group.id})`);
    res.status(201).json({ ...group, member_count: 0, can_manage: true, is_member: false });
  } catch (e) { serverError(res, e); }
});

// GET /api/groups/:id
router.get('/:id', auth, async (req, res) => {
  try {
    const group = await loadVisible(req, res);
    if (!group) return;
    res.json({ ...group, can_manage: groups.canManage(req.user, group) });
  } catch (e) { serverError(res, e); }
});

// PUT /api/groups/:id — rename
router.put('/:id', auth, async (req, res) => {
  try {
    const group = await loadManageable(req, res);
    if (!group) return;
    const name = groups.cleanName(req.body?.name);
    if (!name) return res.status(400).json({ error: `Give the group a name (up to ${groups.NAME_MAX} characters)` });
    let updated;
    try { updated = await groups.renameGroup(group.id, name); }
    catch (e) {
      if (groups.isDuplicateName(e)) return res.status(409).json({ error: `There is already a group called "${name}"` });
      throw e;
    }
    await audit(req, 'group_renamed', `${group.name} → ${updated.name} (${group.id})`);
    res.json({ ...updated, can_manage: true });
  } catch (e) { serverError(res, e); }
});

// DELETE /api/groups/:id — members go with it (ON DELETE CASCADE)
router.delete('/:id', auth, async (req, res) => {
  try {
    const group = await loadManageable(req, res);
    if (!group) return;
    const members = await groups.listMembers(group.id);
    await groups.deleteGroup(group.id);
    await audit(req, 'group_deleted', `${group.name} (${group.id}), ${members.length} member(s)`);
    res.json({ ok: true });
  } catch (e) { serverError(res, e); }
});

// GET /api/groups/:id/members — owners, admins and members may see who is in it
router.get('/:id/members', auth, async (req, res) => {
  try {
    const group = await loadVisible(req, res);
    if (!group) return;
    res.json(await groups.listMembers(group.id));
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
    if (added) await audit(req, 'group_member_added', `${email} → ${group.name} (${group.id})`);
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
    await audit(req, 'group_member_removed', `${removed.member_email} ← ${group.name} (${group.id})`);
    res.json({ ok: true });
  } catch (e) { serverError(res, e); }
});

// PUT /api/groups/:id/owner — hand the group to someone else. The new owner must
// have signed in to Depot, so there is a user id for them to own it with.
router.put('/:id/owner', auth, async (req, res) => {
  try {
    const group = await loadManageable(req, res);
    if (!group) return;
    const email = groups.normalizeEmail(req.body?.email);
    if (!groups.validEmail(email)) return res.status(400).json({ error: 'Enter a valid email address' });
    const target = await db.queryOne('SELECT user_id, email FROM user_roles WHERE lower(email) = lower($1) LIMIT 1', [email]);
    if (!target) return res.status(400).json({ error: `${email} hasn't signed in to Depot yet, so they can't own a group` });
    const updated = await groups.transferOwner(group.id, { ownerId: target.user_id, ownerEmail: target.email });
    await audit(req, 'group_owner_changed', `${group.name} (${group.id}): ${group.owner_email || 'none'} → ${updated.owner_email}`);
    res.json({ ...updated, can_manage: groups.canManage(req.user, updated) });
  } catch (e) { serverError(res, e); }
});

module.exports = router;

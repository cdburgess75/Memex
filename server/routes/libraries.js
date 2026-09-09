'use strict';
const { serverError } = require('../lib/httpError');
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const libraries = require('../lib/libraries');

// GET /api/libraries — list libraries the caller can access
router.get('/', auth, async (req, res) => {
  try {
    res.json(await libraries.listLibraries(req.user));
  } catch (e) {
    serverError(res, e);
  }
});

// POST /api/libraries — create a library (admin/contributor)
router.post('/', auth, requireRole('admin', 'contributor'), async (req, res) => {
  try {
    const name = (req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name required' });
    res.json(await libraries.createLibrary({ name, user: req.user }));
  } catch (e) {
    serverError(res, e);
  }
});

// PUT /api/libraries/:id/org-shared — open a library to the whole workspace, or
// close it again (admin). This is the one library setting that changes who can
// reach the documents inside, so it is chained rather than left to the settings
// audit, and the event records the library by name as well as id.
router.put('/:id/org-shared', auth, requireRole('admin'), async (req, res) => {
  try {
    const shared = req.body?.org_shared;
    if (typeof shared !== 'boolean') return res.status(400).json({ error: 'org_shared must be true or false' });
    const row = await libraries.setOrgShared(req.params.id, shared);
    if (!row) return res.status(404).json({ error: 'library not found' });
    await require('../lib/auditLog').append({
      eventType: shared ? 'library_shared_org' : 'library_unshared_org',
      actorId: req.user.id,
      actorEmail: req.user.email,
      detail: `${row.name} (${row.id}) ${shared ? 'opened to' : 'closed to'} everyone in the workspace`,
    }).catch(() => {});
    res.json(row);
  } catch (e) {
    serverError(res, e);
  }
});

// GET /api/libraries/:id/members — list members (admin)
router.get('/:id/members', auth, requireRole('admin'), async (req, res) => {
  try {
    res.json(await libraries.listMembers(req.params.id));
  } catch (e) {
    serverError(res, e);
  }
});

// POST /api/libraries/:id/members — add a member by email (admin)
router.post('/:id/members', auth, requireRole('admin'), async (req, res) => {
  try {
    const email = (req.body?.email || '').trim();
    if (!email) return res.status(400).json({ error: 'email required' });
    res.json(await libraries.addMember(req.params.id, { email, user: req.user }));
  } catch (e) {
    serverError(res, e);
  }
});

// DELETE /api/libraries/:id/members/:memberId — remove a member (admin)
router.delete('/:id/members/:memberId', auth, requireRole('admin'), async (req, res) => {
  try {
    const removed = await libraries.removeMember(req.params.id, req.params.memberId);
    if (!removed) return res.status(404).json({ error: 'member not found' });
    res.json({ ok: true });
  } catch (e) {
    serverError(res, e);
  }
});

module.exports = router;

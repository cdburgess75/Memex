'use strict';
const { serverError } = require('../lib/httpError');
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const libraries = require('../lib/libraries');
const shares = require('../lib/libraryShares');
const groups = require('../lib/groups');
const notifications = require('../lib/notifications');
const emailEvents = require('../lib/emailEvents');
const { actingAs } = require('../lib/email');
const { canonicalFolderPath } = require('../lib/documents');

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
    const lib = await libraries.createLibrary({ name, user: req.user });
    // Libraries are about to become shareable by their owner, so who created which one
    // belongs in the tamper-evident chain. Best-effort: never fails the request.
    try {
      await require('../lib/auditLog').append({
        eventType: 'library_created', actorId: req.user.id, actorEmail: req.user.email,
        detail: `library ${lib.id} ${JSON.stringify(lib.name)} owner ${req.user.id}`,
      });
    } catch (e) { console.error('audit library_created failed:', e.message); }
    res.json(lib);
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

// ---------------------------------------------------------------------------------
// Sharing a library, or a folder in it, with a person or a group (Seafile's model).
//
// The library's owner manages its shares -- or any admin; a viewer never does. A share
// is Read-Write or Read-only and reaches every file in the library (or folder),
// including files added later; what it grants is decided in documentAccess.condition().
// A library the caller can't see answers 404; one they can see but not manage, 403.
// Every change is chained in the audit log, with user-supplied values quoted.
const q = (v) => JSON.stringify(v ?? null);
async function audit(req, eventType, detail) {
  try {
    await require('../lib/auditLog').append({ eventType, actorId: req.user.id, actorEmail: req.user.email, detail });
  } catch (e) { console.error(`audit ${eventType} failed:`, e.message); }
}
const LEVEL = { write: 'Read-Write', read: 'Read-only' };
const who = (share) => (share.subject_type === 'group' ? `group ${share.group_id || share.group?.id} ${q(share.group?.name ?? share.group_name)}` : `user ${q(share.subject_email)}`);
const where = (lib, path) => `library ${lib.id} ${q(lib.name)} ${q(path || '')}`;

async function loadManaged(req, res) {
  const lib = await libraries.visibleLibrary(req.user, req.params.id);
  if (!lib) { res.status(404).json({ error: 'Library not found' }); return null; }
  if (!lib.can_manage) { res.status(403).json({ error: "Only the library owner or an admin can see or change who it's shared with" }); return null; }
  return lib;
}

// GET /api/libraries/:id/shares — who it (and folders in it) are shared with
router.get('/:id/shares', auth, requireRole('admin', 'contributor'), async (req, res) => {
  try {
    const lib = await loadManaged(req, res);
    if (!lib) return;
    const body = {
      library: { id: lib.id, name: lib.name, owner_id: lib.owner_id, owner_email: lib.owner_email },
      shares: await shares.listShares(lib.id),
    };
    // The old member list only ever controlled who saw the library listed; admins see it
    // so it isn't mistaken for access.
    if (req.user.role === 'admin') body.legacy_members = await libraries.listMembers(lib.id);
    res.json(body);
  } catch (e) { serverError(res, e); }
});

// POST /api/libraries/:id/shares — { folder_path?, permission, email | group_id }
router.post('/:id/shares', auth, requireRole('admin', 'contributor'), async (req, res) => {
  try {
    const lib = await loadManaged(req, res);
    if (!lib) return;
    if (!lib.owner_id) {
      return res.status(409).json({ error: "This library has no owner yet, so it can't be shared. An admin can create a new library to share instead." });
    }
    const rawEmail = req.body?.email;
    const rawGroup = req.body?.group_id;
    if (!!rawEmail === !!rawGroup) return res.status(400).json({ error: 'Choose one person or one group to share with' });
    const permission = req.body?.permission;
    if (permission !== 'read' && permission !== 'write') return res.status(400).json({ error: 'Choose Read-Write or Read-only' });

    let email = null, group = null;
    if (rawEmail) {
      email = groups.normalizeEmail(rawEmail);
      if (!groups.validEmail(email)) return res.status(400).json({ error: 'Enter a valid email address' });
    } else {
      group = await groups.getGroup(rawGroup);
      if (!group || !(req.user.role === 'admin' || (await groups.canView(req.user, group)))) return res.status(404).json({ error: 'Group not found' });
    }

    let folderPath = '';
    if (req.body?.folder_path !== undefined && req.body?.folder_path !== null && String(req.body.folder_path).replace(/[\\/]/g, '') !== '') {
      folderPath = canonicalFolderPath(String(req.body.folder_path));
      if (!folderPath) return res.status(400).json({ error: "That folder can't be shared: rename it first (its name has characters a share can't hold)" });
      if (!(await shares.folderVisibleTo(lib.id, folderPath, req.user))) return res.status(404).json({ error: 'Folder not found in this library' });
    }

    let share;
    try {
      share = await shares.createShare({ libraryId: lib.id, folderPath, email, groupId: group?.id, permission, user: req.user });
    } catch (e) {
      if (e && e.code === '23505') {
        const existing = await shares.findShare(lib.id, folderPath, { email, groupId: group?.id });
        return res.status(409).json({ error: `Already shared with ${email || group.name}. Change the level in the list.`, share: existing });
      }
      if (e && e.code === '23503') return res.status(404).json({ error: email ? 'Library not found' : 'That library or group no longer exists' });
      throw e;
    }
    await audit(req, 'library_shared', `${where(lib, folderPath)} -> ${email ? `user ${q(email)}` : `group ${group.id} ${q(group.name)}`} ${permission} by ${req.user.id}`);

    // Tell them. A person: in-app and by email. A group: in-app, to each member.
    const sharer = actingAs(req.user);
    const oneLine = (v) => String(v || '').replace(/\s+/g, ' ').trim(); // names go into mail text
    const what = folderPath ? `the folder "${oneLine(folderPath.split('/').pop())}" in ${oneLine(lib.name)}` : `the library "${oneLine(lib.name)}"`;
    const title = `${sharer.label} shared ${folderPath ? 'a folder' : 'a library'} with you`;
    const bodyText = `${what} · ${LEVEL[permission]}`;
    const me = String(req.user.email || '').toLowerCase();
    const recipients = email ? [email] : (await groups.listMembers(group.id)).map(m => String(m.member_email || '').toLowerCase());
    for (const to of [...new Set(recipients)].filter(a => a && a !== me)) {
      // Not awaited: a large group must not hold up the answer (each notice is best-effort).
      notifications.create({ userEmail: to, type: 'share_granted', title, body: bodyText, refType: 'library', refId: lib.id })
        .catch(e => console.error('notification (library share_granted) failed:', e.message));
      if (email) {
        emailEvents.send('share_granted', {
          to, subject: title,
          text: `${sharer.label} gave you ${LEVEL[permission]} access to ${what} in Depot. It includes files added later.\n\nSign in to Depot to open it.`,
          actorEmail: sharer.sendAs,
        }).catch(() => {});
      }
    }
    res.status(201).json({ share });
  } catch (e) { serverError(res, e); }
});

// PUT /api/libraries/:id/shares/:shareId — { permission }
router.put('/:id/shares/:shareId', auth, requireRole('admin', 'contributor'), async (req, res) => {
  try {
    const lib = await loadManaged(req, res);
    if (!lib) return;
    const share = groups.isUuid(req.params.shareId) ? await shares.getShare(lib.id, req.params.shareId) : null;
    if (!share) return res.status(404).json({ error: 'Share not found' });
    const permission = req.body?.permission;
    if (permission !== 'read' && permission !== 'write') return res.status(400).json({ error: 'Choose Read-Write or Read-only' });
    if (permission === share.permission) return res.json({ share });
    const updated = await shares.setPermission(lib.id, share.id, share.permission, permission);
    if (!updated) {
      if (!(await shares.getShare(lib.id, share.id))) return res.status(404).json({ error: 'Share not found' });
      return res.status(409).json({ error: 'Someone else changed this share just now. Reload it and try again.' });
    }
    await audit(req, 'library_share_changed', `${where(lib, share.folder_path)} -> ${who(share)} ${share.permission} -> ${permission} by ${req.user.id}`);
    res.json({ share: updated });
  } catch (e) { serverError(res, e); }
});

// DELETE /api/libraries/:id/shares/:shareId
router.delete('/:id/shares/:shareId', auth, requireRole('admin', 'contributor'), async (req, res) => {
  try {
    const lib = await loadManaged(req, res);
    if (!lib) return;
    const share = groups.isUuid(req.params.shareId) ? await shares.getShare(lib.id, req.params.shareId) : null;
    if (!share) return res.status(404).json({ error: 'Share not found' });
    // Only the request that removed the row records it; a concurrent second delete 404s.
    const removed = await shares.deleteShare(lib.id, share.id);
    if (!removed) return res.status(404).json({ error: 'Share not found' });
    await audit(req, 'library_unshared', `${where(lib, share.folder_path)} -> ${who(share)} ${removed.permission} by ${req.user.id}`);
    res.json({ ok: true });
  } catch (e) { serverError(res, e); }
});

module.exports = router;

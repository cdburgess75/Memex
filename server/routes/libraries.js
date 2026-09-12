'use strict';
const { serverError } = require('../lib/httpError');
const express = require('express');
const router = express.Router();
const { withFolderOp, FolderOpError, sendFolderOpError } = require('../lib/folderOps');
const auth = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const libraries = require('../lib/libraries');
const folderUndo = require('../lib/folderUndo');
const shares = require('../lib/libraryShares');
const db = require('../lib/db');
const groups = require('../lib/groups');
const notifications = require('../lib/notifications');
const emailEvents = require('../lib/emailEvents');
const { actingAs } = require('../lib/email');
const { canonicalFolderPath, folderLookupPath } = require('../lib/documents');

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

/* POST /api/libraries/:id/owner -- give an ownerless library an owner (admin).
 *
 * Depot creates one library at install with nobody's name on it, and until now nothing
 * anywhere could put a name on it: it could not be shared (a share belongs to an owner),
 * and once the old open rule goes it could not even be added to. Every install has one.
 *
 * This only ever FILLS IN a missing owner. Handing an owned library to somebody else is a
 * different question -- it moves other people's access -- and belongs with the rest of
 * "switching people off".
 */
router.post('/:id/owner', auth, requireRole('admin'), async (req, res) => {
  try {
    const email = String(req.body?.owner_email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'owner_email required' });
    const lib = await db.queryOne('SELECT id, name, owner_id FROM libraries WHERE id = $1', [req.params.id]);
    if (!lib) return res.status(404).json({ error: 'Library not found' });
    if (lib.owner_id) {
      return res.status(409).json({ code: 'ALREADY_OWNED',
        error: 'This library already has an owner. Changing who owns a library moves other people’s access with it, which is a separate job.' });
    }
    // The owner is matched by account id everywhere access is decided, so an owner works
    // whether or not their address has been verified -- unlike a share, which matches
    // only a verified address.
    const account = await db.queryOne(
      'SELECT user_id, email, role FROM user_roles WHERE lower(email) = $1 OR verified_email = $1', [email]);
    if (!account) return res.status(404).json({ error: 'Nobody with that address has signed in yet, so they cannot own a library.' });
    if (account.role === 'viewer') return res.status(400).json({ error: 'Someone who can only look at files cannot own a library.' });
    const updated = await db.queryOne(
      `UPDATE libraries SET owner_id = $2, owner_email = $3 WHERE id = $1 AND owner_id IS NULL
       RETURNING id, name, owner_id, owner_email`,
      [lib.id, account.user_id, String(account.email).toLowerCase()]
    );
    if (!updated) return res.status(409).json({ code: 'ALREADY_OWNED', error: 'Somebody gave this library an owner a moment ago.' });
    try {
      await require('../lib/auditLog').append({
        eventType: 'library_created', actorId: req.user.id, actorEmail: req.user.email,
        detail: `owner set · library ${updated.id} ${q(updated.name)} → ${q(updated.owner_email)} (${updated.owner_id})`,
      });
    } catch (e) { console.error('audit library owner failed:', e.message); }
    res.json(updated);
  } catch (e) { serverError(res, e); }
});

/* POST /api/libraries/:id/adopt -- put MY OWN files into the library's shared content.
 *
 * A file uploaded into a library before it had an owner is personal: it belongs to
 * whoever put it there and nobody else can read it, the library's owner included. That is
 * right for a file somebody parked in a workspace -- and wrong for a folder of company
 * documents that was always meant to be shared.
 *
 * So the person who uploaded them can hand them to the library. ONLY their own: an admin
 * cannot hand over somebody else's private files, and is told how many were left alone
 * rather than being quietly given a smaller number.
 */
router.post('/:id/adopt', auth, requireRole('admin', 'contributor'), async (req, res) => {
  try {
    const lib = await loadManaged(req, res);
    if (!lib) return;
    const folderPath = req.body?.path ? folderLookupPath(req.body.path) : '';
    if (req.body?.path && !folderPath) return res.status(400).json({ error: 'Bad folder path' });
    const scope = folderPath ? `AND starts_with(d.name, $3 || '/')` : '';
    const params = folderPath ? [req.params.id, req.user.id, folderPath] : [req.params.id, req.user.id];
    const mine = await db.query(
      `UPDATE documents d SET library_scoped = true
        WHERE d.library_id = $1 AND d.deleted_at IS NULL AND NOT d.library_scoped
          AND d.uploaded_by = $2 ${scope}
        RETURNING d.id`,
      params
    );
    // What is left is other people's, and stays theirs. Counted for admins only, who are
    // shown personal files everywhere else.
    const theirs = req.user.role === 'admin' ? (await db.queryOne(
      `SELECT count(*)::int AS n FROM documents d
        WHERE d.library_id = $1 AND d.deleted_at IS NULL AND NOT d.library_scoped ${folderPath ? `AND starts_with(d.name, $2 || '/')` : ''}`,
      folderPath ? [req.params.id, folderPath] : [req.params.id]
    ))?.n : undefined;
    if (mine.length) {
      try {
        await require('../lib/auditLog').append({
          eventType: 'library_shared', actorId: req.user.id, actorEmail: req.user.email,
          detail: `adopted · ${mine.length} of their own file(s) became content of library ${lib.id} ${q(lib.name)}${folderPath ? ` under ${q(folderPath)}` : ''}`,
        });
      } catch (e) { console.error('audit library adopt failed:', e.message); }
    }
    res.json({ ok: true, count: mine.length, ...(theirs === undefined ? {} : { left_with_their_owners: theirs }) });
  } catch (e) { serverError(res, e); }
});

// GET /api/libraries/:id/shares — who it (and folders in it) are shared with
router.get('/:id/shares', auth, requireRole('admin', 'contributor'), async (req, res) => {
  try {
    const lib = await loadManaged(req, res);
    if (!lib) return;
    const body = {
      library: { id: lib.id, name: lib.name, owner_id: lib.owner_id, owner_email: lib.owner_email },
      shares: await shares.listShares(lib.id),
    };
    // Sharing that ended when a folder was deleted, and could still be offered again --
    // what makes the delete dialog's promise true after its Undo has faded. Only for a
    // folder, and only for as long as the deletion can still be undone.
    const folderPath = folderLookupPath(req.query?.path);
    if (folderPath) body.ended_shares = await folderUndo.endedSharesAt(db, lib.id, folderPath);
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
      // Under the library's tree lock, and checking the folder again inside it: without
      // that, a share could be made on a folder that a rename is moving, or on one whose
      // last file is being deleted in another transaction -- leaving a share on a name
      // with nothing under it, which the next folder of that name would inherit.
      share = await withFolderOp({ libraryIds: [lib.id] }, async (q) => {
        if (folderPath && !(await shares.folderVisibleTo(lib.id, folderPath, req.user, q))) {
          throw new FolderOpError(null, 404, 'Folder not found in this library');
        }
        return shares.createShare({ libraryId: lib.id, folderPath, email, groupId: group?.id, permission, user: req.user }, q);
      });
    } catch (e) {
      if (sendFolderOpError(res, e)) return;
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

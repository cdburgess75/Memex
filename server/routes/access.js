'use strict';
// Who has access, and why (piece 3) -- mounted at /api/access by server/index.js.
// Everything here only reads; what each list may show is decided in lib/accessKeys.
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { serverError } = require('../lib/httpError');
const accessKeys = require('../lib/accessKeys');
const libraries = require('../lib/libraries');
const libraryShares = require('../lib/libraryShares');
const documentAccess = require('../lib/documentAccess');
const { folderLookupPath } = require('../lib/documents');
const { isUuid } = require('../lib/groups');
const db = require('../lib/db');
const folderPreview = require('../lib/folderPreview');
const folderPaths = require('../lib/folderPaths');
const { canonicalFolderPath } = require('../lib/documents');

// GET /api/access/shared-with-me -- libraries, folders and files shared with the caller
router.get('/shared-with-me', auth, async (req, res) => {
  try { res.json(await accessKeys.sharedWithMe(req.user)); } catch (e) { serverError(res, e); }
});

// GET /api/access/libraries/:id[?folder=<path>] -- who can get into a library or a
// folder in it, and why. Anyone who sees the library listed gets their own access
// ("you"); only someone who manages it (an admin, or its owner while a contributor)
// gets the full list. A manager asking about a folder must name one that exists among
// files they can read, or one that is shared -- the list must not confirm that someone
// else's private folder of that name exists.
router.get('/libraries/:id', auth, async (req, res) => {
  try {
    const listed = await libraries.visibleLibraryRow(req.user, req.params.id);
    if (!listed) return res.status(404).json({ error: 'Library not found' });
    const library = libraries.shapeLibrary(req.user, listed);
    let path = '';
    if (req.query.folder !== undefined && req.query.folder !== '') {
      path = typeof req.query.folder === 'string' ? folderLookupPath(req.query.folder) : null;
      if (!path) return res.status(400).json({ error: 'Bad folder path' });
    }
    const manager = !!library.can_manage;
    if (manager && path) {
      const there = (await libraryShares.folderVisibleTo(library.id, path, req.user)) || (await libraries.sharedFolderAt(library.id, path));
      if (!there) return res.status(404).json({ error: 'Folder not found in this library' });
    }
    res.json(await accessKeys.libraryDoor(req.user, { library, listed, path, manager }));
  } catch (e) { serverError(res, e); }
});

// GET /api/access/files/:id -- who can open a file, and why. Anyone who can read it gets
// their own access; the full list goes to an admin or contributor who may manage the
// file's access (document admin). Someone who manages the file but not its library sees
// the file's own grants, and is told the library's sharing lets others in too.
router.get('/files/:id', auth, async (req, res) => {
  try {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Document not found' });
    const columns = 'd.id, d.name, d.library_id, d.library_scoped, d.uploaded_by, d.uploaded_by_email';
    const doc = await documentAccess.getAccessibleDocument({ id: req.params.id, user: req.user, required: 'read', columns });
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    const writer = req.user.role === 'admin' || req.user.role === 'contributor';
    const full = writer && !!(await documentAccess.getAccessibleDocument({ id: doc.id, user: req.user, required: 'admin', columns: 'd.id' }));
    const library = doc.library_id
      ? await db.queryOne('SELECT id, name, owner_id, owner_email FROM libraries WHERE id = $1', [doc.library_id])
      : null;
    const managesLibrary = req.user.role === 'admin'
      || (req.user.role === 'contributor' && !!library?.owner_id && String(library.owner_id) === String(req.user.id));
    const detail = !doc.library_scoped || managesLibrary ? 'full' : 'hidden';
    res.json(await accessKeys.fileDoor(req.user, { doc, library, full, detail }));
  } catch (e) { serverError(res, e); }
});

// POST /api/access/folder-preview -- what moving, renaming or deleting a folder would do
// to who can open it, worked out without doing it. A batch, so dragging five folders is
// one round trip and one question.
//
// Each side is only shown to whoever manages that library: who would LOSE access belongs
// to the source's manager, who would GAIN it to the destination's. Otherwise someone with
// a Read-Write share on a folder in another person's library could use this to list
// everyone who has access there. A count is a probe too, so counts go with the side.
const OPS = new Set(['rename', 'reparent', 'delete', 'library_move']);
router.post('/folder-preview', auth, async (req, res) => {
  try {
    const ops = Array.isArray(req.body?.ops) ? req.body.ops.slice(0, 20) : [];
    if (!ops.length) return res.status(400).json({ error: 'ops required' });
    const out = [];
    for (const raw of ops) {
      const op = String(raw?.op || '');
      if (!OPS.has(op)) return res.status(400).json({ error: 'Unknown folder operation' });
      const libraryId = String(raw?.library_id || '');
      const path = folderLookupPath(raw?.path);
      if (!path) return res.status(400).json({ error: 'Bad folder path' });
      const source = await libraries.visibleLibrary(req.user, libraryId);
      if (!source) return res.status(404).json({ error: 'Library not found' });

      let newPath = null;
      let targetLibraryId = libraryId;
      if (op === 'rename') {
        // the same naming rule the rename itself applies, or the answer shown here would
        // be for a folder name the operation never creates
        newPath = folderPaths.renamedPath(path, raw?.name);
        if (!newPath) return res.status(400).json({ error: 'invalid name' });
      } else if (op === 'reparent') {
        const target = raw?.target === '' ? '' : folderLookupPath(raw?.target);
        if (target === null) return res.status(400).json({ error: 'invalid target' });
        newPath = target ? `${target}/${path.split('/').pop()}` : path.split('/').pop();
      } else if (op === 'library_move') {
        targetLibraryId = String(raw?.target_library_id || '');
        const target = await libraries.visibleLibrary(req.user, targetLibraryId);
        if (!target) return res.status(404).json({ error: 'Library not found' });
        newPath = path;
      }
      if (newPath && !canonicalFolderPath(newPath)) return res.status(400).json({ error: 'Bad folder path' });

      const targetLib = targetLibraryId === libraryId ? source : await libraries.visibleLibrary(req.user, targetLibraryId);
      out.push(await folderPreview.preview(
        { op, libraryId, path, newPath, targetLibraryId },
        { canManageSource: !!source.can_manage, canManageTarget: !!targetLib?.can_manage }
      ));
    }
    res.json({ previews: out });
  } catch (e) { serverError(res, e); }
});

module.exports = router;

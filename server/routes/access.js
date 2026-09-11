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

module.exports = router;

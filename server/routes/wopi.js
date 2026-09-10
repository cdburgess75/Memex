'use strict';
const { serverError } = require('../lib/httpError');
const express = require('express');
const router = express.Router();
const db = require('../lib/db');
const { validateToken, getLock, setLock, clearLock } = require('../lib/wopiTokens');
const storage = require('../lib/storage');
const { extractText } = require('../lib/textExtraction');
const notifications = require('../lib/notifications');
const emailEvents = require('../lib/emailEvents');
const auditLog = require('../lib/auditLog');
const docFollows = require('../lib/docFollows');
const documentAccess = require('../lib/documentAccess');
const { pruneOldVersions } = require('../lib/documentVersions');

function tokenEntry(req) {
  const entry = validateToken(req.query.access_token);
  return entry && String(entry.fileId) === String(req.params.fileId) ? entry : null;
}

// A WOPI token proves who opened the editor and for which file; it does NOT decide what
// they may do now. Tokens live for an hour and Collabora keeps calling for as long as
// the document is open, so every call re-checks access live: reading the file needs
// read access, saving or taking a lock needs write. Removing someone's access, taking
// them out of a group or demoting them therefore takes effect on their next save, not
// an hour later -- and a read-only session can't lock the file against real editors.
// Write also needs the token to have been minted for editing and the account to be an
// admin or contributor. A file trashed meanwhile is gone (404).
async function authorizeWopi(req, res, required) {
  const entry = tokenEntry(req);
  if (!entry) { res.status(401).json({ error: 'Invalid or expired access token' }); return null; }
  const actor = await documentAccess.resolveActor(entry.userId);
  const doc = actor && await documentAccess.getAccessibleDocument({
    id: entry.fileId, user: actor, required: 'read', columns: 'd.*', deleted: 'active',
  });
  if (!doc) { res.status(404).json({ error: 'Document not found' }); return null; }
  let canWrite = false;
  if (entry.canWrite && (actor.role === 'admin' || actor.role === 'contributor')) {
    canWrite = !!(await documentAccess.getAccessibleDocument({
      id: entry.fileId, user: actor, required: 'write', columns: 'd.id', deleted: 'active',
    }));
  }
  if (required === 'write' && !canWrite) { res.status(403).json({ error: 'No write permission for this document' }); return null; }
  return { entry, actor, doc, canWrite };
}

// PutFile's body is buffered (up to 50 MB) by express.raw; reject a missing or wrong
// token before that happens, so an unauthenticated caller can't make the server hold
// 50 MB per request. The full, live check still runs in the handler.
function tokenBeforeBody(req, res, next) {
  if (!tokenEntry(req)) return res.status(401).json({ error: 'Invalid or expired access token' });
  next();
}

async function saveDocumentVersion(doc, entry, source = 'wopi_save') {
  const path = require('path');
  const safeName = path.basename(doc.name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
  const versionNumber = await db.queryOne(
    'SELECT COALESCE(MAX(version_number), 0) + 1 AS next FROM document_versions WHERE document_id = $1',
    [doc.id]
  );
  const next = Number(versionNumber?.next || 1);
  const versionPath = `versions/${doc.id}/${String(next).padStart(4, '0')}-${Date.now()}-${safeName}`;
  await storage.copy(doc.storage_path, versionPath, doc.mime_type);
  await db.query(
    `INSERT INTO document_versions
     (document_id, version_number, name, size, mime_type, storage_path, document_text, saved_by, saved_by_email, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [doc.id, next, doc.name, doc.size || 0, doc.mime_type, versionPath, doc.document_text || null, entry.userId, entry.userEmail, source]
  );
  await auditLog.append({ documentId: doc.id, eventType: 'version_saved', actorId: entry.userId, actorEmail: entry.userEmail, detail: `${source} · version ${next}` });
  await pruneOldVersions(doc.id);
}

// GET /wopi/files/:fileId — CheckFileInfo
router.get('/files/:fileId', async (req, res) => {
  try {
    const ok = await authorizeWopi(req, res, 'read');
    if (!ok) return;
    const { entry, doc, canWrite } = ok;

    res.json({
      BaseFileName: doc.name,
      Size: doc.size,
      Version: doc.created_at,
      OwnerId: doc.uploaded_by,
      UserId: entry.userId,
      UserFriendlyName: entry.userEmail,
      UserCanWrite: canWrite,
      SupportsUpdate: true,
      SupportsLock: true,
      SupportsGetLock: true,
    });
  } catch (e) {
    serverError(res, e);
  }
});

// GET /wopi/files/:fileId/contents — GetFile
router.get('/files/:fileId/contents', async (req, res) => {
  try {
    const ok = await authorizeWopi(req, res, 'read');
    if (!ok) return;
    const { doc } = ok;

    const buffer = await storage.download(doc.storage_path);
    res.setHeader('Content-Type', doc.mime_type);
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
  } catch (e) {
    serverError(res, e);
  }
});

// POST /wopi/files/:fileId/contents — PutFile
router.post('/files/:fileId/contents', tokenBeforeBody, express.raw({ type: '*/*', limit: '50mb' }), async (req, res) => {
  try {
    // Checked live: a crafted PutFile from a read-only session, or from someone whose
    // access ended after they opened the editor, cannot overwrite the document.
    const ok = await authorizeWopi(req, res, 'write');
    if (!ok) return;
    const { entry, doc } = ok;

    const currentLock = getLock(req.params.fileId);
    const requestedLock = req.headers['x-wopi-lock'];
    if (currentLock && currentLock !== requestedLock) {
      res.setHeader('X-WOPI-Lock', currentLock);
      return res.status(409).end();
    }

    const buffer = req.body;
    await saveDocumentVersion(doc, entry, 'wopi_save');
    await storage.upload(doc.storage_path, buffer, doc.mime_type);
    let documentText = null;
    let textExtracted = false;
    try {
      documentText = await extractText(buffer, doc.name);
      textExtracted = true;
    } catch (e) {
      console.error('Text extraction after WOPI save failed (non-fatal):', e.message);
    }
    if (textExtracted) {
      await db.query('UPDATE documents SET size = $1, document_text = $2 WHERE id = $3', [buffer.length, documentText, doc.id]);
    } else {
      await db.query('UPDATE documents SET size = $1 WHERE id = $2', [buffer.length, doc.id]);
    }
    await auditLog.append({ documentId: doc.id, eventType: 'updated', actorId: entry.userId, actorEmail: entry.userEmail, detail: `Office save · ${buffer.length} bytes` });
    // Notify the owner that a collaborator edited their file. Office editors
    // autosave often, so dedupe to at most one ping per 30 min per document.
    // Only while the uploader can still read the file: once their access has ended
    // (their share on the library removed, say), telling them who edited it, and what
    // it is called, would leak both.
    const ownerCanRead = doc.uploaded_by_email
      ? (await documentAccess.readersAmong([doc.id], [doc.uploaded_by_email])).get(doc.uploaded_by_email.toLowerCase())?.has(String(doc.id))
      : false;
    if (ownerCanRead && doc.uploaded_by_email.toLowerCase() !== String(entry.userEmail || '').toLowerCase()) {
      try {
        await notifications.create({
          userId: doc.uploaded_by || null,
          userEmail: doc.uploaded_by_email,
          type: 'document_edited',
          title: `${entry.userEmail} edited your file`,
          body: `"${doc.name}"`,
          refType: 'document',
          refId: doc.id,
          dedupeMinutes: 30,
        });
      } catch (e) { console.error('notification (document_edited) failed:', e.message); }
      emailEvents.send('document_edited', {
        to: doc.uploaded_by_email,
        subject: `${entry.userEmail} edited your file: ${doc.name}`,
        text: `${entry.userEmail} edited "${doc.name}" in Depot.\n\nSign in to Depot to review the changes.`,
        // Collabora calls this endpoint, not the browser — the editing member's
        // identity comes from the WOPI token, not req.user.
        actorEmail: entry.userEmail,
      }).catch(() => {});
    }
    // Also notify anyone FOLLOWING this file (the file bell), minus the editor.
    // Same 30-min dedupe so autosave storms don't spam followers.
    docFollows.followersOf(doc.id, entry.userEmail).then((followers) => {
      for (const to of followers) {
        if (doc.uploaded_by_email && to.toLowerCase() === doc.uploaded_by_email.toLowerCase()) continue; // owner already notified
        notifications.create({ userEmail: to, type: 'document_edited', title: `A file you follow was edited: ${doc.name}`, body: `"${doc.name}"`, refType: 'document', refId: doc.id, dedupeMinutes: 30 }).catch(() => {});
        emailEvents.send('document_edited', { to, subject: `A file you follow was edited: ${doc.name}`, text: `${entry.userEmail} edited "${doc.name}" in Depot.` }).catch(() => {});
      }
    }).catch(() => {});
    res.status(200).end();
  } catch (e) {
    serverError(res, e);
  }
});

// POST /wopi/files/:fileId — Operations (Lock, Unlock, etc.)
router.post('/files/:fileId', async (req, res) => {
  const override = req.headers['x-wopi-override'];
  // Reading the lock is harmless; taking, refreshing or releasing one is an edit --
  // otherwise a read-only session could lock the file and block everyone's saves.
  let ok;
  try { ok = await authorizeWopi(req, res, override === 'GET_LOCK' ? 'read' : 'write'); }
  catch (e) { return serverError(res, e); }
  if (!ok) return;

  const requestedLock = req.headers['x-wopi-lock'];
  const fileId = req.params.fileId;

  switch (override) {
    case 'LOCK': {
      const currentLock = getLock(fileId);
      if (currentLock && currentLock !== requestedLock) {
        res.setHeader('X-WOPI-Lock', currentLock);
        return res.status(409).end();
      }
      setLock(fileId, requestedLock);
      res.setHeader('X-WOPI-Lock', requestedLock);
      return res.status(200).end();
    }
    case 'GET_LOCK': {
      res.setHeader('X-WOPI-Lock', getLock(fileId) || '');
      return res.status(200).end();
    }
    case 'REFRESH_LOCK': {
      const currentLock = getLock(fileId);
      if (!currentLock || currentLock !== requestedLock) {
        res.setHeader('X-WOPI-Lock', currentLock || '');
        return res.status(409).end();
      }
      setLock(fileId, requestedLock);
      return res.status(200).end();
    }
    case 'UNLOCK': {
      const currentLock = getLock(fileId);
      if (!currentLock || currentLock !== requestedLock) {
        res.setHeader('X-WOPI-Lock', currentLock || '');
        return res.status(409).end();
      }
      clearLock(fileId);
      return res.status(200).end();
    }
    case 'UNLOCK_AND_RELOCK': {
      const oldLock = req.headers['x-wopi-old-lock'];
      const currentLock = getLock(fileId);
      if (currentLock && currentLock !== oldLock) {
        res.setHeader('X-WOPI-Lock', currentLock);
        return res.status(409).end();
      }
      clearLock(fileId);
      setLock(fileId, requestedLock);
      return res.status(200).end();
    }
    default:
      return res.status(501).end();
  }
});

module.exports = router;

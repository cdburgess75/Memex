'use strict';
const express = require('express');
const router = express.Router();
const db = require('../lib/db');
const { validateToken, getLock, setLock, clearLock } = require('../lib/wopiTokens');
const storage = require('../lib/storage');
const { extractText } = require('../lib/textExtraction');
const notifications = require('../lib/notifications');
const emailEvents = require('../lib/emailEvents');

function validateFileToken(req, res) {
  const entry = validateToken(req.query.access_token);
  if (!entry || String(entry.fileId) !== String(req.params.fileId)) {
    res.status(401).json({ error: 'Invalid or expired access token' });
    return null;
  }
  return entry;
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
  await db.query(
    'INSERT INTO document_events (document_id, event_type, actor_id, actor_email, detail) VALUES ($1, $2, $3, $4, $5)',
    [doc.id, 'version_saved', entry.userId, entry.userEmail, `${source} · version ${next}`]
  );
}

// GET /wopi/files/:fileId — CheckFileInfo
router.get('/files/:fileId', async (req, res) => {
  const entry = validateFileToken(req, res);
  if (!entry) return;

  try {
    const doc = await db.queryOne('SELECT * FROM documents WHERE id = $1', [req.params.fileId]);
    if (!doc) return res.status(404).json({ error: 'Document not found' });

    res.json({
      BaseFileName: doc.name,
      Size: doc.size,
      Version: doc.created_at,
      OwnerId: doc.uploaded_by,
      UserId: entry.userId,
      UserFriendlyName: entry.userEmail,
      UserCanWrite: true,
      SupportsUpdate: true,
      SupportsLock: true,
      SupportsGetLock: true,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /wopi/files/:fileId/contents — GetFile
router.get('/files/:fileId/contents', async (req, res) => {
  const entry = validateFileToken(req, res);
  if (!entry) return;

  try {
    const doc = await db.queryOne('SELECT * FROM documents WHERE id = $1', [req.params.fileId]);
    if (!doc) return res.status(404).json({ error: 'Document not found' });

    const buffer = await storage.download(doc.storage_path);
    res.setHeader('Content-Type', doc.mime_type);
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /wopi/files/:fileId/contents — PutFile
router.post('/files/:fileId/contents', express.raw({ type: '*/*', limit: '50mb' }), async (req, res) => {
  const entry = validateFileToken(req, res);
  if (!entry) return;

  try {
    const doc = await db.queryOne('SELECT * FROM documents WHERE id = $1', [req.params.fileId]);
    if (!doc) return res.status(404).json({ error: 'Document not found' });

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
    await db.query(
      'INSERT INTO document_events (document_id, event_type, actor_id, actor_email, detail) VALUES ($1, $2, $3, $4, $5)',
      [doc.id, 'updated', entry.userId, entry.userEmail, `Office save · ${buffer.length} bytes`]
    );
    // Notify the owner that a collaborator edited their file. Office editors
    // autosave often, so dedupe to at most one ping per 30 min per document.
    if (doc.uploaded_by_email && doc.uploaded_by_email.toLowerCase() !== String(entry.userEmail || '').toLowerCase()) {
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
        text: `${entry.userEmail} edited "${doc.name}" in Memex.\n\nSign in to Memex to review the changes.`,
      }).catch(() => {});
    }
    res.status(200).end();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /wopi/files/:fileId — Operations (Lock, Unlock, etc.)
router.post('/files/:fileId', async (req, res) => {
  const entry = validateFileToken(req, res);
  if (!entry) return;

  const override = req.headers['x-wopi-override'];
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

'use strict';
const express = require('express');
const router = express.Router();
const db = require('../lib/db');
const { validateToken, getLock, setLock, clearLock } = require('../lib/wopiTokens');
const storage = require('../lib/storage');
const { extractText } = require('../lib/textExtraction');

// GET /wopi/files/:fileId — CheckFileInfo
router.get('/files/:fileId', async (req, res) => {
  const entry = validateToken(req.query.access_token);
  if (!entry) return res.status(401).json({ error: 'Invalid or expired access token' });

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
  const entry = validateToken(req.query.access_token);
  if (!entry) return res.status(401).json({ error: 'Invalid or expired access token' });

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
  const entry = validateToken(req.query.access_token);
  if (!entry) return res.status(401).json({ error: 'Invalid or expired access token' });

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
    res.status(200).end();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /wopi/files/:fileId — Operations (Lock, Unlock, etc.)
router.post('/files/:fileId', async (req, res) => {
  const entry = validateToken(req.query.access_token);
  if (!entry) return res.status(401).json({ error: 'Invalid or expired access token' });

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

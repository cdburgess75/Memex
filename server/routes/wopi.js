const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const { validateToken, getLock, setLock, clearLock } = require('../lib/wopiTokens');

function db() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

// GET /wopi/files/:fileId — CheckFileInfo
router.get('/files/:fileId', async (req, res) => {
  const token = req.query.access_token;
  const entry = validateToken(token);
  if (!entry) return res.status(401).json({ error: 'Invalid or expired access token' });

  const client = db();
  const { data: doc, error } = await client
    .from('documents')
    .select('*')
    .eq('id', req.params.fileId)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
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
});

// GET /wopi/files/:fileId/contents — GetFile
router.get('/files/:fileId/contents', async (req, res) => {
  const token = req.query.access_token;
  const entry = validateToken(token);
  if (!entry) return res.status(401).json({ error: 'Invalid or expired access token' });

  const client = db();
  const { data: doc, error: docError } = await client
    .from('documents')
    .select('*')
    .eq('id', req.params.fileId)
    .maybeSingle();

  if (docError) return res.status(500).json({ error: docError.message });
  if (!doc) return res.status(404).json({ error: 'Document not found' });

  const { data: fileData, error: downloadError } = await client.storage
    .from('documents')
    .download(doc.storage_path);

  if (downloadError) return res.status(500).json({ error: downloadError.message });

  const buffer = Buffer.from(await fileData.arrayBuffer());

  res.setHeader('Content-Type', doc.mime_type);
  res.setHeader('Content-Length', buffer.length);
  res.send(buffer);
});

// POST /wopi/files/:fileId/contents — PutFile
router.post('/files/:fileId/contents', express.raw({ type: '*/*', limit: '50mb' }), async (req, res) => {
  const token = req.query.access_token;
  const entry = validateToken(token);
  if (!entry) return res.status(401).json({ error: 'Invalid or expired access token' });

  const client = db();
  const { data: doc, error: docError } = await client
    .from('documents')
    .select('*')
    .eq('id', req.params.fileId)
    .maybeSingle();

  if (docError) return res.status(500).json({ error: docError.message });
  if (!doc) return res.status(404).json({ error: 'Document not found' });

  // Check that there's an active lock (or it's a new/empty file)
  const currentLock = getLock(req.params.fileId);
  const requestedLock = req.headers['x-wopi-lock'];
  if (currentLock && currentLock !== requestedLock) {
    res.setHeader('X-WOPI-Lock', currentLock);
    return res.status(409).end();
  }

  const buffer = req.body;

  // Upload to Supabase Storage (upsert)
  const { error: uploadError } = await client.storage
    .from('documents')
    .upload(doc.storage_path, buffer, { contentType: doc.mime_type, upsert: true });

  if (uploadError) return res.status(500).json({ error: uploadError.message });

  // Update size in documents table
  await client
    .from('documents')
    .update({ size: buffer.length })
    .eq('id', doc.id);

  res.status(200).end();
});

// POST /wopi/files/:fileId — Operations (Lock, Unlock, etc.)
router.post('/files/:fileId', async (req, res) => {
  const token = req.query.access_token;
  const entry = validateToken(token);
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
      const currentLock = getLock(fileId);
      res.setHeader('X-WOPI-Lock', currentLock || '');
      return res.status(200).end();
    }

    case 'REFRESH_LOCK': {
      const currentLock = getLock(fileId);
      if (!currentLock || currentLock !== requestedLock) {
        res.setHeader('X-WOPI-Lock', currentLock || '');
        return res.status(409).end();
      }
      // Refresh expiry by re-setting with the same token
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

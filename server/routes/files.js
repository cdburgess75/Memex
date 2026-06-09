'use strict';
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const multer = require('multer');
const Anthropic = require('@anthropic-ai/sdk');
const { generateToken } = require('../lib/wopiTokens');
const storage = require('../lib/storage');
const db = require('../lib/db');
const settings = require('../lib/settings');
const { extractText } = require('../lib/textExtraction');

const DOCUMENT_COLUMNS = `
  id, name, size, mime_type, storage_path, google_drive_id, uploaded_by,
  uploaded_by_email, created_at, deleted_at, deleted_by, deleted_by_email,
  restored_at, restored_by, restored_by_email
`;

const ALLOWED_FILE_EXTS = ['.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt', '.pdf', '.txt', '.md', '.csv'];

function cleanDisplayName(name) {
  return String(name || '')
    .split(/[\\/]+/)
    .map(part => part.trim().replace(/[^a-zA-Z0-9._ -]/g, '_').replace(/^\.+$/, '_'))
    .filter(Boolean)
    .join('/');
}

function fileExt(name) {
  const ext = require('path').extname(String(name || '')).toLowerCase();
  return ext;
}

function isAllowedFile(name) {
  return ALLOWED_FILE_EXTS.includes(fileExt(name));
}

function fileSizeLabelForEvent(size) {
  const n = Number(size || 0);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) { value /= 1024; idx += 1; }
  return `${value >= 10 || idx === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[idx]}`;
}

async function maxUploadMb() {
  const mb = parseInt(await settings.getOrEnv('max_upload_mb') || '50', 10);
  return Number.isFinite(mb) && mb > 0 ? mb : 50;
}

let _uploadMb = 0;
let _uploadMw = null;
async function getUpload() {
  const mb = await maxUploadMb();
  if (mb !== _uploadMb || !_uploadMw) {
    _uploadMb = mb;
    _uploadMw = multer({
      storage: multer.memoryStorage(),
      limits: { fileSize: mb * 1024 * 1024 },
      fileFilter(_req, file, cb) {
        cb(null, isAllowedFile(file.originalname));
      }
    }).single('file');
  }
  return _uploadMw;
}

async function anthropic() {
  return new Anthropic({ apiKey: await settings.getOrEnv('anthropic_api_key') });
}

async function MODEL() {
  return (await settings.getOrEnv('anthropic_model')) || 'claude-sonnet-4-6';
}

function buildContext(pages) {
  return (pages || [])
    .filter(p => p.id !== 'overview')
    .map(p => `### [[${p.title}]]  (${p.category})\n${p.content}`)
    .join('\n\n---\n\n');
}

async function logEvent(event, userId, userEmail) {
  await db.query(
    'INSERT INTO activity_log (event, user_id, user_email) VALUES ($1, $2, $3)',
    [event, userId, userEmail]
  );
}

async function logDocumentEvent(documentId, eventType, userId, userEmail, detail = null) {
  await db.query(
    'INSERT INTO document_events (document_id, event_type, actor_id, actor_email, detail) VALUES ($1, $2, $3, $4, $5)',
    [documentId, eventType, userId, userEmail, detail]
  );
}

async function trashRetentionDays() {
  const days = parseInt(await settings.getOrEnv('trash_retention_days') || '30', 10);
  return Number.isFinite(days) && days > 0 ? days : 30;
}

async function saveDocumentVersion(doc, user, source = 'replace') {
  const path = require('path');
  const safeName = path.basename(doc.name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
  const versionNumber = await db.queryOne(
    'SELECT COALESCE(MAX(version_number), 0) + 1 AS next FROM document_versions WHERE document_id = $1',
    [doc.id]
  );
  const next = Number(versionNumber?.next || 1);
  const versionPath = `versions/${doc.id}/${String(next).padStart(4, '0')}-${Date.now()}-${safeName}`;
  await storage.copy(doc.storage_path, versionPath, doc.mime_type);
  const version = await db.queryOne(
    `INSERT INTO document_versions
     (document_id, version_number, name, size, mime_type, storage_path, document_text, saved_by, saved_by_email, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id, document_id, version_number, name, size, mime_type, saved_at, saved_by_email, source`,
    [doc.id, next, doc.name, doc.size || 0, doc.mime_type, versionPath, doc.document_text || null, user.id, user.email, source]
  );
  await logDocumentEvent(doc.id, 'version_saved', user.id, user.email, `${source} · version ${next}`);
  return version;
}

// GET /api/files/local-download — serve file using short-lived token (local storage only)
router.get('/local-download', async (req, res) => {
  const entry = storage.validateLocalToken(req.query.token);
  if (!entry) return res.status(401).json({ error: 'Invalid or expired download token' });

  let buffer;
  try {
    buffer = await storage.download(entry.storagePath);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  const path = require('path');
  res.setHeader('Content-Disposition', `attachment; filename="${path.basename(entry.storagePath)}"`);
  res.send(buffer);
});

// GET /api/files
router.get('/', auth, async (req, res) => {
  try {
    const rows = await db.query(`SELECT ${DOCUMENT_COLUMNS} FROM documents WHERE deleted_at IS NULL ORDER BY created_at DESC`);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/files/trash — list soft-deleted documents (admin/contributor)
router.get('/trash', auth, requireRole('admin', 'contributor'), async (req, res) => {
  try {
    const rows = await db.query(`SELECT ${DOCUMENT_COLUMNS} FROM documents WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC`);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/files/search?q=text — full-text search uploaded document text
router.get('/search', auth, async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json([]);

  try {
    const rows = await db.query(
      'SELECT * FROM search_documents($1)',
      [q]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/files/upload
router.post('/upload', auth, requireRole('admin', 'contributor'), (req, res, next) => getUpload().then(mw => mw(req, res, next)).catch(next), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file required' });

  const path = require('path');
  const { buffer, originalname, mimetype, size } = req.file;
  const displayName = cleanDisplayName(req.body.displayName) || cleanDisplayName(originalname) || 'upload';
  const sanitizedName = path.basename(displayName).replace(/[^a-zA-Z0-9._-]/g, '_');
  const storagePath = `documents/${Date.now()}-${sanitizedName}`;

  try {
    await storage.upload(storagePath, buffer, mimetype);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  try {
    let canIngest = false;
    let documentText = null;
    try {
      documentText = await extractText(buffer, displayName);
      canIngest = documentText !== null && documentText.trim().length > 0;
    } catch (e) {
      console.error('Text extraction failed (non-fatal):', e.message);
    }

    const doc = await db.queryOne(
      `INSERT INTO documents (name, size, mime_type, storage_path, uploaded_by, uploaded_by_email, document_text)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${DOCUMENT_COLUMNS}`,
      [displayName, size, mimetype, storagePath, req.user.id, req.user.email, documentText]
    );
    await logDocumentEvent(doc.id, 'uploaded', req.user.id, req.user.email, `${fileSizeLabelForEvent(size)} · ${displayName}`);

    res.json({ doc, canIngest });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/files/upload-stream — stream request body directly into storage.
// The legacy multipart route above remains for compatibility, but the file-home
// UI uses this route so large files do not sit in server memory before writing.
router.post('/upload-stream', auth, requireRole('admin', 'contributor'), async (req, res) => {
  const path = require('path');
  const rawName = req.query.displayName || req.headers['x-file-name'];
  const displayName = cleanDisplayName(rawName) || 'upload';
  if (!isAllowedFile(displayName)) return res.status(415).json({ error: 'File type not allowed' });

  const sanitizedName = path.basename(displayName).replace(/[^a-zA-Z0-9._-]/g, '_');
  const storagePath = `documents/${Date.now()}-${sanitizedName}`;
  const mimetype = String(req.headers['content-type'] || 'application/octet-stream').split(';')[0] || 'application/octet-stream';
  const declaredSize = Number.parseInt(req.headers['content-length'] || '0', 10);

  let storedSize = declaredSize;
  try {
    const result = await storage.uploadStream(storagePath, req, mimetype);
    if (result && Number.isFinite(result.size) && result.size >= 0) storedSize = result.size;
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  try {
    let canIngest = false;
    let documentText = null;
    const extractionLimit = (await maxUploadMb()) * 1024 * 1024;
    if (storedSize > 0 && storedSize <= extractionLimit) {
      try {
        const buffer = await storage.download(storagePath);
        documentText = await extractText(buffer, displayName);
        canIngest = documentText !== null && documentText.trim().length > 0;
      } catch (e) {
        console.error('Text extraction failed (non-fatal):', e.message);
      }
    }

    const doc = await db.queryOne(
      `INSERT INTO documents (name, size, mime_type, storage_path, uploaded_by, uploaded_by_email, document_text)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${DOCUMENT_COLUMNS}`,
      [displayName, storedSize || 0, mimetype, storagePath, req.user.id, req.user.email, documentText]
    );
    await logDocumentEvent(doc.id, 'uploaded', req.user.id, req.user.email, `${fileSizeLabelForEvent(storedSize || 0)} · streamed upload`);

    res.json({ doc, canIngest, streamed: true });
  } catch (e) {
    await storage.del(storagePath).catch(() => {});
    res.status(500).json({ error: e.message });
  }
});

// POST /api/files/:id/ingest
router.post('/:id/ingest', auth, requireRole('admin', 'contributor'), async (req, res) => {
  const { focus } = req.body;

  try {
    const doc = await db.queryOne(`SELECT ${DOCUMENT_COLUMNS}, document_text FROM documents WHERE id = $1`, [req.params.id]);
    if (!doc) return res.status(404).json({ error: 'Document not found' });

    let buffer;
    try {
      buffer = await storage.download(doc.storage_path);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }

    let text;
    try {
      text = doc.document_text || await extractText(buffer, doc.name);
    } catch (e) {
      return res.status(422).json({ error: `Text extraction failed: ${e.message}` });
    }

    if (!text || !text.trim()) {
      return res.status(422).json({ error: 'Could not extract text from this file' });
    }

    const pages = await db.query('SELECT * FROM pages');
    const ctx = buildContext(pages);

    const system = `You maintain a team knowledge base. Ingest the source the user provides.

Existing pages:
${ctx || '(empty — this is the first source)'}

Return ONLY valid JSON, no markdown fences, in this shape:
{"summary":"2-3 sentence summary","pages":[{"id":"kebab-slug","title":"Page Title","category":"concept|entity|source|analysis","content":"# Page Title\\n\\nMarkdown body. Use [[Page Title]] to link related pages. Use ## for subheads and - for bullets."}]}

Create or update 2-4 pages. Prefer updating an existing page (reuse its exact id) when the source adds to it. Always include one "source" page summarizing this document. Cross-link generously with [[page links]].${focus ? '\nUser emphasis: ' + focus : ''}`;

    const [ai, model] = await Promise.all([anthropic(), MODEL()]);
    const message = await ai.messages.create({
      model,
      max_tokens: 1400,
      system,
      messages: [{ role: 'user', content: 'Source:\n\n' + text.slice(0, 8000) }],
    });

    await db.query(
      'INSERT INTO api_usage (user_id, user_email, operation, model, input_tokens, output_tokens) VALUES ($1, $2, $3, $4, $5, $6)',
      [req.user.id, req.user.email, 'ingest', model, message.usage.input_tokens, message.usage.output_tokens]
    );

    const raw = message.content.map(b => b.text || '').join('');
    let parsed;
    try {
      parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    } catch {
      return res.status(422).json({ error: 'Claude returned invalid JSON — try again' });
    }

    const touched = [];
    for (const p of (parsed.pages || [])) {
      const existing = await db.queryOne('SELECT id, sources FROM pages WHERE id = $1', [p.id]);
      let row;
      if (existing) {
        row = await db.queryOne(
          `UPDATE pages SET title = $1, category = $2, content = $3, sources = $4,
           updated_at = $5, updated_by = $6 WHERE id = $7 RETURNING *`,
          [p.title, p.category, p.content, (existing.sources || 0) + 1, new Date().toISOString(), req.user.id, p.id]
        );
      } else {
        row = await db.queryOne(
          `INSERT INTO pages (id, title, category, content, sources, created_by, updated_by)
           VALUES ($1, $2, $3, $4, 1, $5, $6) RETURNING *`,
          [p.id, p.title, p.category, p.content, req.user.id, req.user.id]
        );
      }
      if (row) touched.push(row);
    }

    await logEvent(`ingest · ${touched.length} pages · ${parsed.pages?.[0]?.title || doc.name}`, req.user.id, req.user.email);
    res.json({ summary: parsed.summary, pages: touched });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/files/:id/url
router.get('/:id/url', auth, async (req, res) => {
  try {
    const doc = await db.queryOne(`SELECT ${DOCUMENT_COLUMNS}, document_text FROM documents WHERE id = $1`, [req.params.id]);
    if (!doc) return res.status(404).json({ error: 'Document not found' });

    const url = await storage.getUrl(doc.storage_path, 3600);
    await logEvent(`download · ${doc.name}`, req.user.id, req.user.email);
    res.json({ url, name: doc.name });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/files/:id/office
router.get('/:id/office', auth, async (req, res) => {
  try {
    const doc = await db.queryOne(`SELECT ${DOCUMENT_COLUMNS}, document_text FROM documents WHERE id = $1`, [req.params.id]);
    if (!doc) return res.status(404).json({ error: 'Document not found' });

    const signedUrl = await storage.getUrl(doc.storage_path, 3600);
    const ext = doc.name.split('.').pop().toLowerCase();

    const viewUrl = `https://view.officeapps.live.com/op/view.aspx?src=${encodeURIComponent(signedUrl)}`;

    let editUrl = null;
    const appUrl = process.env.APP_URL;
    if (appUrl) {
      const wopiApps = {
        docx: 'https://word-edit.officeapps.live.com/op/edit.aspx',
        doc:  'https://word-edit.officeapps.live.com/op/edit.aspx',
        xlsx: 'https://excel.officeapps.live.com/op/edit.aspx',
        xls:  'https://excel.officeapps.live.com/op/edit.aspx',
        pptx: 'https://powerpoint.officeapps.live.com/op/edit.aspx',
        ppt:  'https://powerpoint.officeapps.live.com/op/edit.aspx',
      };
      const wopiApp = wopiApps[ext];
      if (wopiApp) {
        const token = generateToken(doc.id, req.user.id, req.user.email);
        const wopiSrc = encodeURIComponent(`${appUrl}/wopi/files/${doc.id}`);
        editUrl = `${wopiApp}?WOPISrc=${wopiSrc}&access_token=${token}`;
      }
    }

    await logEvent(`view · ${doc.name}`, req.user.id, req.user.email);
    res.json({ viewUrl, editUrl, ext });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/files/:id/google
router.post('/:id/google', auth, async (req, res) => {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
    return res.status(400).json({
      error: 'Google Drive integration is not configured. Set GOOGLE_SERVICE_ACCOUNT_KEY in your environment.'
    });
  }

  try {
    const doc = await db.queryOne(`SELECT ${DOCUMENT_COLUMNS} FROM documents WHERE id = $1`, [req.params.id]);
    if (!doc) return res.status(404).json({ error: 'Document not found' });

    let buffer;
    try {
      buffer = await storage.download(doc.storage_path);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
    const ext = doc.name.split('.').pop().toLowerCase();

    const googleMimeTypes = {
      docx: 'application/vnd.google-apps.document',
      doc:  'application/vnd.google-apps.document',
      xlsx: 'application/vnd.google-apps.spreadsheet',
      xls:  'application/vnd.google-apps.spreadsheet',
      pptx: 'application/vnd.google-apps.presentation',
      ppt:  'application/vnd.google-apps.presentation',
    };

    const { google } = require('googleapis');

    let credentials;
    try {
      credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
    } catch {
      return res.status(500).json({ error: 'Invalid GOOGLE_SERVICE_ACCOUNT_KEY — must be valid JSON' });
    }

    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/drive'],
    });

    const drive = google.drive({ version: 'v3', auth });

    const fileMetadata = {
      name: doc.name,
      mimeType: googleMimeTypes[ext] || doc.mime_type,
      ...(process.env.GOOGLE_DRIVE_FOLDER_ID ? { parents: [process.env.GOOGLE_DRIVE_FOLDER_ID] } : {}),
    };

    const { Readable } = require('stream');
    const { data: driveFile } = await drive.files.create({
      requestBody: fileMetadata,
      media: { mimeType: doc.mime_type, body: Readable.from(buffer) },
      fields: 'id, webViewLink',
    });

    try {
      await drive.permissions.create({
        fileId: driveFile.id,
        requestBody: { type: 'user', role: 'writer', emailAddress: req.user.email },
      });
    } catch (shareErr) {
      console.error('Google Drive share failed (non-fatal):', shareErr.message);
    }

    await db.query('UPDATE documents SET google_drive_id = $1 WHERE id = $2', [driveFile.id, doc.id]);
    res.json({ editUrl: driveFile.webViewLink, driveId: driveFile.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/files/:id/google/export
router.post('/:id/google/export', auth, requireRole('admin', 'contributor'), async (req, res) => {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
    return res.status(400).json({
      error: 'Google Drive integration is not configured. Set GOOGLE_SERVICE_ACCOUNT_KEY in your environment.'
    });
  }

  try {
    const doc = await db.queryOne(`SELECT ${DOCUMENT_COLUMNS} FROM documents WHERE id = $1`, [req.params.id]);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    if (!doc.google_drive_id) return res.status(400).json({ error: 'Document has not been pushed to Google Drive' });

    const ext = doc.name.split('.').pop().toLowerCase();
    const exportMimeTypes = {
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      doc:  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      xls:  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      ppt:  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    };
    const exportMime = exportMimeTypes[ext];
    if (!exportMime) return res.status(400).json({ error: `Export not supported for .${ext} files` });

    const { google } = require('googleapis');

    let credentials;
    try {
      credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
    } catch {
      return res.status(500).json({ error: 'Invalid GOOGLE_SERVICE_ACCOUNT_KEY — must be valid JSON' });
    }

    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/drive'],
    });
    const drive = google.drive({ version: 'v3', auth });

    const { data: exportStream } = await drive.files.export(
      { fileId: doc.google_drive_id, mimeType: exportMime },
      { responseType: 'stream' }
    );

    const chunks = [];
    await new Promise((resolve, reject) => {
      exportStream.on('data', chunk => chunks.push(chunk));
      exportStream.on('end', resolve);
      exportStream.on('error', reject);
    });
    const buffer = Buffer.concat(chunks);

    await saveDocumentVersion(doc, req.user, 'google_export');
    await storage.upload(doc.storage_path, buffer, exportMime);
    let documentText = null;
    let textExtracted = false;
    try {
      documentText = await extractText(buffer, doc.name);
      textExtracted = true;
    } catch (e) {
      console.error('Text extraction after Google export failed (non-fatal):', e.message);
    }
    if (textExtracted) {
      await db.query('UPDATE documents SET size = $1, mime_type = $2, document_text = $3 WHERE id = $4', [buffer.length, exportMime, documentText, doc.id]);
    } else {
      await db.query('UPDATE documents SET size = $1, mime_type = $2 WHERE id = $3', [buffer.length, exportMime, doc.id]);
    }
    await logDocumentEvent(doc.id, 'updated', req.user.id, req.user.email, `Google export · ${fileSizeLabelForEvent(buffer.length)}`);
    res.json({ success: true, size: buffer.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/files/:id/history — admin-only file audit timeline and versions
router.get('/:id/history', auth, requireRole('admin'), async (req, res) => {
  try {
    const doc = await db.queryOne(`SELECT ${DOCUMENT_COLUMNS} FROM documents WHERE id = $1`, [req.params.id]);
    if (!doc) return res.status(404).json({ error: 'Document not found' });

    const [events, versions, retention] = await Promise.all([
      db.query(
        `SELECT id, event_type, actor_email, detail, created_at
         FROM document_events
         WHERE document_id = $1
         ORDER BY created_at DESC
         LIMIT 100`,
        [req.params.id]
      ),
      db.query(
        `SELECT id, version_number, name, size, mime_type, saved_at, saved_by_email, source
         FROM document_versions
         WHERE document_id = $1
         ORDER BY version_number DESC`,
        [req.params.id]
      ),
      trashRetentionDays()
    ]);

    res.json({ doc, events, versions, retention_days: retention });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/files/:id/restore-version/:versionId — restore a previous stored file version
router.post('/:id/restore-version/:versionId', auth, requireRole('admin', 'contributor'), async (req, res) => {
  try {
    const doc = await db.queryOne(`SELECT ${DOCUMENT_COLUMNS}, document_text FROM documents WHERE id = $1`, [req.params.id]);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    const version = await db.queryOne(
      `SELECT id, version_number, name, size, mime_type, storage_path, document_text
       FROM document_versions
       WHERE id = $1 AND document_id = $2`,
      [req.params.versionId, req.params.id]
    );
    if (!version) return res.status(404).json({ error: 'Version not found' });

    await saveDocumentVersion(doc, req.user, 'before_version_restore');
    await storage.copy(version.storage_path, doc.storage_path, version.mime_type);
    const updated = await db.queryOne(
      `UPDATE documents
       SET name = $1, size = $2, mime_type = $3, document_text = $4,
           deleted_at = NULL, deleted_by = NULL, deleted_by_email = NULL,
           restored_at = NOW(), restored_by = $5, restored_by_email = $6
       WHERE id = $7
       RETURNING ${DOCUMENT_COLUMNS}`,
      [version.name, version.size || 0, version.mime_type, version.document_text || null, req.user.id, req.user.email, doc.id]
    );

    await logDocumentEvent(doc.id, 'version_restored', req.user.id, req.user.email, `restored version ${version.version_number}`);
    await logEvent(`version restore · ${updated.name} · v${version.version_number}`, req.user.id, req.user.email);
    res.json({ doc: updated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/files/:id
// DELETE /api/files/:id — soft-delete (move to trash); storage object is retained
router.delete('/:id', auth, requireRole('admin', 'contributor'), async (req, res) => {
  try {
    const doc = await db.queryOne(`SELECT ${DOCUMENT_COLUMNS} FROM documents WHERE id = $1 AND deleted_at IS NULL`, [req.params.id]);
    if (!doc) return res.status(404).json({ error: 'Document not found' });

    await db.query('UPDATE documents SET deleted_at = NOW(), deleted_by = $2, deleted_by_email = $3 WHERE id = $1', [req.params.id, req.user.id, req.user.email]);
    await logDocumentEvent(doc.id, 'trashed', req.user.id, req.user.email, `retention ${await trashRetentionDays()} days`);
    await logEvent(`trash · ${doc.name}`, req.user.id, req.user.email);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/files/:id/restore — restore a soft-deleted document from trash
router.post('/:id/restore', auth, requireRole('admin', 'contributor'), async (req, res) => {
  try {
    const doc = await db.queryOne(`SELECT ${DOCUMENT_COLUMNS} FROM documents WHERE id = $1 AND deleted_at IS NOT NULL`, [req.params.id]);
    if (!doc) return res.status(404).json({ error: 'Document not found in trash' });

    await db.query(
      `UPDATE documents
       SET deleted_at = NULL, deleted_by = NULL, deleted_by_email = NULL,
           restored_at = NOW(), restored_by = $2, restored_by_email = $3
       WHERE id = $1`,
      [req.params.id, req.user.id, req.user.email]
    );
    await logDocumentEvent(doc.id, 'restored', req.user.id, req.user.email, 'restored from trash');
    await logEvent(`restore · ${doc.name}`, req.user.id, req.user.email);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/files/:id/purge — permanently delete a trashed document (admin only)
router.delete('/:id/purge', auth, requireRole('admin'), async (req, res) => {
  try {
    const doc = await db.queryOne(`SELECT ${DOCUMENT_COLUMNS} FROM documents WHERE id = $1 AND deleted_at IS NOT NULL`, [req.params.id]);
    if (!doc) return res.status(404).json({ error: 'Document not found in trash' });

    await logDocumentEvent(doc.id, 'purged', req.user.id, req.user.email, 'permanent delete');
    await storage.del(doc.storage_path);
    await db.query('DELETE FROM documents WHERE id = $1', [req.params.id]);
    await logEvent(`purge · ${doc.name}`, req.user.id, req.user.email);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

'use strict';
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const { makeUploadMiddleware } = require('../lib/upload');
const Anthropic = require('@anthropic-ai/sdk');
const { generateToken } = require('../lib/wopiTokens');
const storage = require('../lib/storage');
const db = require('../lib/db');
const settings = require('../lib/settings');

const getUpload = makeUploadMiddleware(
  ['.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt', '.pdf', '.txt', '.md', '.csv'],
  50
);

async function anthropic() {
  return new Anthropic({ apiKey: await settings.getOrEnv('anthropic_api_key') });
}

async function MODEL() {
  return (await settings.getOrEnv('anthropic_model')) || 'claude-sonnet-4-6';
}

async function extractText(buffer, filename) {
  const ext = filename.split('.').pop().toLowerCase();
  const MAX = 100_000;
  if (ext === 'docx' || ext === 'doc') {
    const mammoth = require('mammoth');
    const result = await mammoth.extractRawText({ buffer });
    return result.value.slice(0, MAX);
  }
  if (ext === 'xlsx' || ext === 'xls' || ext === 'csv') {
    const XLSX = require('xlsx');
    const wb = XLSX.read(buffer, { type: 'buffer' });
    return wb.SheetNames.map(name =>
      `## ${name}\n\n${XLSX.utils.sheet_to_csv(wb.Sheets[name])}`
    ).join('\n\n').slice(0, MAX);
  }
  if (ext === 'pdf') {
    const pdfParse = require('pdf-parse');
    return (await pdfParse(buffer)).text.slice(0, MAX);
  }
  if (['txt', 'md', 'csv'].includes(ext)) return buffer.toString('utf8').slice(0, MAX);
  return null;
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
    const rows = await db.query('SELECT * FROM documents ORDER BY created_at DESC');
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
  const sanitizedName = path.basename(originalname).replace(/[^a-zA-Z0-9._-]/g, '_');
  const storagePath = `documents/${Date.now()}-${sanitizedName}`;

  try {
    await storage.upload(storagePath, buffer, mimetype);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  try {
    const doc = await db.queryOne(
      `INSERT INTO documents (name, size, mime_type, storage_path, uploaded_by, uploaded_by_email)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [originalname, size, mimetype, storagePath, req.user.id, req.user.email]
    );

    let canIngest = false;
    try {
      const text = await extractText(buffer, originalname);
      canIngest = text !== null && text.trim().length > 0;
    } catch (e) {
      console.error('Text extraction failed (non-fatal):', e.message);
    }

    res.json({ doc, canIngest });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/files/:id/ingest
router.post('/:id/ingest', auth, requireRole('admin', 'contributor'), async (req, res) => {
  const { focus } = req.body;

  try {
    const doc = await db.queryOne('SELECT * FROM documents WHERE id = $1', [req.params.id]);
    if (!doc) return res.status(404).json({ error: 'Document not found' });

    let buffer;
    try {
      buffer = await storage.download(doc.storage_path);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }

    let text;
    try {
      text = await extractText(buffer, doc.name);
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
    const doc = await db.queryOne('SELECT * FROM documents WHERE id = $1', [req.params.id]);
    if (!doc) return res.status(404).json({ error: 'Document not found' });

    const url = await storage.getUrl(doc.storage_path, 3600);
    res.json({ url, name: doc.name });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/files/:id/office
router.get('/:id/office', auth, async (req, res) => {
  try {
    const doc = await db.queryOne('SELECT * FROM documents WHERE id = $1', [req.params.id]);
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
    const doc = await db.queryOne('SELECT * FROM documents WHERE id = $1', [req.params.id]);
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
    const doc = await db.queryOne('SELECT * FROM documents WHERE id = $1', [req.params.id]);
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

    await storage.upload(doc.storage_path, buffer, exportMime);
    await db.query('UPDATE documents SET size = $1 WHERE id = $2', [buffer.length, doc.id]);
    res.json({ success: true, size: buffer.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/files/:id
router.delete('/:id', auth, requireRole('admin', 'contributor'), async (req, res) => {
  try {
    const doc = await db.queryOne('SELECT * FROM documents WHERE id = $1', [req.params.id]);
    if (!doc) return res.status(404).json({ error: 'Document not found' });

    await storage.del(doc.storage_path);
    await db.query('DELETE FROM documents WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

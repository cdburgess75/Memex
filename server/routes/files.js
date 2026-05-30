const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');
const Anthropic = require('@anthropic-ai/sdk');
const { generateToken } = require('../lib/wopiTokens');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    const allowed = ['.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt', '.pdf', '.txt', '.md', '.csv'];
    const ext = '.' + file.originalname.split('.').pop().toLowerCase();
    cb(null, allowed.includes(ext));
  }
});

function db() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function anthropic() {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

const MODEL = () => process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

async function extractText(buffer, filename) {
  const ext = filename.split('.').pop().toLowerCase();
  if (ext === 'docx' || ext === 'doc') {
    const mammoth = require('mammoth');
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }
  if (ext === 'xlsx' || ext === 'xls' || ext === 'csv') {
    const XLSX = require('xlsx');
    const wb = XLSX.read(buffer, { type: 'buffer' });
    return wb.SheetNames.map(name =>
      `## ${name}\n\n${XLSX.utils.sheet_to_csv(wb.Sheets[name])}`
    ).join('\n\n');
  }
  if (ext === 'pdf') {
    const pdfParse = require('pdf-parse');
    return (await pdfParse(buffer)).text;
  }
  if (['txt', 'md', 'csv'].includes(ext)) return buffer.toString('utf8');
  return null;
}

function buildContext(pages) {
  return (pages || [])
    .filter(p => p.id !== 'overview')
    .map(p => `### [[${p.title}]]  (${p.category})\n${p.content}`)
    .join('\n\n---\n\n');
}

async function logEvent(client, event, userId, userEmail) {
  await client.from('activity_log').insert({ event, user_id: userId, user_email: userEmail });
}

// GET /api/files — list all documents
router.get('/', auth, async (req, res) => {
  const { data, error } = await db()
    .from('documents')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/files/upload — upload a document
router.post('/upload', auth, requireRole('admin', 'contributor'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file required' });

  const client = db();
  const { buffer, originalname, mimetype, size } = req.file;
  const sanitizedName = originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
  const storagePath = `documents/${Date.now()}-${sanitizedName}`;

  // Upload to Supabase Storage
  const { error: uploadError } = await client.storage
    .from('documents')
    .upload(storagePath, buffer, { contentType: mimetype });

  if (uploadError) return res.status(500).json({ error: uploadError.message });

  // Insert metadata row
  const { data: doc, error: insertError } = await client
    .from('documents')
    .insert({
      name: originalname,
      size,
      mime_type: mimetype,
      storage_path: storagePath,
      uploaded_by: req.user.id,
      uploaded_by_email: req.user.email,
    })
    .select()
    .single();

  if (insertError) return res.status(500).json({ error: insertError.message });

  // Attempt text extraction (non-fatal)
  let canIngest = false;
  try {
    const text = await extractText(buffer, originalname);
    canIngest = text !== null && text.trim().length > 0;
  } catch (e) {
    console.error('Text extraction failed (non-fatal):', e.message);
  }

  res.json({ doc, canIngest });
});

// POST /api/files/:id/ingest — extract text and ingest into wiki
router.post('/:id/ingest', auth, requireRole('admin', 'contributor'), async (req, res) => {
  const { focus } = req.body;
  const client = db();

  const { data: doc, error: docError } = await client
    .from('documents')
    .select('*')
    .eq('id', req.params.id)
    .maybeSingle();

  if (docError) return res.status(500).json({ error: docError.message });
  if (!doc) return res.status(404).json({ error: 'Document not found' });

  // Download from Supabase Storage
  const { data: fileData, error: downloadError } = await client.storage
    .from('documents')
    .download(doc.storage_path);

  if (downloadError) return res.status(500).json({ error: downloadError.message });

  const buffer = Buffer.from(await fileData.arrayBuffer());

  let text;
  try {
    text = await extractText(buffer, doc.name);
  } catch (e) {
    return res.status(422).json({ error: `Text extraction failed: ${e.message}` });
  }

  if (!text || !text.trim()) {
    return res.status(422).json({ error: 'Could not extract text from this file' });
  }

  // Run the same ingest pipeline as ai.js
  const { data: pages } = await client.from('pages').select('*');
  const ctx = buildContext(pages);

  const system = `You maintain a personal wiki. Ingest the source the user provides.

Existing wiki pages:
${ctx || '(empty — this is the first source)'}

Return ONLY valid JSON, no markdown fences, in this shape:
{"summary":"2-3 sentence summary","pages":[{"id":"kebab-slug","title":"Page Title","category":"concept|entity|source|analysis","content":"# Page Title\\n\\nMarkdown body. Use [[Page Title]] to link related pages. Use ## for subheads and - for bullets."}]}

Create or update 2-4 pages. Prefer updating an existing page (reuse its exact id) when the source adds to it. Always include one "source" page summarizing this document. Cross-link generously with [[wikilinks]].${focus ? '\nUser emphasis: ' + focus : ''}`;

  try {
    const message = await anthropic().messages.create({
      model: MODEL(),
      max_tokens: 1400,
      system,
      messages: [{ role: 'user', content: 'Source:\n\n' + text.slice(0, 8000) }],
    });

    // Track api_usage
    await client.from('api_usage').insert({
      user_id: req.user.id,
      user_email: req.user.email,
      operation: 'ingest',
      model: MODEL(),
      input_tokens: message.usage.input_tokens,
      output_tokens: message.usage.output_tokens,
    });

    const raw = message.content.map(b => b.text || '').join('');
    const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());

    const touched = [];
    for (const p of (parsed.pages || [])) {
      const { data: existing } = await client.from('pages').select('id, sources').eq('id', p.id).maybeSingle();
      let result;
      if (existing) {
        result = await client
          .from('pages')
          .update({ title: p.title, category: p.category, content: p.content, sources: (existing.sources || 0) + 1, updated_at: new Date().toISOString(), updated_by: req.user.id })
          .eq('id', p.id)
          .select()
          .single();
      } else {
        result = await client
          .from('pages')
          .insert({ ...p, sources: 1, created_by: req.user.id, updated_by: req.user.id })
          .select()
          .single();
      }
      if (result.data) touched.push(result.data);
    }

    await logEvent(client, `ingest · ${touched.length} pages · ${parsed.pages?.[0]?.title || doc.name}`, req.user.id, req.user.email);
    res.json({ summary: parsed.summary, pages: touched });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/files/:id/url — get a signed download URL
router.get('/:id/url', auth, async (req, res) => {
  const client = db();

  const { data: doc, error: docError } = await client
    .from('documents')
    .select('*')
    .eq('id', req.params.id)
    .maybeSingle();

  if (docError) return res.status(500).json({ error: docError.message });
  if (!doc) return res.status(404).json({ error: 'Document not found' });

  const { data: signedData, error: signError } = await client.storage
    .from('documents')
    .createSignedUrl(doc.storage_path, 3600); // 1 hour

  if (signError) return res.status(500).json({ error: signError.message });

  res.json({ url: signedData.signedUrl, name: doc.name });
});

// GET /api/files/:id/office — get Office Online viewer/editor URLs
router.get('/:id/office', auth, async (req, res) => {
  const client = db();

  const { data: doc, error: docError } = await client
    .from('documents')
    .select('*')
    .eq('id', req.params.id)
    .maybeSingle();

  if (docError) return res.status(500).json({ error: docError.message });
  if (!doc) return res.status(404).json({ error: 'Document not found' });

  const { data: signedData, error: signError } = await client.storage
    .from('documents')
    .createSignedUrl(doc.storage_path, 3600);

  if (signError) return res.status(500).json({ error: signError.message });

  const signedUrl = signedData.signedUrl;
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
});

// POST /api/files/:id/google — upload to Google Drive for editing
router.post('/:id/google', auth, async (req, res) => {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
    return res.status(400).json({
      error: 'Google Drive integration is not configured. Set GOOGLE_SERVICE_ACCOUNT_KEY in your environment.'
    });
  }

  const client = db();

  const { data: doc, error: docError } = await client
    .from('documents')
    .select('*')
    .eq('id', req.params.id)
    .maybeSingle();

  if (docError) return res.status(500).json({ error: docError.message });
  if (!doc) return res.status(404).json({ error: 'Document not found' });

  // Download from Supabase Storage
  const { data: fileData, error: downloadError } = await client.storage
    .from('documents')
    .download(doc.storage_path);

  if (downloadError) return res.status(500).json({ error: downloadError.message });

  const buffer = Buffer.from(await fileData.arrayBuffer());
  const ext = doc.name.split('.').pop().toLowerCase();

  // MIME type mapping for Google conversion
  const googleMimeTypes = {
    docx: 'application/vnd.google-apps.document',
    doc:  'application/vnd.google-apps.document',
    xlsx: 'application/vnd.google-apps.spreadsheet',
    xls:  'application/vnd.google-apps.spreadsheet',
    pptx: 'application/vnd.google-apps.presentation',
    ppt:  'application/vnd.google-apps.presentation',
  };

  try {
    // Lazy require googleapis
    const { google } = require('googleapis');

    let credentials;
    try {
      credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
    } catch (e) {
      return res.status(500).json({ error: 'Invalid GOOGLE_SERVICE_ACCOUNT_KEY — must be valid JSON' });
    }

    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/drive'],
    });

    const drive = google.drive({ version: 'v3', auth });

    const fileMetadata = {
      name: doc.name,
      ...(googleMimeTypes[ext] ? { mimeType: googleMimeTypes[ext] } : {}),
      ...(process.env.GOOGLE_DRIVE_FOLDER_ID ? { parents: [process.env.GOOGLE_DRIVE_FOLDER_ID] } : {}),
    };

    const { Readable } = require('stream');
    const readable = Readable.from(buffer);

    const { data: driveFile } = await drive.files.create({
      requestBody: fileMetadata,
      media: {
        mimeType: doc.mime_type,
        body: readable,
      },
      fields: 'id, webViewLink',
    });

    // Share with requesting user's email (non-fatal)
    try {
      await drive.permissions.create({
        fileId: driveFile.id,
        requestBody: {
          type: 'user',
          role: 'writer',
          emailAddress: req.user.email,
        },
      });
    } catch (shareErr) {
      console.error('Google Drive share failed (non-fatal):', shareErr.message);
    }

    // Save google_drive_id back to documents table
    await client
      .from('documents')
      .update({ google_drive_id: driveFile.id })
      .eq('id', doc.id);

    res.json({ editUrl: driveFile.webViewLink, driveId: driveFile.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/files/:id/google/export — export from Google Drive back to Supabase Storage
router.post('/:id/google/export', auth, requireRole('admin', 'contributor'), async (req, res) => {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
    return res.status(400).json({
      error: 'Google Drive integration is not configured. Set GOOGLE_SERVICE_ACCOUNT_KEY in your environment.'
    });
  }

  const client = db();

  const { data: doc, error: docError } = await client
    .from('documents')
    .select('*')
    .eq('id', req.params.id)
    .maybeSingle();

  if (docError) return res.status(500).json({ error: docError.message });
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

  try {
    const { google } = require('googleapis');

    let credentials;
    try {
      credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
    } catch (e) {
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

    // Collect stream into buffer
    const chunks = [];
    await new Promise((resolve, reject) => {
      exportStream.on('data', chunk => chunks.push(chunk));
      exportStream.on('end', resolve);
      exportStream.on('error', reject);
    });
    const buffer = Buffer.concat(chunks);

    // Upload buffer back to Supabase Storage (upsert)
    const { error: uploadError } = await client.storage
      .from('documents')
      .upload(doc.storage_path, buffer, { contentType: exportMime, upsert: true });

    if (uploadError) return res.status(500).json({ error: uploadError.message });

    // Update size in documents table
    await client
      .from('documents')
      .update({ size: buffer.length })
      .eq('id', doc.id);

    res.json({ success: true, size: buffer.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/files/:id — delete a document
router.delete('/:id', auth, requireRole('admin', 'contributor'), async (req, res) => {
  const client = db();

  const { data: doc, error: docError } = await client
    .from('documents')
    .select('*')
    .eq('id', req.params.id)
    .maybeSingle();

  if (docError) return res.status(500).json({ error: docError.message });
  if (!doc) return res.status(404).json({ error: 'Document not found' });

  // Remove from Supabase Storage
  const { error: storageError } = await client.storage
    .from('documents')
    .remove([doc.storage_path]);

  if (storageError) return res.status(500).json({ error: storageError.message });

  // Delete metadata row
  const { error: deleteError } = await client
    .from('documents')
    .delete()
    .eq('id', req.params.id);

  if (deleteError) return res.status(500).json({ error: deleteError.message });

  res.json({ success: true });
});

module.exports = router;

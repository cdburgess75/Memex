'use strict';
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const db = require('../lib/db');
const settings = require('../lib/settings');
const aiProviders = require('../lib/aiProviders');
const documentAccess = require('../lib/documentAccess');
const cheerio = require('cheerio');
const pdfParse = require('pdf-parse');
const { makeUploadMiddleware } = require('../lib/upload');

function parseHtml(html) {
  const $ = cheerio.load(html);
  $('script, style, nav, footer, header, aside, noscript').remove();
  const title = $('title').text().trim();
  const text = ($('article, main, [role="main"], .content, .post, body').first().text())
    .replace(/\s+/g, ' ').trim().slice(0, 12000);
  return { title, text };
}

async function fetchUrl(url) {
  const proxyUrl = await settings.getOrEnv('http_proxy');
  const fetchOpts = { headers: { 'User-Agent': 'Memex/1.0' }, signal: AbortSignal.timeout(15000) };
  let res;
  if (proxyUrl) {
    const { ProxyAgent, fetch: undiciFetch } = require('undici');
    res = await undiciFetch(url, { ...fetchOpts, dispatcher: new ProxyAgent(proxyUrl) });
  } else {
    res = await fetch(url, fetchOpts);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching URL`);
  return parseHtml(await res.text());
}

const getAiUpload = makeUploadMiddleware(['.txt', '.md', '.pdf'], 10);

function buildContext(pages) {
  return (pages || [])
    .filter(p => p.id !== 'overview')
    .map(p => `### [[${p.title}]]  (${p.category})\n${p.content}`)
    .join('\n\n---\n\n');
}

// Fold relevant uploaded-file text into the query context, truncated per file and overall
// so a large document can't blow the model's context window.
function buildDocContext(docs) {
  const PER_DOC = 4000;
  const TOTAL = 24000;
  let used = 0;
  const parts = [];
  for (const d of (docs || [])) {
    if (used >= TOTAL) break;
    const text = String(d.document_text || '').slice(0, PER_DOC).trim();
    if (!text) continue;
    parts.push(`### File: ${d.name}\n${text}`);
    used += text.length;
  }
  return parts.length ? `Uploaded files:\n\n${parts.join('\n\n---\n\n')}` : '';
}

function sseHeaders(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
}

async function logEvent(event, userId, userEmail) {
  await db.query(
    'INSERT INTO activity_log (event, user_id, user_email) VALUES ($1, $2, $3)',
    [event, userId, userEmail]
  );
}

async function upsertPage(p, userId) {
  const existing = await db.queryOne('SELECT id, sources FROM pages WHERE id = $1', [p.id]);
  if (existing) {
    return db.queryOne(
      `UPDATE pages SET title = $1, category = $2, content = $3, sources = $4,
       updated_at = $5, updated_by = $6 WHERE id = $7 RETURNING *`,
      [p.title, p.category, p.content, (existing.sources || 0) + 1, new Date().toISOString(), userId, p.id]
    );
  }
  return db.queryOne(
    `INSERT INTO pages (id, title, category, content, sources, created_by, updated_by)
     VALUES ($1, $2, $3, $4, 1, $5, $6) RETURNING *`,
    [p.id, p.title, p.category, p.content, userId, userId]
  );
}

// POST /api/ai/ingest
router.post('/ingest', auth, async (req, res) => {
  let { source, url, focus } = req.body;

  if (!source?.trim() && url?.trim()) {
    try {
      const { title, text } = await fetchUrl(url.trim());
      source = (title ? `${title}\n\n` : '') + text;
    } catch (e) {
      return res.status(400).json({ error: `Could not fetch URL: ${e.message}` });
    }
  }

  if (!source?.trim()) return res.status(400).json({ error: 'source or url required' });

  try {
    const pages = await db.query('SELECT * FROM pages');
    const ctx = buildContext(pages);

    const system = `You maintain a team knowledge base. Ingest the source the user provides.

Existing pages:
${ctx || '(empty — this is the first source)'}

Return ONLY valid JSON, no markdown fences, in this shape:
{"summary":"2-3 sentence summary","pages":[{"id":"kebab-slug","title":"Page Title","category":"concept|entity|source|analysis","content":"# Page Title\\n\\nMarkdown body. Use [[Page Title]] to link related pages. Use ## for subheads and - for bullets."}]}

Create or update 2-4 pages. Prefer updating an existing page (reuse its exact id) when the source adds to it. Always include one "source" page summarizing this document. Cross-link generously with [[page links]].${focus ? '\nUser emphasis: ' + focus : ''}`;

    const result = await aiProviders.run({
      system,
      prompt: 'Source:\n\n' + source.slice(0, 8000),
      maxTokens: 1400,
    });

    await db.query(
      'INSERT INTO api_usage (user_id, user_email, operation, model, input_tokens, output_tokens) VALUES ($1, $2, $3, $4, $5, $6)',
      [req.user.id, req.user.email, 'ingest', result.model, result.usage.input_tokens, result.usage.output_tokens]
    );

    const raw = result.text;
    let parsed;
    try {
      parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    } catch {
      return res.status(422).json({ error: 'Claude returned invalid JSON — try again' });
    }

    const touched = [];
    for (const p of (parsed.pages || [])) {
      const row = await upsertPage(p, req.user.id);
      if (row) touched.push(row);
    }

    await logEvent(`ingest · ${touched.length} pages · ${parsed.pages?.[0]?.title || 'source'}`, req.user.id, req.user.email);
    res.json({ summary: parsed.summary, pages: touched });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/ai/query  (SSE streaming)
router.post('/query', auth, async (req, res) => {
  const { question, fileIt, libraryIds } = req.body;
  if (!question?.trim()) return res.status(400).json({ error: 'question required' });

  sseHeaders(res);

  try {
    const pages = await db.query('SELECT * FROM pages');
    const libs = Array.isArray(libraryIds) && libraryIds.length ? libraryIds : null;
    const docs = await documentAccess.searchAccessibleDocuments(req.user, question, 6, libs);
    const ctx = [buildContext(pages), buildDocContext(docs)].filter(Boolean).join('\n\n---\n\n');

    const system = `You answer questions from a team knowledge base made up of pages and uploaded files. Ground every claim in the material below and name the page or file you drew it from. If the material lacks the answer, say so plainly.${fileIt ? '\n\nAfter the answer, on its own final line output exactly:\nSAVE_AS: Short Page Title | analysis' : ''}\n\nKnowledge base:\n${ctx || '(empty — tell the user to add knowledge or upload files first)'}`;

    const result = await aiProviders.run({
      system,
      prompt: question,
      maxTokens: 1400,
      stream: true,
      onDelta: (t) => res.write(`data: ${JSON.stringify({ text: t })}\n\n`),
    });
    const fullText = result.text;

    if (fileIt && fullText.includes('SAVE_AS:')) {
      const m = fullText.match(/SAVE_AS:\s*(.+?)\s*\|\s*(\w+)/);
      const body = fullText.split('SAVE_AS:')[0].trim();
      if (m) {
        const title = m[1].trim();
        const id = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const saved = await db.queryOne(
          `INSERT INTO pages (id, title, category, sources, content, created_by, updated_by)
           VALUES ($1, $2, $3, 0, $4, $5, $6) RETURNING *`,
          [id, title, (m[2] || 'analysis').toLowerCase(), `# ${title}\n\n*Filed from: "${question}"*\n\n${body}`, req.user.id, req.user.id]
        );
        if (saved) res.write(`data: ${JSON.stringify({ saved })}\n\n`);
      }
    }

    await db.query(
      'INSERT INTO api_usage (user_id, user_email, operation, model, input_tokens, output_tokens) VALUES ($1, $2, $3, $4, $5, $6)',
      [req.user.id, req.user.email, 'query', result.model, result.usage.input_tokens, result.usage.output_tokens]
    );

    await logEvent(`query · ${question.slice(0, 48)}`, req.user.id, req.user.email);
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (e) {
    res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
    res.end();
  }
});

// POST /api/ai/lint  (SSE streaming)
router.post('/lint', auth, async (req, res) => {
  const { focus } = req.body;
  sseHeaders(res);

  try {
    const pages = await db.query('SELECT * FROM pages');
    const ctx = buildContext(pages);

    const system = `You audit a team knowledge base for health. Report, as a short numbered list: contradictions between pages, orphaned pages with no inbound [[links]], important ideas mentioned but lacking their own page, missing cross-references, and gaps worth investigating (with concrete next sources or questions). Be specific and actionable.${focus ? '\nFocus: ' + focus : ''}`;

    const result = await aiProviders.run({
      system,
      prompt: 'Knowledge base:\n\n' + (ctx || '(empty)'),
      maxTokens: 1400,
      stream: true,
      onDelta: (t) => res.write(`data: ${JSON.stringify({ text: t })}\n\n`),
    });

    await db.query(
      'INSERT INTO api_usage (user_id, user_email, operation, model, input_tokens, output_tokens) VALUES ($1, $2, $3, $4, $5, $6)',
      [req.user.id, req.user.email, 'lint', result.model, result.usage.input_tokens, result.usage.output_tokens]
    );

    await logEvent('lint · audit run', req.user.id, req.user.email);
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (e) {
    res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
    res.end();
  }
});

// POST /api/ai/extract  (file upload — PDF or plain text)
router.post('/extract', auth, (req, res, next) => getAiUpload().then(mw => mw(req, res, next)).catch(next), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file required (.txt, .md, .pdf)' });

  try {
    const ext = '.' + req.file.originalname.split('.').pop().toLowerCase();
    let text;

    if (ext === '.pdf') {
      const result = await pdfParse(req.file.buffer);
      text = result.text;
    } else {
      text = req.file.buffer.toString('utf8');
    }

    text = text.replace(/\s+/g, ' ').trim().slice(0, 12000);
    res.json({ text, title: '' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/ai/models — enabled models + active selection (no secrets); powers the masthead picker
router.get('/models', auth, async (req, res) => {
  try {
    const [models, active] = await Promise.all([aiProviders.listModels(), aiProviders.activeModel()]);
    res.json({ active: `${active.provider}:${active.model}`, models });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/ai/detect-models — probe an OpenAI-compatible endpoint (e.g. Ollama)
// for its installed models so admins don't have to type them by hand. Admin-only;
// the server fetches the same base URL the AI calls would use.
router.post('/detect-models', auth, requireRole('admin'), async (req, res) => {
  const base = String(req.body?.base_url || '').trim().replace(/\/+$/, '');
  const key = String(req.body?.api_key || '').trim();
  if (!base) return res.status(400).json({ error: 'base_url required' });
  const headers = { Accept: 'application/json' };
  if (key) headers.Authorization = `Bearer ${key}`;
  try {
    // OpenAI-compatible endpoints (incl. Ollama's /v1) expose GET /models.
    let r = await fetch(`${base}/models`, { headers, signal: AbortSignal.timeout(6000) });
    let models = [];
    if (r.ok) {
      const j = await r.json();
      models = Array.isArray(j?.data) ? j.data.map(m => m && m.id).filter(Boolean) : [];
    }
    // Fall back to Ollama's native /api/tags (strip a trailing /v1).
    if (!models.length) {
      const root = base.replace(/\/v1$/, '');
      const t = await fetch(`${root}/api/tags`, { headers, signal: AbortSignal.timeout(6000) });
      if (t.ok) { const j = await t.json(); models = Array.isArray(j?.models) ? j.models.map(m => m && m.name).filter(Boolean) : []; }
    }
    res.json({ models });
  } catch (e) {
    res.status(502).json({ error: e.message || 'Could not reach endpoint' });
  }
});

// PUT /api/ai/active — switch the global active model (any signed-in user)
router.put('/active', auth, async (req, res) => {
  try {
    const value = (req.body?.model || '').trim();
    if (!value) return res.status(400).json({ error: 'model required' });
    await aiProviders.setActiveModel(value);
    res.json({ ok: true, active: value });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;

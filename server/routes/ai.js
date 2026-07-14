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

// POST /api/ai/query  (SSE streaming) — answers from the team's uploaded files.
router.post('/query', auth, async (req, res) => {
  const { question, libraryIds } = req.body;
  if (!question?.trim()) return res.status(400).json({ error: 'question required' });

  sseHeaders(res);

  try {
    const libs = Array.isArray(libraryIds) && libraryIds.length ? libraryIds : null;
    const docs = await documentAccess.searchAccessibleDocuments(req.user, question, 6, libs);
    const ctx = buildDocContext(docs);

    const system = `You answer questions from the team's uploaded files. Ground every claim in the material below and name the file you drew it from. If the material lacks the answer, say so plainly.\n\n${ctx || '(no matching files — tell the user to upload files first)'}`;

    const result = await aiProviders.run({
      system,
      prompt: question,
      maxTokens: 1400,
      stream: true,
      onDelta: (t) => res.write(`data: ${JSON.stringify({ text: t })}\n\n`),
    });

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

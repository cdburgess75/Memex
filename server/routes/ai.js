'use strict';
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const Anthropic = require('@anthropic-ai/sdk');
const db = require('../lib/db');
const settings = require('../lib/settings');
const cheerio = require('cheerio');
const multer = require('multer');
const pdfParse = require('pdf-parse');

async function fetchUrl(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Memex/1.0' },
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching URL`);
  const html = await res.text();
  const $ = cheerio.load(html);
  $('script, style, nav, footer, header, aside, noscript').remove();
  const title = $('title').text().trim();
  const text = ($('article, main, [role="main"], .content, .post, body').first().text())
    .replace(/\s+/g, ' ').trim().slice(0, 12000);
  return { title, text };
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    const allowed = ['.txt', '.md', '.pdf'];
    const ext = '.' + file.originalname.split('.').pop().toLowerCase();
    cb(null, allowed.includes(ext));
  }
});

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

    const [ai, model] = await Promise.all([anthropic(), MODEL()]);
    const message = await ai.messages.create({
      model,
      max_tokens: 1400,
      system,
      messages: [{ role: 'user', content: 'Source:\n\n' + source.slice(0, 8000) }],
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
  const { question, fileIt } = req.body;
  if (!question?.trim()) return res.status(400).json({ error: 'question required' });

  sseHeaders(res);

  try {
    const pages = await db.query('SELECT * FROM pages');
    const ctx = buildContext(pages);

    const system = `You answer questions from a team knowledge base. Ground every claim in the pages below and name the pages you draw on. If the knowledge base lacks the answer, say so plainly.${fileIt ? '\n\nAfter the answer, on its own final line output exactly:\nSAVE_AS: Short Page Title | analysis' : ''}\n\nKnowledge base:\n${ctx || '(empty — tell the user to ingest sources first)'}`;

    const [ai, model] = await Promise.all([anthropic(), MODEL()]);
    const stream = ai.messages.stream({
      model,
      max_tokens: 1400,
      system,
      messages: [{ role: 'user', content: question }],
    });

    let fullText = '';
    for await (const chunk of await stream) {
      if (chunk.type === 'content_block_delta' && chunk.delta?.text) {
        fullText += chunk.delta.text;
        res.write(`data: ${JSON.stringify({ text: chunk.delta.text })}\n\n`);
      }
    }

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

    const final = await stream.finalMessage();
    await db.query(
      'INSERT INTO api_usage (user_id, user_email, operation, model, input_tokens, output_tokens) VALUES ($1, $2, $3, $4, $5, $6)',
      [req.user.id, req.user.email, 'query', model, final.usage.input_tokens, final.usage.output_tokens]
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

    const [ai, model] = await Promise.all([anthropic(), MODEL()]);
    const stream = ai.messages.stream({
      model,
      max_tokens: 1400,
      system,
      messages: [{ role: 'user', content: 'Knowledge base:\n\n' + (ctx || '(empty)') }],
    });

    for await (const chunk of await stream) {
      if (chunk.type === 'content_block_delta' && chunk.delta?.text) {
        res.write(`data: ${JSON.stringify({ text: chunk.delta.text })}\n\n`);
      }
    }

    const final = await stream.finalMessage();
    await db.query(
      'INSERT INTO api_usage (user_id, user_email, operation, model, input_tokens, output_tokens) VALUES ($1, $2, $3, $4, $5, $6)',
      [req.user.id, req.user.email, 'lint', model, final.usage.input_tokens, final.usage.output_tokens]
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
router.post('/extract', auth, upload.single('file'), async (req, res) => {
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

module.exports = router;

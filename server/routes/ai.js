const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
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

function db() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function anthropic() {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

const MODEL = () => process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

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

async function logEvent(client, event, userId, userEmail) {
  await client.from('activity_log').insert({ event, user_id: userId, user_email: userEmail });
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

  const client = db();
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
      messages: [{ role: 'user', content: 'Source:\n\n' + source.slice(0, 8000) }],
    });

    // Track token usage
    await client.from('api_usage').insert({
      user_id: req.user.id,
      user_email: req.user.email,
      operation: 'ingest',
      model: MODEL(),
      input_tokens: message.usage.input_tokens,
      output_tokens: message.usage.output_tokens,
    });

    const raw = message.content.map(b => b.text || '').join('');
    let parsed;
    try {
      parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    } catch (parseErr) {
      return res.status(422).json({ error: 'Claude returned invalid JSON — try again' });
    }

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

    await logEvent(client, `ingest · ${touched.length} pages · ${parsed.pages?.[0]?.title || 'source'}`, req.user.id, req.user.email);
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

  const client = db();
  const { data: pages } = await client.from('pages').select('*');
  const ctx = buildContext(pages);

  const system = `You answer questions from a personal wiki. Ground every claim in the pages below and name the pages you draw on. If the wiki lacks the answer, say so plainly.${fileIt ? '\n\nAfter the answer, on its own final line output exactly:\nSAVE_AS: Short Page Title | analysis' : ''}\n\nWiki:\n${ctx || '(empty — tell the user to ingest sources first)'}`;

  try {
    const stream = anthropic().messages.stream({
      model: MODEL(),
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
        const { data: saved } = await client
          .from('pages')
          .insert({ id, title, category: (m[2] || 'analysis').toLowerCase(), sources: 0, content: `# ${title}\n\n*Filed from: "${question}"*\n\n${body}`, created_by: req.user.id, updated_by: req.user.id })
          .select()
          .single();
        if (saved) res.write(`data: ${JSON.stringify({ saved })}\n\n`);
      }
    }

    // Track token usage
    const final = await stream.finalMessage();
    await client.from('api_usage').insert({
      user_id: req.user.id,
      user_email: req.user.email,
      operation: 'query',
      model: MODEL(),
      input_tokens: final.usage.input_tokens,
      output_tokens: final.usage.output_tokens,
    });

    await logEvent(client, `query · ${question.slice(0, 48)}`, req.user.id, req.user.email);
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

  const client = db();
  const { data: pages } = await client.from('pages').select('*');
  const ctx = buildContext(pages);

  const system = `You audit a personal wiki for health. Report, as a short numbered list: contradictions between pages, orphaned pages with no inbound [[links]], important ideas mentioned but lacking their own page, missing cross-references, and gaps worth investigating (with concrete next sources or questions). Be specific and actionable.${focus ? '\nFocus: ' + focus : ''}`;

  try {
    const stream = anthropic().messages.stream({
      model: MODEL(),
      max_tokens: 1400,
      system,
      messages: [{ role: 'user', content: 'Wiki:\n\n' + (ctx || '(empty)') }],
    });

    for await (const chunk of await stream) {
      if (chunk.type === 'content_block_delta' && chunk.delta?.text) {
        res.write(`data: ${JSON.stringify({ text: chunk.delta.text })}\n\n`);
      }
    }

    // Track token usage
    const final = await stream.finalMessage();
    await client.from('api_usage').insert({
      user_id: req.user.id,
      user_email: req.user.email,
      operation: 'lint',
      model: MODEL(),
      input_tokens: final.usage.input_tokens,
      output_tokens: final.usage.output_tokens,
    });

    await logEvent(client, 'lint · audit run', req.user.id, req.user.email);
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

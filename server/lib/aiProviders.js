'use strict';
// Provider abstraction for AI calls. Supports Anthropic (Claude) and any
// OpenAI-compatible endpoint (OpenAI, Groq, Together, OpenRouter, and self-hosted
// Ollama / vLLM / LM Studio via a base URL). The active model is a single global
// setting (ai_active_model = "provider:model"); routes call run() and never touch
// a specific SDK directly.
const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');
const settings = require('./settings');

const DEFAULT_ANTHROPIC_MODELS = 'claude-opus-4-8,claude-sonnet-4-6,claude-haiku-4-5';
const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';

function parseList(s) {
  return String(s || '').split(',').map(x => x.trim()).filter(Boolean);
}

async function anthropicKey() { return settings.getOrEnv('anthropic_api_key'); }

function slugify(s, fallback) {
  const v = String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return v || fallback;
}

// Normalized list of OpenAI-compatible endpoints, each: { id, label, base_url, api_key, models[] }.
// Source of truth is the JSON `ai_endpoints` setting. If it's empty/unset, fall back to the
// legacy single-endpoint settings (openai_base_url / openai_api_key / openai_models) so existing
// installs keep working and their `openai:<model>` selections stay valid.
async function listEndpoints() {
  const raw = await settings.getOrEnv('ai_endpoints');
  let arr = [];
  if (raw) { try { const p = JSON.parse(raw); if (Array.isArray(p)) arr = p; } catch { /* ignore bad JSON */ } }
  if (arr.length) {
    const seen = new Set();
    return arr.map((e, i) => {
      let id = slugify(e.id || e.label, `endpoint-${i + 1}`);
      while (seen.has(id)) id = `${id}-${i + 1}`;
      seen.add(id);
      return {
        id,
        label: (e.label || e.id || `Endpoint ${i + 1}`).trim(),
        base_url: (e.base_url || '').trim(),
        api_key: (e.api_key || '').trim(),
        models: parseList(e.models),
      };
    });
  }
  // Legacy fallback
  const base = await settings.getOrEnv('openai_base_url');
  const key = await settings.getOrEnv('openai_api_key');
  const models = parseList(await settings.getOrEnv('openai_models'));
  if ((base || key) && models.length) {
    return [{ id: 'openai', label: 'OpenAI-compatible', base_url: (base || '').trim(), api_key: (key || '').trim(), models }];
  }
  return [];
}

// Enabled models, grouped by provider. Anthropic appears if it has a key; each OpenAI-compatible
// endpoint appears if it has models AND (a key OR a base URL — self-hosted endpoints often need no key).
async function listModels() {
  const out = [];
  if (await anthropicKey()) {
    const list = parseList(await settings.getOrEnv('anthropic_models'));
    for (const id of (list.length ? list : parseList(DEFAULT_ANTHROPIC_MODELS))) {
      out.push({ provider: 'anthropic', id, label: id, group: 'Claude (Anthropic)' });
    }
  }
  for (const ep of await listEndpoints()) {
    if (!ep.models.length || !(ep.api_key || ep.base_url)) continue;
    for (const id of ep.models) out.push({ provider: ep.id, id, label: id, group: ep.label });
  }
  return out;
}

async function activeModel() {
  const raw = await settings.getOrEnv('ai_active_model');
  if (raw === 'off') return { provider: 'off', model: 'off' };
  if (raw && raw.includes(':')) {
    const idx = raw.indexOf(':');
    return { provider: raw.slice(0, idx), model: raw.slice(idx + 1) };
  }
  // Fallback to the legacy single-model Anthropic config.
  return { provider: 'anthropic', model: (await settings.getOrEnv('anthropic_model')) || 'claude-sonnet-4-6' };
}

async function setActiveModel(value) {
  if (value !== 'off') {
    const models = await listModels();
    if (!models.some(m => `${m.provider}:${m.id}` === value)) {
      throw new Error('Model not available');
    }
  }
  await settings.set('ai_active_model', value);
  return value;
}

// Unified call against the active model. Accumulates text, invokes onDelta(text)
// per streamed chunk (when stream:true), and returns { text, usage, model }.
async function run({ system, prompt, maxTokens = 1400, stream = false, onDelta } = {}) {
  const { provider, model } = await activeModel();
  const tag = `${provider}:${model}`;

  if (provider === 'off') {
    throw new Error('AI is turned off. Pick a model from the ✦ selector in the top bar to enable AI.');
  }

  if (provider !== 'anthropic') {
    const ep = (await listEndpoints()).find(e => e.id === provider);
    if (!ep) throw new Error(`AI endpoint "${provider}" is not configured. Pick a model from the ✦ selector.`);
    const client = new OpenAI({ apiKey: ep.api_key || 'not-required', baseURL: ep.base_url || DEFAULT_OPENAI_BASE_URL });
    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: prompt });
    if (stream) {
      const s = await client.chat.completions.create({
        model, max_tokens: maxTokens, messages, stream: true, stream_options: { include_usage: true },
      });
      let text = '';
      let usage = { input_tokens: 0, output_tokens: 0 };
      for await (const chunk of s) {
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) { text += delta; if (onDelta) onDelta(delta); }
        if (chunk.usage) usage = { input_tokens: chunk.usage.prompt_tokens || 0, output_tokens: chunk.usage.completion_tokens || 0 };
      }
      return { text, usage, model: tag };
    }
    const r = await client.chat.completions.create({ model, max_tokens: maxTokens, messages });
    return {
      text: r.choices?.[0]?.message?.content || '',
      usage: { input_tokens: r.usage?.prompt_tokens || 0, output_tokens: r.usage?.completion_tokens || 0 },
      model: tag,
    };
  }

  // Anthropic (default)
  const client = new Anthropic({ apiKey: await anthropicKey() });
  if (stream) {
    const s = client.messages.stream({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: prompt }] });
    for await (const chunk of s) {
      if (chunk.type === 'content_block_delta' && chunk.delta?.text) { if (onDelta) onDelta(chunk.delta.text); }
    }
    const final = await s.finalMessage();
    return {
      text: final.content.map(b => b.text || '').join(''),
      usage: { input_tokens: final.usage.input_tokens, output_tokens: final.usage.output_tokens },
      model: tag,
    };
  }
  const m = await client.messages.create({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: prompt }] });
  return {
    text: m.content.map(b => b.text || '').join(''),
    usage: { input_tokens: m.usage.input_tokens, output_tokens: m.usage.output_tokens },
    model: tag,
  };
}

module.exports = { listModels, listEndpoints, activeModel, setActiveModel, run };

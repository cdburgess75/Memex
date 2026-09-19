'use strict';
// Big files through a link, in pieces.
//
// A recipient's upload used to be one multipart request, held whole in memory and capped at
// 100 MB. One request cannot carry a multi-gigabyte file anyway: the server's request timeout,
// a proxy's, or one dropped connection ends it and everything sent is lost. So the page sends
// a file as PIECES (16 MB each), in order; each piece is staged on disk -- encrypted, when the
// workspace encrypts storage, exactly as staff uploads are -- and the last one assembles the
// file as a stream. Memory stays flat, a failed piece is retried on its own, and how big a
// file may be is a setting, not an accident of the transport.
//
// Nothing the visitor sends names a path: the staging folder is derived from the link and
// their upload id by hashing, and pieces are numbered by the server.
const fs = require('fs/promises');
const fsSync = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const storage = require('./storage');
const settings = require('./settings');
const encryption = require('./encryption');

const PIECE_MAX = 32 * 1024 * 1024;   // the page sends 16 MB; twice that is the most one piece may be
const OPEN_PER_LINK = 6;              // unfinished uploads one link may have staged at once
const STALE_MS = 6 * 60 * 60 * 1000;  // an unfinished upload older than this is swept

// Limits an administrator can change (Settings -> Network, limits & calls).
const DEFAULTS = { link_upload_max_mb: 10240, link_upload_max_files: 5000, link_upload_total_gb: 100 };
async function num(key) { const n = parseInt(await settings.getOrEnv(key) || '', 10); return Number.isFinite(n) && n > 0 ? n : DEFAULTS[key]; }
async function limits() {
  const [mb, files, gb] = await Promise.all([num('link_upload_max_mb'), num('link_upload_max_files'), num('link_upload_total_gb')]);
  return { maxFileMb: mb, maxFileBytes: mb * 1024 * 1024, maxFiles: files, maxTotalBytes: gb * 1024 * 1024 * 1024 };
}

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
async function baseDir() {
  if (process.env.LINK_UPLOAD_TMP) return process.env.LINK_UPLOAD_TMP; // an operator's choice of scratch disk (and each test suite's own)
  let local = false; try { local = await storage.isLocalProvider(); } catch { /* not local: the system's temp folder */ }
  return local ? path.join(await storage.localBase(), '.uploads', 'ext') : path.join(os.tmpdir(), 'depot-ext-uploads');
}
async function encKey() { try { return encryption.resolveKey(await settings.getOrEnv('storage_encryption_key')); } catch { return null; } }

class ChunkError extends Error { constructor(status, message, extra) { super(message); this.status = status; this.extra = extra || {}; } }

// Is this request one piece of a chunked upload? (Otherwise it is the old single multipart.)
const isChunked = (req) => !!req.headers['x-upload-id'];

function header(req) {
  const id = String(req.headers['x-upload-id'] || '');
  const offset = Number(req.headers['x-upload-offset']), total = Number(req.headers['x-upload-total']);
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) throw new ChunkError(400, 'Bad upload id');
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(total) || total < 0 || offset > total) throw new ChunkError(400, 'Bad upload position');
  const dec = (h) => { try { return decodeURIComponent(String(req.headers[h] || '')); } catch { return ''; } };
  return { id, offset, total, name: dec('x-upload-name'), at: dec('x-upload-path'), rel: dec('x-upload-rel') };
}

async function readMeta(dir) { try { return JSON.parse(await fs.readFile(path.join(dir, 'meta.json'), 'utf8')); } catch { return null; } }

// Too many unfinished uploads on one link: sweep the abandoned ones, then refuse.
async function roomForAnother(base, linkPrefix) {
  let names = []; try { names = (await fs.readdir(base)).filter(n => n.startsWith(linkPrefix)); } catch { return; }
  if (names.length < OPEN_PER_LINK) return;
  let open = 0;
  for (const n of names) {
    const p = path.join(base, n); const st = await fs.stat(p).catch(() => null);
    if (st && Date.now() - st.mtimeMs > STALE_MS) await fs.rm(p, { recursive: true, force: true }).catch(() => {}); else open++;
  }
  if (open >= OPEN_PER_LINK) throw new ChunkError(429, 'Too many uploads are in progress on this link. Let some finish, then try again.');
}

// Stage one piece. `linkKey` is ours ("folder:<link id>"); `first(h)` runs before the first
// piece is accepted and may throw a ChunkError (file type, size, quota, disk).
// Resolves { done: false, received } or { done: true, size, name, at, rel, stream(), cleanup() }.
async function accept(req, { linkKey, maxFileBytes, first }) {
  const h = header(req);
  if (h.total > maxFileBytes) throw new ChunkError(413, `That file is larger than the ${Math.round(maxFileBytes / 1048576).toLocaleString('en-US')} MB limit for this link.`);
  const base = await baseDir();
  const linkPrefix = sha(linkKey).slice(0, 16) + '-';
  const dir = path.join(base, linkPrefix + sha(linkKey + '|' + h.id).slice(0, 32));
  let meta = await readMeta(dir);
  if (!meta) {
    if (h.offset !== 0) throw new ChunkError(409, 'This upload has to start again.', { received: 0 });
    if (first) await first(h);
    await roomForAnother(base, linkPrefix);
    await fs.mkdir(dir, { recursive: true });
    meta = { total: h.total, name: h.name, at: h.at, rel: h.rel, received: 0, parts: 0 };
  }
  if (meta.total !== h.total) throw new ChunkError(409, 'This upload has to start again.', { received: 0, restart: true });
  // Pieces arrive in order. A piece we already have (its answer was lost) is told where we are.
  if (h.offset !== meta.received) throw new ChunkError(409, 'Out of step', { received: meta.received });

  const want = Math.min(PIECE_MAX, meta.total - meta.received);
  const part = path.join(dir, `${meta.parts}.part`), tmp = `${part}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const key = await encKey();
  let bytes = 0;
  try {
    if (key) { // no plaintext on disk: a piece is small enough to encrypt whole
      const bufs = [];
      for await (const c of req) { bytes += c.length; if (bytes > want) throw new ChunkError(413, 'That piece is larger than it said it was.'); bufs.push(c); }
      await fs.writeFile(tmp, encryption.encrypt(Buffer.concat(bufs), key));
    } else {
      await new Promise((resolve, reject) => {
        const out = fsSync.createWriteStream(tmp);
        req.on('data', (c) => { bytes += c.length; if (bytes > want) { const e = new ChunkError(413, 'That piece is larger than it said it was.'); req.unpipe(out); out.destroy(); reject(e); } });
        req.on('error', reject); req.on('aborted', () => reject(new ChunkError(400, 'Upload interrupted'))); out.on('error', reject); out.on('finish', resolve);
        req.pipe(out);
      });
    }
    if (!bytes && meta.total > 0) throw new ChunkError(400, 'Empty piece');
    await fs.rename(tmp, part);
  } catch (e) {
    await fs.unlink(tmp).catch(() => {});
    if (!meta.parts) await fs.rm(dir, { recursive: true, force: true }).catch(() => {}); // nothing kept: leave nothing behind
    throw e;
  }

  meta.received += bytes; meta.parts += 1;
  await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta));
  const cleanup = () => fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  if (meta.received < meta.total) return { done: false, received: meta.received };
  if (meta.received > meta.total) { await cleanup(); throw new ChunkError(400, 'More was sent than the file holds.'); }
  const parts = meta.parts;
  const stream = () => Readable.from((async function* () {
    for (let i = 0; i < parts; i++) {
      const p = path.join(dir, `${i}.part`);
      if (key) yield encryption.decrypt(await fs.readFile(p), key);
      else for await (const c of fsSync.createReadStream(p)) yield c;
    }
  })());
  return { done: true, size: meta.total, name: meta.name, at: meta.at, rel: meta.rel, stream, cleanup };
}

// Answers a ChunkError; returns false for anything else.
function sendError(res, e) {
  if (!(e instanceof ChunkError)) return false;
  res.status(e.status).json({ error: e.message, ...e.extra }); return true;
}

module.exports = { accept, isChunked, limits, sendError, ChunkError, DEFAULTS, PIECE_MAX, OPEN_PER_LINK, _baseDir: baseDir };

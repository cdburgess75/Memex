'use strict';
// Lazy, cached thumbnail generation for file cards.
//
// One entry point — getThumbnail(doc) — returns a small WEBP preview of a
// document's first page/frame, or null when the type isn't previewable or
// rendering fails (the caller then falls back to a plain type label). Thumbnails
// are generated on first view and cached in the same object store as the
// originals (thumbnails/<key>.webp), so they inherit at-rest encryption, S3, and
// backup for free. Nothing is pre-generated on upload — there is no worker, and
// the mp4-faststart derivative already sets the on-the-fly precedent.
//
// Renderers by type:
//   image  → sharp (resize/crop, honors EXIF orientation)
//   pdf    → poppler `pdftoppm` (page 1 → png) → sharp
//   office → Collabora `convert-to/pdf` (internal network) → pdf path
//   video  → ffmpeg (frame ~1s in) → sharp
// poppler-utils and ffmpeg are provided by the container image; sharp is a
// production dependency. A missing binary or a disabled Collabora just yields
// null (graceful fallback), never a 500.
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);
const storage = require('./storage');
const settings = require('./settings');

// sharp pulls in libvips; require it lazily so merely importing this module
// (e.g. in unit tests that only exercise the pure helpers) needs no native lib.
let _sharp = null;
function getSharp() { if (!_sharp) _sharp = require('sharp'); return _sharp; }

// Target well is 4:3; render at ~2x for crisp cards on retina.
const THUMB_W = 480;
const THUMB_H = 360;
const WEBP_QUALITY = 72;
// Don't attempt to render enormous sources in the request path.
const MAX_SOURCE_BYTES = 100 * 1024 * 1024;
const CONVERT_TIMEOUT_MS = 45000;

const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tif', 'tiff'];
// HEIC/HEIF (iPhone photos): sharp's prebuilt libvips can't decode HEVC, but the
// bundled ffmpeg can — decode one frame to PNG, then size it like any image.
const HEIC_EXTS = ['heic', 'heif'];
const PDF_EXTS = ['pdf'];
const OFFICE_EXTS = ['docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'odt', 'ods', 'odp', 'rtf', 'csv'];
const VIDEO_EXTS = ['mp4', 'webm', 'ogv', 'm4v', 'mov'];
// Rendered as a "page of text" card (first lines drawn onto a document). HTML is
// reduced to its readable text first.
const TEXT_EXTS = ['txt', 'md', 'markdown', 'log', 'html', 'htm'];
// Rendered as an email card: sender · subject · snippet.
const EML_EXTS = ['eml'];
// Rendered as a contents summary: N files · M folders · unpacked size. p7zip's
// `7z l` lists nearly every archive format, so one path covers the whole family.
const ARCHIVE_EXTS = ['zip', '7z', 'tar', 'tgz', 'gz', 'bz2', 'xz', 'rar', 'cab', 'iso', 'arj', 'wim', 'lzma', 'lzh', 'zst', 'tbz', 'tbz2', 'txz'];

function extOf(doc) {
  return String((doc && doc.name) || '').split('.').pop().toLowerCase();
}

function canThumbnail(ext) {
  return IMAGE_EXTS.includes(ext) || HEIC_EXTS.includes(ext) || PDF_EXTS.includes(ext)
    || OFFICE_EXTS.includes(ext) || VIDEO_EXTS.includes(ext)
    || TEXT_EXTS.includes(ext) || EML_EXTS.includes(ext) || ARCHIVE_EXTS.includes(ext);
}

// Content-addressed when we have a hash (identical files share one thumbnail and
// it invalidates automatically when the bytes change); per-document otherwise
// (content_hash is only computed for files <= 25 MB).
function thumbKey(doc) {
  const id = (doc && doc.content_hash) || (doc && doc.id);
  return `thumbnails/${id}.webp`;
}

// Write `buffer` to a private temp file, run `fn(inPath, dir)`, always clean up.
async function withTempFile(buffer, ext, fn) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mxthumb-'));
  const inPath = path.join(dir, `src${ext}`);
  try {
    await fs.promises.writeFile(inPath, buffer);
    return await fn(inPath, dir);
  } finally {
    fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// Fit any rendered PNG/JPEG buffer into the card well as WEBP.
async function fitWebp(buffer, position) {
  return getSharp()(buffer, { failOn: 'none' })
    .resize(THUMB_W, THUMB_H, { fit: 'cover', position: position || 'centre' })
    .webp({ quality: WEBP_QUALITY })
    .toBuffer();
}

async function imageThumb(buffer) {
  // rotate() with no arg applies EXIF orientation; failOn:'none' tolerates
  // slightly corrupt but decodable images.
  return getSharp()(buffer, { failOn: 'none', animated: false })
    .rotate()
    .resize(THUMB_W, THUMB_H, { fit: 'cover', position: 'attention' })
    .webp({ quality: WEBP_QUALITY })
    .toBuffer();
}

async function pdfThumb(buffer) {
  return withTempFile(buffer, '.pdf', async (inPath, dir) => {
    const outPrefix = path.join(dir, 'page');
    // -singlefile → predictable "page.png"; -scale-to sets the long edge.
    await execFileP('pdftoppm', ['-png', '-f', '1', '-l', '1', '-singlefile', '-scale-to', '900', inPath, outPrefix], { timeout: CONVERT_TIMEOUT_MS });
    const png = await fs.promises.readFile(`${outPrefix}.png`);
    return fitWebp(png, 'top'); // documents read from the top
  });
}

async function videoThumb(buffer, ext) {
  return withTempFile(buffer, `.${ext}`, async (inPath, dir) => {
    const outPath = path.join(dir, 'frame.png');
    // -ss before -i = fast seek to ~1s; one frame out.
    await execFileP('ffmpeg', ['-y', '-ss', '1', '-i', inPath, '-frames:v', '1', outPath], { timeout: CONVERT_TIMEOUT_MS });
    const png = await fs.promises.readFile(outPath);
    return fitWebp(png, 'centre');
  });
}

async function heicThumb(buffer, ext) {
  return withTempFile(buffer, `.${ext}`, async (inPath, dir) => {
    const outPath = path.join(dir, 'frame.png');
    // No -ss: HEIC is a single still, so seeking would fail.
    await execFileP('ffmpeg', ['-y', '-i', inPath, '-frames:v', '1', outPath], { timeout: CONVERT_TIMEOUT_MS });
    const png = await fs.promises.readFile(outPath);
    return fitWebp(png, 'attention');
  });
}

// Office → PDF via the already-running Collabora, then the PDF path. Uses the
// INTERNAL docker network only (never the public proxy). Returns null when
// Collabora is disabled/unreachable, so Office simply falls back to a label.
async function collaboraToPdf(buffer, ext) {
  const base = String((await settings.getOrEnv('collabora_internal_url')) || 'http://collabora:9980').replace(/\/+$/, '');
  const form = new FormData();
  form.append('data', new Blob([buffer]), `input.${ext}`);
  const resp = await fetch(`${base}/cool/convert-to/pdf`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(CONVERT_TIMEOUT_MS),
  });
  if (!resp.ok) return null;
  const pdf = Buffer.from(await resp.arrayBuffer());
  return pdf.length ? pdf : null;
}

async function officeThumb(buffer, ext) {
  const pdf = await collaboraToPdf(buffer, ext);
  if (!pdf) return null;
  return pdfThumb(pdf);
}

// ---- SVG-drawn cards (text / email / archive) -----------------------------
// These types have no page to rasterize, so we compose a small card ourselves
// and let sharp rasterize the SVG (libvips renders SVG text with the container's
// fonts). All are authored at the well's native 4:3 (480x360).

function svgEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function sizeLabel(bytes) {
  bytes = Number(bytes) || 0;
  if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(1).replace(/\.0$/, '') + ' GB';
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1).replace(/\.0$/, '') + ' MB';
  if (bytes >= 1024) return Math.round(bytes / 1024) + ' KB';
  return bytes + ' B';
}
// Greedy word-wrap into at most maxLines of ~maxCols chars; ellipsis if clipped.
function wrapText(text, maxCols, maxLines) {
  const words = String(text || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if (!cur) { cur = w; continue; }
    if ((cur + ' ' + w).length <= maxCols) cur += ' ' + w;
    else { lines.push(cur); cur = w; if (lines.length >= maxLines) break; }
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  if (lines.length >= maxLines && (words.join(' ').length > lines.join(' ').length)) {
    lines[maxLines - 1] = lines[maxLines - 1].replace(/.{1}$/, '…');
  }
  return lines.slice(0, maxLines);
}
async function svgToWebp(svg) {
  return getSharp()(Buffer.from(svg), { density: 144 }).webp({ quality: WEBP_QUALITY }).toBuffer();
}

const MONO = 'DejaVu Sans Mono, ui-monospace, monospace';
const SANS = 'DejaVu Sans, -apple-system, Segoe UI, sans-serif';

function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|div|br|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

async function textThumb(buffer, ext) {
  let text = buffer.slice(0, 12000).toString('utf8');
  if (ext === 'html' || ext === 'htm') text = htmlToText(text);
  const rows = text.replace(/\r/g, '').replace(/\t/g, '  ').split('\n').slice(0, 15).map((ln) => {
    let s = ln.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
    if (s.length > 56) s = s.slice(0, 55) + '…';
    return s;
  });
  const body = rows.map((ln, i) => `<text x="26" y="${44 + i * 20.5}" font-family="${MONO}" font-size="13" fill="#3a3f45" xml:space="preserve">${svgEscape(ln)}</text>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">`
    + `<rect width="480" height="360" fill="#ffffff"/><rect width="480" height="7" fill="#e9ebef"/>`
    + `<rect x="20" y="20" width="120" height="9" rx="2" fill="#eef0f3"/>${body}</svg>`;
  return svgToWebp(svg);
}

function decodeMimeWords(s) {
  return String(s || '').replace(/=\?[^?]+\?([bBqQ])\?([^?]*)\?=/g, (_, enc, txt) => {
    try {
      if (enc.toLowerCase() === 'b') return Buffer.from(txt, 'base64').toString('utf8');
      return txt.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (__, h) => String.fromCharCode(parseInt(h, 16)));
    } catch { return txt; }
  }).replace(/\s+/g, ' ').trim();
}
function parseEml(buffer) {
  const s = buffer.toString('utf8', 0, 24000);
  const sep = s.indexOf('\r\n\r\n') >= 0 ? '\r\n\r\n' : '\n\n';
  const idx = s.indexOf(sep);
  const head = idx >= 0 ? s.slice(0, idx) : s;
  let body = idx >= 0 ? s.slice(idx + sep.length) : '';
  const getH = (name) => { const m = head.match(new RegExp('^' + name + ':[ \\t]*([\\s\\S]*?)(?=\\n[^ \\t]|$)', 'im')); return m ? decodeMimeWords(m[1]) : ''; };
  // Drop MIME boundaries / part headers, and any HTML, so the snippet reads as prose.
  body = body.replace(/^--[^\n]*$/gm, '').replace(/^(Content-[^\n]*|MIME-Version:[^\n]*)$/gim, '');
  if (/<html|<body|<div|<p[ >]/i.test(body)) body = htmlToText(body);
  const snippet = body.replace(/\s+/g, ' ').trim();
  return { from: getH('From'), subject: getH('Subject'), snippet };
}
async function emlThumb(buffer) {
  const { from, subject, snippet } = parseEml(buffer);
  const subjLines = wrapText(subject || '(no subject)', 40, 2);
  const snipLines = wrapText(snippet || 'No preview text.', 48, 6);
  const subjSvg = subjLines.map((ln, i) => `<text x="26" y="${132 + i * 26}" font-family="${SANS}" font-size="19" font-weight="700" fill="#1b1e23">${svgEscape(ln)}</text>`).join('');
  const startSnip = 132 + subjLines.length * 26 + 22;
  const snipSvg = snipLines.map((ln, i) => `<text x="26" y="${startSnip + i * 21}" font-family="${SANS}" font-size="14" fill="#5c6069">${svgEscape(ln)}</text>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">`
    + `<rect width="480" height="360" fill="#ffffff"/><rect width="480" height="58" fill="#0E6FA8"/>`
    + `<text x="26" y="37" font-family="${SANS}" font-size="15" font-weight="700" fill="#ffffff" letter-spacing="1">EMAIL</text>`
    + `<text x="26" y="92" font-family="${SANS}" font-size="14" fill="#8b8f98">From</text>`
    + `<text x="82" y="92" font-family="${SANS}" font-size="14" font-weight="600" fill="#1b1e23">${svgEscape((from || 'Unknown sender').slice(0, 42))}</text>`
    + subjSvg
    + `<line x1="26" y1="${startSnip - 16}" x2="454" y2="${startSnip - 16}" stroke="#e4e4e8"/>`
    + snipSvg + `</svg>`;
  return svgToWebp(svg);
}

async function archiveCounts(inPath) {
  const { stdout } = await execFileP('7z', ['l', inPath], { timeout: CONVERT_TIMEOUT_MS, maxBuffer: 24 * 1024 * 1024 });
  const isCruft = (name) => {
    const base = name.split('/').pop();
    return name.startsWith('__MACOSX/') || name === '__MACOSX' || base === '.DS_Store' || base.startsWith('._');
  };
  let files = 0, folders = 0, bytes = 0;
  for (const line of stdout.split('\n')) {
    const m = line.match(/^\d{4}-\d\d-\d\d\s+\d\d:\d\d:\d\d\s+([D.])[A-Za-z.]{4}\s+(\d+)\s+\d+\s+(.+)$/);
    if (!m) continue;
    const name = m[3].trim();
    if (isCruft(name)) continue;
    if (m[1] === 'D') folders++;
    else { files++; bytes += Number(m[2]) || 0; }
  }
  return { files, folders, bytes };
}
async function archiveThumb(buffer, ext) {
  const counts = await withTempFile(buffer, `.${ext}`, (inPath) => archiveCounts(inPath));
  if (!counts || (!counts.files && !counts.folders)) return null;
  const fileLine = `${counts.files.toLocaleString()} file${counts.files === 1 ? '' : 's'}`;
  const folderLine = `${counts.folders.toLocaleString()} folder${counts.folders === 1 ? '' : 's'}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">`
    + `<rect width="480" height="360" fill="#f4f4f6"/>`
    // archive glyph
    + `<g transform="translate(210,74)" fill="none" stroke="#8b8f98" stroke-width="4" stroke-linejoin="round">`
    + `<rect x="0" y="8" width="60" height="46" rx="4"/><path d="M0 20 h60"/><rect x="24" y="0" width="12" height="16" fill="#8b8f98" stroke="none"/>`
    + `<rect x="26" y="26" width="8" height="8" fill="#8b8f98" stroke="none"/></g>`
    + `<text x="240" y="188" text-anchor="middle" font-family="${SANS}" font-size="30" font-weight="700" fill="#17191d">${svgEscape(fileLine)}</text>`
    + `<text x="240" y="224" text-anchor="middle" font-family="${SANS}" font-size="19" fill="#5c6069">${svgEscape(folderLine)}</text>`
    + `<text x="240" y="268" text-anchor="middle" font-family="${MONO}" font-size="15" fill="#8b8f98">${svgEscape(sizeLabel(counts.bytes))} unpacked</text>`
    + `<text x="240" y="322" text-anchor="middle" font-family="${MONO}" font-size="14" font-weight="700" fill="#8b8f98" letter-spacing="1">${svgEscape((ext || 'archive').toUpperCase())}</text>`
    + `</svg>`;
  return svgToWebp(svg);
}

async function render(buffer, ext) {
  if (IMAGE_EXTS.includes(ext)) return imageThumb(buffer);
  if (HEIC_EXTS.includes(ext)) return heicThumb(buffer, ext);
  if (PDF_EXTS.includes(ext)) return pdfThumb(buffer);
  if (VIDEO_EXTS.includes(ext)) return videoThumb(buffer, ext);
  if (OFFICE_EXTS.includes(ext)) return officeThumb(buffer, ext);
  if (TEXT_EXTS.includes(ext)) return textThumb(buffer, ext);
  if (EML_EXTS.includes(ext)) return emlThumb(buffer);
  if (ARCHIVE_EXTS.includes(ext)) return archiveThumb(buffer, ext);
  return null;
}

// Main entry: cached WEBP buffer for a document row, or null. `doc` needs
// { id, name, size, storage_path } and optionally content_hash.
async function getThumbnail(doc) {
  const ext = extOf(doc);
  if (!canThumbnail(ext)) return null;
  const key = thumbKey(doc);

  // 1) Cache hit.
  try {
    const cached = await storage.download(key);
    if (cached && cached.length) return cached;
  } catch { /* miss → generate */ }

  // 2) Generate.
  if ((Number(doc.size) || 0) > MAX_SOURCE_BYTES) return null;
  let src;
  try { src = await storage.download(doc.storage_path); } catch { return null; }

  let out = null;
  try { out = await render(src, ext); } catch { out = null; }
  if (!out || !out.length) return null;

  // Best-effort cache; still serve the freshly rendered bytes if the write fails.
  try { await storage.upload(key, out, 'image/webp'); } catch { /* non-fatal */ }
  return out;
}

module.exports = {
  getThumbnail,
  render,
  canThumbnail,
  thumbKey,
  extOf,
  IMAGE_EXTS,
  HEIC_EXTS,
  PDF_EXTS,
  OFFICE_EXTS,
  VIDEO_EXTS,
  TEXT_EXTS,
  EML_EXTS,
  ARCHIVE_EXTS,
};

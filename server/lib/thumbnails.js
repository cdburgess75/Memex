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

function extOf(doc) {
  return String((doc && doc.name) || '').split('.').pop().toLowerCase();
}

function canThumbnail(ext) {
  return IMAGE_EXTS.includes(ext) || HEIC_EXTS.includes(ext) || PDF_EXTS.includes(ext) || OFFICE_EXTS.includes(ext) || VIDEO_EXTS.includes(ext);
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

async function render(buffer, ext) {
  if (IMAGE_EXTS.includes(ext)) return imageThumb(buffer);
  if (HEIC_EXTS.includes(ext)) return heicThumb(buffer, ext);
  if (PDF_EXTS.includes(ext)) return pdfThumb(buffer);
  if (VIDEO_EXTS.includes(ext)) return videoThumb(buffer, ext);
  if (OFFICE_EXTS.includes(ext)) return officeThumb(buffer, ext);
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
  canThumbnail,
  thumbKey,
  extOf,
  IMAGE_EXTS,
  HEIC_EXTS,
  PDF_EXTS,
  OFFICE_EXTS,
  VIDEO_EXTS,
};

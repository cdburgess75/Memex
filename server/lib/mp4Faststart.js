'use strict';
// On-the-fly MP4 "fast start" for inline preview. A non-web-optimized MP4 has its
// `moov` metadata atom at the END of the file, so a browser can't render a frame
// until it fetches the tail — huge files just spin. This serves a fast-started VIEW
// without modifying the stored file: it relocates the (small) moov atom to the front
// as the response streams, rewriting its chunk-offset tables, and keeps the big mdat
// on disk (memory-safe). Range is supported over the virtual layout so seeking works.
//
// Scope: local, unencrypted MP4/MOV/M4V where moov is the last top-level box and
// comes after mdat. Anything else returns null and the caller falls back to normal
// streaming — so this can only ever help, never break a download.
const fsSync = require('fs');
const fs = fsSync.promises;
const { Readable } = require('stream');

const MAX_MOOV = 64 * 1024 * 1024; // don't buffer an absurd moov
// Container boxes we recurse into to find the chunk-offset tables (stco/co64 live
// under moov > trak > mdia > minf > stbl).
const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'udta']);

function parseRange(rangeHeader, totalSize) {
  if (!rangeHeader || !Number.isFinite(totalSize) || totalSize <= 0) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader).trim());
  if (!m) return null;
  let start = m[1] === '' ? null : parseInt(m[1], 10);
  let end = m[2] === '' ? null : parseInt(m[2], 10);
  if (start === null && end === null) return null;
  if (start === null) { start = Math.max(0, totalSize - end); end = totalSize - 1; }
  else if (end === null || end >= totalSize) { end = totalSize - 1; }
  if (start > end || start >= totalSize) return { unsatisfiable: true };
  return { start, end };
}

// Rewrite every stco (32-bit) / co64 (64-bit) chunk offset in a moov buffer by
// +delta. Returns false if a 32-bit offset would overflow (caller then bails).
function rewriteChunkOffsets(buf, delta) {
  let ok = true;
  (function walk(start, end) {
    let p = start;
    while (p + 8 <= end && ok) {
      let size = buf.readUInt32BE(p);
      const type = buf.toString('latin1', p + 4, p + 8);
      let headerSize = 8;
      if (size === 1) { if (p + 16 > end) break; size = Number(buf.readBigUInt64BE(p + 8)); headerSize = 16; }
      else if (size === 0) { size = end - p; }
      if (size < headerSize || p + size > end) break;
      if (type === 'stco') {
        const count = buf.readUInt32BE(p + headerSize + 4);
        let q = p + headerSize + 8;
        for (let i = 0; i < count && q + 4 <= p + size; i++, q += 4) {
          const val = buf.readUInt32BE(q) + delta;
          if (val > 0xffffffff) { ok = false; return; }
          buf.writeUInt32BE(val, q);
        }
      } else if (type === 'co64') {
        const count = buf.readUInt32BE(p + headerSize + 4);
        let q = p + headerSize + 8;
        for (let i = 0; i < count && q + 8 <= p + size; i++, q += 8) {
          buf.writeBigUInt64BE(buf.readBigUInt64BE(q) + BigInt(delta), q);
        }
      } else if (CONTAINERS.has(type)) {
        walk(p + headerSize, p + size);
      }
      p += size;
    }
  })(0, buf.length);
  return ok;
}

// Read the top-level box list. Returns [{type, off, size}] or null if unparseable.
async function topLevelBoxes(fd, fileSize) {
  const boxes = [];
  const hdr = Buffer.alloc(16);
  let off = 0;
  while (off < fileSize) {
    const { bytesRead } = await fd.read(hdr, 0, 16, off);
    if (bytesRead < 8) break;
    let size = hdr.readUInt32BE(0);
    const type = hdr.toString('latin1', 4, 8);
    let headerSize = 8;
    if (size === 1) { if (bytesRead < 16) break; size = Number(hdr.readBigUInt64BE(8)); headerSize = 16; }
    else if (size === 0) { size = fileSize - off; }
    if (!/^[\x20-\x7e]{4}$/.test(type) || size < headerSize || off + size > fileSize) return boxes.length ? boxes : null;
    boxes.push({ type, off, size });
    off += size;
  }
  return boxes;
}

// Build a fast-start plan for a file path, or null when it isn't a
// simple non-fast-start MP4 (already fast-start, encrypted, exotic, etc.).
async function plan(fullPath) {
  let fd;
  try { fd = await fs.open(fullPath, 'r'); } catch { return null; }
  try {
    const stat = await fd.stat();
    const boxes = await topLevelBoxes(fd, stat.size);
    if (!boxes || !boxes.length || boxes[0].type !== 'ftyp') return null;
    const moovIdx = boxes.findIndex(b => b.type === 'moov');
    const mdatIdx = boxes.findIndex(b => b.type === 'mdat');
    if (moovIdx < 0 || mdatIdx < 0) return null;
    if (moovIdx < mdatIdx) return null;                 // already fast-start
    if (moovIdx !== boxes.length - 1) return null;      // only the simple "moov is last" case
    const moov = boxes[moovIdx];
    if (moov.size > MAX_MOOV) return null;

    const moovBuf = Buffer.alloc(moov.size);
    const { bytesRead } = await fd.read(moovBuf, 0, moov.size, moov.off);
    if (bytesRead !== moov.size) return null;
    if (!rewriteChunkOffsets(moovBuf, moov.size)) return null; // offset overflow → bail

    // Reorder: keep every box, but move moov to just before the first mdat.
    const ordered = [];
    for (const b of boxes) {
      if (b === moov) continue;
      if (b === boxes[mdatIdx]) ordered.push({ moovBuf, size: moov.size });
      ordered.push(b);
    }
    let v = 0;
    const segments = ordered.map(b => {
      const seg = b.moovBuf
        ? { vStart: v, vEnd: v + b.size - 1, buf: b.moovBuf }
        : { vStart: v, vEnd: v + b.size - 1, fileStart: b.off };
      v += b.size;
      return seg;
    });
    return { totalSize: v, segments, fullPath };
  } catch {
    return null;
  } finally {
    await fd.close().catch(() => {});
  }
}

// Given a plan, return { stream, length, totalSize, range } (or { unsatisfiable })
// for the requested Range, streaming only the needed bytes of the virtual layout.
function createStream(p, rangeHeader) {
  const r = parseRange(rangeHeader, p.totalSize);
  if (r && r.unsatisfiable) return { unsatisfiable: true, totalSize: p.totalSize };
  const start = r ? r.start : 0;
  const end = r ? r.end : p.totalSize - 1;
  const segments = p.segments;
  const fullPath = p.fullPath;
  const stream = Readable.from((async function* () {
    for (const seg of segments) {
      if (seg.vEnd < start || seg.vStart > end) continue;
      const from = Math.max(start, seg.vStart);
      const to = Math.min(end, seg.vEnd);
      if (seg.buf) {
        yield seg.buf.subarray(from - seg.vStart, to - seg.vStart + 1);
      } else {
        const rs = fsSync.createReadStream(fullPath, { start: seg.fileStart + (from - seg.vStart), end: seg.fileStart + (to - seg.vStart) });
        for await (const chunk of rs) yield chunk;
      }
    }
  })());
  return { stream, length: end - start + 1, totalSize: p.totalSize, range: r ? { start, end } : null };
}

module.exports = { plan, createStream, rewriteChunkOffsets, parseRange, topLevelBoxes };

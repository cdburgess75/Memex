'use strict';
const crypto = require('crypto');

const MAGIC = Buffer.from('MXEC');
const ALGO  = 'aes-256-gcm';

// Derive a 32-byte key from a passphrase using scrypt.
// Salt is fixed because this is at-rest encryption, not password hashing.
function deriveKey(passphrase) {
  return crypto.scryptSync(passphrase, 'memex-local-enc-v1', 32);
}

// Accept either a 64-char hex string (used verbatim as 32 raw bytes)
// or any other string (scrypt-derived). Returns null for falsy input.
function resolveKey(raw) {
  if (!raw) return null;
  return /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : deriveKey(raw);
}

// Wire format: MAGIC(4) + IV(12) + AUTH_TAG(16) + CIPHERTEXT(n)
function encrypt(buf, key) {
  const iv     = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct     = Buffer.concat([cipher.update(buf), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ct]);
}

// Decrypts either wire format (single message above, or segmented below). Anything
// without a magic comes back unchanged: it predates encryption.
function decrypt(buf, key) {
  if (buf.length >= SEG_HEADER_LEN && buf.subarray(0, 4).equals(SEG_MAGIC)) return decryptSegmented(buf, key);
  if (buf.length < 32 || !buf.slice(0, 4).equals(MAGIC)) return buf;
  const iv  = buf.slice(4, 16);
  const tag = buf.slice(16, 32);
  const ct  = buf.slice(32);
  const dec = crypto.createDecipheriv(ALGO, key, iv);
  dec.setAuthTag(tag);
  return Buffer.concat([dec.update(ct), dec.final()]);
}

// ─── Segmented format (stored files) ────────────────────────────────────────
// One GCM message tops out at 2^36 - 32 bytes (64 GiB) per key/IV, so a stored file
// is sealed as a run of fixed-size segments instead (the STREAM construction):
//
//   header: MAGIC 'MXES'(4) + VERSION(1) + SEGMENT_SIZE(4, BE) + SALT(32) + NONCE_PREFIX(7)
//   then:   per segment, CIPHERTEXT(segment size; the last may be shorter) + TAG(16)
//
// Each file gets its own key, HKDF(master key, salt), so nonces never repeat across
// files however many there are. A segment's nonce is NONCE_PREFIX + its index (4, BE)
// + a last-segment flag (1), and every segment authenticates the header as AAD: a
// segment can't be moved, dropped, or reordered, the file can't be cut short at a
// segment boundary, and the header can't be edited without decryption failing.
// Segments decrypt on their own, so a byte range reads only the segments it covers,
// and no plaintext is released before its segment's tag has checked out.
const SEG_MAGIC = Buffer.from('MXES');
const SEG_VERSION = 1;
const SEG_HEADER_LEN = 4 + 1 + 4 + 32 + 7;
const SEG_TAG_LEN = 16;
// Big enough that per-segment cipher setup is noise next to the AES work (at 64 KiB it
// halves throughput), small enough that a range read decrypts at most ~2 MiB it skips.
const SEGMENT_SIZE = 1024 * 1024;
const MAX_SEGMENT_SIZE = 16 * 1024 * 1024; // a header claiming more is corrupt (and would make us buffer it)
const MAX_SEGMENTS = 2 ** 32;              // the index is 4 bytes

function corrupt(why) {
  const err = new Error(`Encrypted file is damaged or was not written by this server (${why})`);
  err.code = 'ENCRYPTED_FILE_INVALID';
  return err;
}

function fileKey(key, salt) {
  return Buffer.from(crypto.hkdfSync('sha256', key, salt, 'memex-segmented-v1', 32));
}

function segmentNonce(prefix, index, last) {
  const nonce = Buffer.alloc(12);
  prefix.copy(nonce, 0);
  nonce.writeUInt32BE(index, 7);
  nonce[11] = last ? 1 : 0;
  return nonce;
}

// A fresh header plus the function that seals its segments in order. A segment's
// plaintext can come in several pieces; it comes back as ciphertext pieces + tag.
function segmentSealer(key, segmentSize) {
  const header = Buffer.alloc(SEG_HEADER_LEN);
  SEG_MAGIC.copy(header, 0);
  header[4] = SEG_VERSION;
  header.writeUInt32BE(segmentSize, 5);
  crypto.randomFillSync(header, 9, 32 + 7);
  const prefix = header.subarray(41, 48);
  const k = fileKey(key, header.subarray(9, 41));
  let index = 0;
  return {
    header,
    seal(pieces, last) {
      if (index >= MAX_SEGMENTS) throw new Error('File is too large to encrypt');
      const c = crypto.createCipheriv(ALGO, k, segmentNonce(prefix, index++, last));
      c.setAAD(header);
      const out = pieces.map(p => c.update(p));
      c.final(); // GCM: no output, just finishes the tag
      out.push(c.getAuthTag());
      return out;
    },
  };
}

function segmentOpener(key, hdr) {
  const k = fileKey(key, hdr.salt);
  return function open(sealed, index, last) {
    if (sealed.length < SEG_TAG_LEN) throw corrupt('segment cut short');
    const d = crypto.createDecipheriv(ALGO, k, segmentNonce(hdr.prefix, index, last));
    d.setAAD(hdr.header);
    d.setAuthTag(sealed.subarray(sealed.length - SEG_TAG_LEN));
    const plaintext = d.update(sealed.subarray(0, sealed.length - SEG_TAG_LEN));
    d.final(); // throws unless the tag checks out; GCM has no further output
    return plaintext;
  };
}

// The segmented header at the start of buf, or null when buf isn't in this format.
function parseSegmentedHeader(buf) {
  if (buf.length < SEG_HEADER_LEN || !buf.subarray(0, 4).equals(SEG_MAGIC)) return null;
  if (buf[4] !== SEG_VERSION) throw corrupt(`unknown version ${buf[4]}`);
  const segmentSize = buf.readUInt32BE(5);
  if (segmentSize < 1 || segmentSize > MAX_SEGMENT_SIZE) throw corrupt('bad segment size');
  const header = Buffer.from(buf.subarray(0, SEG_HEADER_LEN));
  return { header, segmentSize, salt: header.subarray(9, 41), prefix: header.subarray(41, 48) };
}

// Plaintext size and segment count of a segmented file, from its size on disk.
function segmentedLayout(hdr, fileSize) {
  const body = fileSize - SEG_HEADER_LEN;
  const sealedSize = hdr.segmentSize + SEG_TAG_LEN;
  const segments = Math.ceil(body / sealedSize);
  const tail = body - (segments - 1) * sealedSize;
  // Only an empty file has an empty last segment; anything shorter than a tag is cut short.
  if (body < SEG_TAG_LEN || tail < SEG_TAG_LEN || (tail === SEG_TAG_LEN && segments > 1)) throw corrupt('file cut short');
  return { plainSize: body - segments * SEG_TAG_LEN, segments };
}

// Which bytes of the file to read for plaintext bytes start..end (inclusive; the whole
// file when range is null), and how to trim the segments that come back.
function segmentedReadPlan(hdr, fileSize, range) {
  const { plainSize, segments } = segmentedLayout(hdr, fileSize);
  const sealedSize = hdr.segmentSize + SEG_TAG_LEN;
  const start = range ? range.start : 0;
  const length = range ? range.end - range.start + 1 : plainSize;
  const first = range ? Math.floor(start / hdr.segmentSize) : 0;
  const last = range ? Math.floor(range.end / hdr.segmentSize) : segments - 1;
  return {
    plainSize,
    readStart: SEG_HEADER_LEN + first * sealedSize,
    readEnd: Math.min(fileSize, SEG_HEADER_LEN + (last + 1) * sealedSize) - 1,
    first, count: last - first + 1, final: segments - 1,
    skip: start - first * hdr.segmentSize, length,
  };
}

// Pipeline stage: plaintext in, a segmented file out. Written as an async generator so
// that anything the cipher throws rejects the pipeline -- a throw inside a Transform's
// _transform escapes the stream and takes the process down.
function encryptSegments(key, { segmentSize = SEGMENT_SIZE } = {}) {
  return async function* (source) {
    const sealer = segmentSealer(key, segmentSize);
    yield sealer.header;
    let pending = [], fill = 0; // the next segment's plaintext, as views of the source chunks
    for await (const chunk of source) {
      for (let off = 0; off < chunk.length;) {
        // A segment is sealed only once more data is known to follow, so the last one
        // (sealed after the loop) always carries the last-segment flag.
        if (fill === segmentSize) { yield* sealer.seal(pending, false); pending = []; fill = 0; }
        const n = Math.min(segmentSize - fill, chunk.length - off);
        pending.push(n === chunk.length ? chunk : chunk.subarray(off, off + n));
        fill += n; off += n;
      }
    }
    yield* sealer.seal(pending, true);
  };
}

// The other direction, for a ciphertext stream read at plan.readStart..plan.readEnd.
// Yields only plaintext whose segment has authenticated.
function decryptSegments(key, hdr, plan) {
  return async function* (source) {
    const open = segmentOpener(key, hdr);
    const sealedSize = hdr.segmentSize + SEG_TAG_LEN;
    let pending = null; // only needed when chunks don't arrive one segment at a time
    let fill = 0, index = plan.first, skip = plan.skip, remaining = plan.length;
    const emit = (sealed) => {
      if (index >= plan.first + plan.count) throw corrupt('unexpected data after the last segment');
      let pt = open(sealed, index, index === plan.final);
      index += 1;
      if (skip) { const n = Math.min(skip, pt.length); pt = pt.subarray(n); skip -= n; }
      if (pt.length > remaining) pt = pt.subarray(0, remaining);
      remaining -= pt.length;
      return pt;
    };
    for await (const chunk of source) {
      let off = 0;
      while (off < chunk.length) {
        if (fill === 0 && chunk.length - off >= sealedSize) {
          const pt = emit(chunk.subarray(off, off + sealedSize));
          off += sealedSize;
          if (pt.length) yield pt;
          continue;
        }
        if (!pending) pending = Buffer.allocUnsafe(sealedSize);
        const n = Math.min(sealedSize - fill, chunk.length - off);
        chunk.copy(pending, fill, off, off + n);
        fill += n; off += n;
        if (fill === sealedSize) {
          const pt = emit(pending);
          fill = 0;
          if (pt.length) yield pt;
        }
      }
    }
    if (fill) {
      if (index !== plan.final) throw corrupt('file cut short');
      const pt = emit(pending.subarray(0, fill));
      if (pt.length) yield pt;
    }
    if (index !== plan.first + plan.count || remaining !== 0) throw corrupt('file cut short');
  };
}

// Whole-buffer versions, for small files that are already in memory.
function encryptSegmented(buf, key, { segmentSize = SEGMENT_SIZE } = {}) {
  const sealer = segmentSealer(key, segmentSize);
  const out = [sealer.header];
  let off = 0;
  while (buf.length - off > segmentSize) { out.push(...sealer.seal([buf.subarray(off, off + segmentSize)], false)); off += segmentSize; }
  out.push(...sealer.seal([buf.subarray(off)], true));
  return Buffer.concat(out);
}

function decryptSegmented(buf, key) {
  const hdr = parseSegmentedHeader(buf);
  const { segments } = segmentedLayout(hdr, buf.length);
  const open = segmentOpener(key, hdr);
  const sealedSize = hdr.segmentSize + SEG_TAG_LEN;
  const out = [];
  for (let i = 0; i < segments; i += 1) {
    const at = SEG_HEADER_LEN + i * sealedSize;
    out.push(open(buf.subarray(at, Math.min(buf.length, at + sealedSize)), i, i === segments - 1));
  }
  return Buffer.concat(out);
}

module.exports = {
  deriveKey, resolveKey, encrypt, decrypt, MAGIC,
  SEG_MAGIC, SEG_HEADER_LEN, SEG_TAG_LEN, SEGMENT_SIZE,
  encryptSegmented, decryptSegmented, encryptSegments, decryptSegments,
  parseSegmentedHeader, segmentedLayout, segmentedReadPlan,
};

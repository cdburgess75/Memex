'use strict';
const settings = require('./settings');

async function PROVIDER() {
  return (await settings.getOrEnv('storage_provider')) || 'local';
}

// ─── Supabase ────────────────────────────────────────────────────────────────

const { createClient } = require('@supabase/supabase-js');
async function supabaseClient() {
  return createClient(
    await settings.getOrEnv('supabase_url'),
    await settings.getOrEnv('supabase_service_role_key')
  );
}

async function supabaseUpload(storagePath, buffer, mimeType) {
  const { error } = await (await supabaseClient()).storage
    .from('documents')
    .upload(storagePath, buffer, { contentType: mimeType, upsert: true });
  if (error) throw error;
}

async function supabaseDownload(storagePath) {
  const { data, error } = await (await supabaseClient()).storage.from('documents').download(storagePath);
  if (error) throw error;
  return Buffer.from(await data.arrayBuffer());
}

async function supabaseDownloadStream(storagePath) {
  const { data, error } = await (await supabaseClient()).storage.from('documents').download(storagePath);
  if (error) throw error;
  const { Readable } = require('stream');
  if (data && typeof data.stream === 'function' && Readable.fromWeb) {
    const length = typeof data.size === 'number' ? data.size : null;
    return { stream: Readable.fromWeb(data.stream()), length, totalSize: length, range: null };
  }
  const buf = Buffer.from(await data.arrayBuffer());
  return { stream: Readable.from(buf), length: buf.length, totalSize: buf.length, range: null };
}

async function supabaseGetUrl(storagePath, ttl) {
  const { data, error } = await (await supabaseClient()).storage
    .from('documents')
    .createSignedUrl(storagePath, ttl);
  if (error) throw error;
  return data.signedUrl;
}

async function supabaseDel(storagePath) {
  const { error } = await (await supabaseClient()).storage.from('documents').remove([storagePath]);
  if (error) throw error;
}

// ─── At-rest encryption (local storage) ─────────────────────────────────────
// AES-256-GCM. Key can be a 64-char hex string (32 raw bytes) or any passphrase
// (scrypt-derived). Wire format: MAGIC(4) + IV(12) + AUTH_TAG(16) + CIPHERTEXT.
// Files uploaded before encryption was enabled are detected by missing magic bytes
// and returned as-is, so enabling encryption is non-destructive to existing files.

const enc  = require('./encryption');
const fsSync = require('fs');
const fs   = fsSync.promises;
const nodePath = require('path');
const crypto   = require('crypto');
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');

async function _encKey() {
  const raw = await settings.getOrEnv('storage_encryption_key');
  return enc.resolveKey(raw);
}

async function localBase() {
  const p = await settings.getOrEnv('storage_local_path');
  if (!p) throw new Error('STORAGE_LOCAL_PATH is required when STORAGE_PROVIDER=local');
  return p;
}

async function isLocalProvider() {
  return (await PROVIDER()) === 'local';
}

const localTokens = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of localTokens) if (v.expires < now) localTokens.delete(k);
}, 15 * 60 * 1000).unref();

function validateLocalToken(token) {
  const entry = localTokens.get(token);
  if (!entry) return null;
  if (entry.expires < Date.now()) { localTokens.delete(token); return null; }
  return entry;
}

async function localUpload(storagePath, buffer) {
  const key = await _encKey();
  const data = key ? enc.encrypt(buffer, key) : buffer;
  const fullPath = nodePath.join(await localBase(), storagePath);
  await fs.mkdir(nodePath.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, data);
}

function byteCounter(onCount) {
  return new Transform({
    transform(chunk, _encoding, callback) {
      onCount(chunk.length);
      callback(null, chunk);
    }
  });
}

async function localUploadStream(storagePath, readable) {
  const key = await _encKey();
  const fullPath = nodePath.join(await localBase(), storagePath);
  await fs.mkdir(nodePath.dirname(fullPath), { recursive: true });

  const tmpPath = `${fullPath}.${crypto.randomBytes(8).toString('hex')}.upload`;
  let bytes = 0;

  try {
    if (!key) {
      await pipeline(
        readable,
        byteCounter(n => { bytes += n; }),
        fsSync.createWriteStream(tmpPath)
      );
      await fs.rename(tmpPath, fullPath);
      return { size: bytes };
    }

    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    await pipeline(
      readable,
      byteCounter(n => { bytes += n; }),
      cipher,
      fsSync.createWriteStream(tmpPath)
    );

    const cipherTextPath = `${tmpPath}.ciphertext`;
    await fs.rename(tmpPath, cipherTextPath);
    await new Promise((resolve, reject) => {
      const out = fsSync.createWriteStream(tmpPath);
      const input = fsSync.createReadStream(cipherTextPath);
      out.on('error', reject);
      input.on('error', reject);
      out.write(enc.MAGIC);
      out.write(iv);
      out.write(cipher.getAuthTag());
      input.pipe(out);
      input.on('end', () => out.end());
      out.on('finish', resolve);
    });
    await fs.unlink(cipherTextPath);
    await fs.rename(tmpPath, fullPath);
    return { size: bytes };
  } catch (e) {
    await fs.unlink(tmpPath).catch(() => {});
    await fs.unlink(`${tmpPath}.ciphertext`).catch(() => {});
    throw e;
  }
}

async function localDownload(storagePath) {
  const raw = await fs.readFile(nodePath.join(await localBase(), storagePath));
  const key = await _encKey();
  return key ? enc.decrypt(raw, key) : raw;
}

// Parse an HTTP Range header ("bytes=start-end" / "bytes=start-" / "bytes=-suffix")
// against the total size. Returns { start, end } (inclusive), { unsatisfiable:true },
// or null when there's no (usable) range.
function parseRange(rangeHeader, totalSize) {
  if (!rangeHeader || !Number.isFinite(totalSize) || totalSize <= 0) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader).trim());
  if (!m) return null;
  let start = m[1] === '' ? null : parseInt(m[1], 10);
  let end = m[2] === '' ? null : parseInt(m[2], 10);
  if (start === null && end === null) return null;
  if (start === null) { start = Math.max(0, totalSize - end); end = totalSize - 1; }       // suffix: last N bytes
  else if (end === null || end >= totalSize) { end = totalSize - 1; }
  if (start > end || start >= totalSize) return { unsatisfiable: true };
  return { start, end };
}

// Streaming download: never buffers the whole file. Returns { stream, length,
// totalSize, range, unsatisfiable }. opts.rangeHeader enables HTTP Range (206) for
// non-encrypted files (used for media seeking). GCM ciphertext isn't seekable, so an
// encrypted file ignores Range and streams in full (still no OOM). For an encrypted
// file we peek the MAGIC+IV+TAG header and pipe the ciphertext through a streaming
// decipher; legacy/plaintext files (no magic) stream as-is.
async function localDownloadStream(storagePath, opts = {}) {
  const fullPath = nodePath.join(await localBase(), storagePath);
  const key = await _encKey();
  const stat = await fs.stat(fullPath);

  let encrypted = false, iv = null, tag = null;
  if (key) {
    const fd = await fs.open(fullPath, 'r');
    try {
      const b = Buffer.alloc(Math.min(32, stat.size));
      const { bytesRead } = await fd.read(b, 0, b.length, 0);
      const header = b.subarray(0, bytesRead);
      if (header.length >= 32 && header.subarray(0, 4).equals(enc.MAGIC)) {
        encrypted = true; iv = header.subarray(4, 16); tag = header.subarray(16, 32);
      }
    } finally { await fd.close(); }
  }
  const totalSize = encrypted ? stat.size - 32 : stat.size;

  if (opts.rangeHeader && !encrypted) {
    const r = parseRange(opts.rangeHeader, totalSize);
    if (r && r.unsatisfiable) return { unsatisfiable: true, totalSize };
    if (r) {
      return {
        stream: fsSync.createReadStream(fullPath, { start: r.start, end: r.end }),
        length: r.end - r.start + 1, totalSize, range: { start: r.start, end: r.end },
      };
    }
  }

  if (!encrypted) {
    return { stream: fsSync.createReadStream(fullPath), length: totalSize, totalSize, range: null };
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const ciphertext = fsSync.createReadStream(fullPath, { start: 32 });
  ciphertext.on('error', (e) => decipher.destroy(e));
  ciphertext.pipe(decipher);
  return { stream: decipher, length: totalSize, totalSize, range: null };
}

async function localGetUrl(storagePath, ttl) {
  const token = crypto.randomBytes(32).toString('hex');
  localTokens.set(token, { storagePath, expires: Date.now() + ttl * 1000 });
  // Relative URL so it resolves against whatever host the browser is on
  // (localhost, LAN IP, domain) instead of a hardcoded app_url that may be stale.
  return `/api/files/local-download?token=${token}`;
}

async function localDel(storagePath) {
  await fs.unlink(nodePath.join(await localBase(), storagePath));
}

async function localCopy(fromStoragePath, toStoragePath) {
  const base = await localBase();
  const fromPath = nodePath.join(base, fromStoragePath);
  const toPath = nodePath.join(base, toStoragePath);
  await fs.mkdir(nodePath.dirname(toPath), { recursive: true });
  await fs.copyFile(fromPath, toPath);
}

// ─── S3-compatible ───────────────────────────────────────────────────────────
// Works with AWS S3, Cloudflare R2, Backblaze B2, MinIO, DigitalOcean Spaces.

async function s3Client() {
  const { S3Client } = require('@aws-sdk/client-s3');
  const config = {
    region: (await settings.getOrEnv('storage_s3_region')) || 'us-east-1',
    credentials: {
      accessKeyId: await settings.getOrEnv('storage_s3_access_key_id'),
      secretAccessKey: await settings.getOrEnv('storage_s3_secret_access_key'),
    },
  };
  const endpoint = await settings.getOrEnv('storage_s3_endpoint');
  if (endpoint) {
    config.endpoint = endpoint;
    config.forcePathStyle = (await settings.getOrEnv('storage_s3_force_path_style')) === 'true';
  }
  return new S3Client(config);
}

async function s3Bucket() {
  const b = await settings.getOrEnv('storage_s3_bucket');
  if (!b) throw new Error('STORAGE_S3_BUCKET is required when STORAGE_PROVIDER=s3');
  return b;
}

async function s3Upload(storagePath, buffer, mimeType) {
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  await (await s3Client()).send(new PutObjectCommand({
    Bucket: await s3Bucket(), Key: storagePath, Body: buffer, ContentType: mimeType,
  }));
}

async function s3UploadStream(storagePath, readable, mimeType) {
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  await (await s3Client()).send(new PutObjectCommand({
    Bucket: await s3Bucket(), Key: storagePath, Body: readable, ContentType: mimeType,
  }));
  return { size: null };
}

async function s3Download(storagePath) {
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  const res = await (await s3Client()).send(new GetObjectCommand({ Bucket: await s3Bucket(), Key: storagePath }));
  const chunks = [];
  for await (const chunk of res.Body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function s3DownloadStream(storagePath, opts = {}) {
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  const cmd = { Bucket: await s3Bucket(), Key: storagePath };
  if (opts.rangeHeader) cmd.Range = opts.rangeHeader; // S3 understands the HTTP Range header natively
  const res = await (await s3Client()).send(new GetObjectCommand(cmd));
  const length = typeof res.ContentLength === 'number' ? res.ContentLength : null;
  let range = null, totalSize = length;
  const m = res.ContentRange && /bytes (\d+)-(\d+)\/(\d+)/.exec(res.ContentRange);
  if (m) { range = { start: +m[1], end: +m[2] }; totalSize = +m[3]; }
  // aws-sdk v3 Body is a Node Readable stream (S3 stores raw bytes; no app-layer encryption).
  return { stream: res.Body, length, totalSize, range };
}

async function s3GetUrl(storagePath, ttl) {
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
  return getSignedUrl(
    await s3Client(),
    new GetObjectCommand({ Bucket: await s3Bucket(), Key: storagePath }),
    { expiresIn: ttl }
  );
}

async function s3Del(storagePath) {
  const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
  await (await s3Client()).send(new DeleteObjectCommand({ Bucket: await s3Bucket(), Key: storagePath }));
}

async function s3Copy(fromStoragePath, toStoragePath) {
  const { CopyObjectCommand } = require('@aws-sdk/client-s3');
  const bucket = await s3Bucket();
  await (await s3Client()).send(new CopyObjectCommand({
    Bucket: bucket,
    CopySource: `${bucket}/${fromStoragePath}`,
    Key: toStoragePath,
  }));
}

// ─── Public interface ────────────────────────────────────────────────────────

async function upload(storagePath, buffer, mimeType) {
  switch (await PROVIDER()) {
    case 'local': return localUpload(storagePath, buffer);
    case 's3':    return s3Upload(storagePath, buffer, mimeType);
    default:      return supabaseUpload(storagePath, buffer, mimeType);
  }
}

async function streamToBuffer(readable) {
  const chunks = [];
  let size = 0;
  for await (const chunk of readable) {
    chunks.push(chunk);
    size += chunk.length;
  }
  return { buffer: Buffer.concat(chunks), size };
}

// Wrap a readable so it fails (err.code UPLOAD_TOO_LARGE) once more than maxBytes
// have been read. Pull-based (Readable.from a generator) so the error is delivered
// to whoever consumes the stream, never emitted before the consumer attaches a
// handler — passing the raw stream through a piped Transform can crash on that race.
function capStream(readable, maxBytes) {
  const { Readable } = require('stream');
  let total = 0;
  return Readable.from((async function* () {
    for await (const chunk of readable) {
      total += chunk.length;
      if (Number.isFinite(maxBytes) && maxBytes > 0 && total > maxBytes) {
        const err = new Error('Upload exceeds the maximum allowed size');
        err.code = 'UPLOAD_TOO_LARGE';
        throw err;
      }
      yield chunk;
    }
  })());
}

// opts.maxBytes caps the upload; the whole stream is consumed inside one pipeline so
// an over-cap abort rejects cleanly rather than emitting an unhandled error.
async function uploadStream(storagePath, readable, mimeType, opts = {}) {
  const src = opts && opts.maxBytes ? capStream(readable, opts.maxBytes) : readable;
  switch (await PROVIDER()) {
    case 'local': return localUploadStream(storagePath, src);
    case 's3':    return s3UploadStream(storagePath, src, mimeType);
    default: {
      const { buffer, size } = await streamToBuffer(src);
      await supabaseUpload(storagePath, buffer, mimeType);
      return { size };
    }
  }
}

async function download(storagePath) {
  switch (await PROVIDER()) {
    case 'local': return localDownload(storagePath);
    case 's3':    return s3Download(storagePath);
    default:      return supabaseDownload(storagePath);
  }
}

// Streaming variant of download() for serving files to a client without buffering
// the whole object in memory. Returns { stream, length|null }.
async function downloadStream(storagePath, opts = {}) {
  switch (await PROVIDER()) {
    case 'local': return localDownloadStream(storagePath, opts);
    case 's3':    return s3DownloadStream(storagePath, opts);
    default:      return supabaseDownloadStream(storagePath);
  }
}

async function getUrl(storagePath, ttl = 3600) {
  switch (await PROVIDER()) {
    case 'local': return localGetUrl(storagePath, ttl);
    case 's3':    return s3GetUrl(storagePath, ttl);
    default:      return supabaseGetUrl(storagePath, ttl);
  }
}

async function del(storagePath) {
  switch (await PROVIDER()) {
    case 'local': return localDel(storagePath);
    case 's3':    return s3Del(storagePath);
    default:      return supabaseDel(storagePath);
  }
}

async function copy(fromStoragePath, toStoragePath, mimeType) {
  switch (await PROVIDER()) {
    case 'local': return localCopy(fromStoragePath, toStoragePath);
    case 's3':    return s3Copy(fromStoragePath, toStoragePath);
    default: {
      const buffer = await supabaseDownload(fromStoragePath);
      return supabaseUpload(toStoragePath, buffer, mimeType);
    }
  }
}

module.exports = { upload, uploadStream, download, downloadStream, getUrl, del, copy, validateLocalToken, isLocalProvider, localBase, parseRange };

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
const fs   = require('fs').promises;
const nodePath = require('path');
const crypto   = require('crypto');

async function _encKey() {
  const raw = await settings.getOrEnv('storage_encryption_key');
  return enc.resolveKey(raw);
}

async function localBase() {
  const p = await settings.getOrEnv('storage_local_path');
  if (!p) throw new Error('STORAGE_LOCAL_PATH is required when STORAGE_PROVIDER=local');
  return p;
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

async function localDownload(storagePath) {
  const raw = await fs.readFile(nodePath.join(await localBase(), storagePath));
  const key = await _encKey();
  return key ? enc.decrypt(raw, key) : raw;
}

async function localGetUrl(storagePath, ttl) {
  const token = crypto.randomBytes(32).toString('hex');
  localTokens.set(token, { storagePath, expires: Date.now() + ttl * 1000 });
  const base = ((await settings.getOrEnv('app_url')) || '').replace(/\/$/, '');
  return `${base}/api/files/local-download?token=${token}`;
}

async function localDel(storagePath) {
  await fs.unlink(nodePath.join(await localBase(), storagePath));
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

async function s3Download(storagePath) {
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  const res = await (await s3Client()).send(new GetObjectCommand({ Bucket: await s3Bucket(), Key: storagePath }));
  const chunks = [];
  for await (const chunk of res.Body) chunks.push(chunk);
  return Buffer.concat(chunks);
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

// ─── Public interface ────────────────────────────────────────────────────────

async function upload(storagePath, buffer, mimeType) {
  switch (await PROVIDER()) {
    case 'local': return localUpload(storagePath, buffer);
    case 's3':    return s3Upload(storagePath, buffer, mimeType);
    default:      return supabaseUpload(storagePath, buffer, mimeType);
  }
}

async function download(storagePath) {
  switch (await PROVIDER()) {
    case 'local': return localDownload(storagePath);
    case 's3':    return s3Download(storagePath);
    default:      return supabaseDownload(storagePath);
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

module.exports = { upload, download, getUrl, del, validateLocalToken };

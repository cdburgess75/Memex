'use strict';

const PROVIDER = () => process.env.STORAGE_PROVIDER || 'supabase';

// ─── Supabase ────────────────────────────────────────────────────────────────

const { createClient } = require('@supabase/supabase-js');
function supabaseClient() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

async function supabaseUpload(storagePath, buffer, mimeType) {
  const { error } = await supabaseClient().storage
    .from('documents')
    .upload(storagePath, buffer, { contentType: mimeType, upsert: true });
  if (error) throw error;
}

async function supabaseDownload(storagePath) {
  const { data, error } = await supabaseClient().storage.from('documents').download(storagePath);
  if (error) throw error;
  return Buffer.from(await data.arrayBuffer());
}

async function supabaseGetUrl(storagePath, ttl) {
  const { data, error } = await supabaseClient().storage
    .from('documents')
    .createSignedUrl(storagePath, ttl);
  if (error) throw error;
  return data.signedUrl;
}

async function supabaseDel(storagePath) {
  const { error } = await supabaseClient().storage.from('documents').remove([storagePath]);
  if (error) throw error;
}

// ─── Local filesystem ────────────────────────────────────────────────────────

const fs = require('fs').promises;
const nodePath = require('path');
const crypto = require('crypto');

function localBase() {
  const p = process.env.STORAGE_LOCAL_PATH;
  if (!p) throw new Error('STORAGE_LOCAL_PATH is required when STORAGE_PROVIDER=local');
  return p;
}

// Short-lived download tokens — replaces signed URLs for local storage
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
  const fullPath = nodePath.join(localBase(), storagePath);
  await fs.mkdir(nodePath.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, buffer);
}

async function localDownload(storagePath) {
  return fs.readFile(nodePath.join(localBase(), storagePath));
}

function localGetUrl(storagePath, ttl) {
  const token = crypto.randomBytes(32).toString('hex');
  localTokens.set(token, { storagePath, expires: Date.now() + ttl * 1000 });
  const base = (process.env.APP_URL || '').replace(/\/$/, '');
  return `${base}/api/files/local-download?token=${token}`;
}

async function localDel(storagePath) {
  await fs.unlink(nodePath.join(localBase(), storagePath));
}

// ─── S3-compatible ───────────────────────────────────────────────────────────
// Works with AWS S3, Cloudflare R2, Backblaze B2, MinIO, DigitalOcean Spaces.

function s3Client() {
  const { S3Client } = require('@aws-sdk/client-s3');
  const config = {
    region: process.env.STORAGE_S3_REGION || 'us-east-1',
    credentials: {
      accessKeyId: process.env.STORAGE_S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.STORAGE_S3_SECRET_ACCESS_KEY,
    },
  };
  if (process.env.STORAGE_S3_ENDPOINT) {
    config.endpoint = process.env.STORAGE_S3_ENDPOINT;
    config.forcePathStyle = process.env.STORAGE_S3_FORCE_PATH_STYLE === 'true';
  }
  return new S3Client(config);
}

function s3Bucket() {
  const b = process.env.STORAGE_S3_BUCKET;
  if (!b) throw new Error('STORAGE_S3_BUCKET is required when STORAGE_PROVIDER=s3');
  return b;
}

async function s3Upload(storagePath, buffer, mimeType) {
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  await s3Client().send(new PutObjectCommand({
    Bucket: s3Bucket(), Key: storagePath, Body: buffer, ContentType: mimeType,
  }));
}

async function s3Download(storagePath) {
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  const res = await s3Client().send(new GetObjectCommand({ Bucket: s3Bucket(), Key: storagePath }));
  const chunks = [];
  for await (const chunk of res.Body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function s3GetUrl(storagePath, ttl) {
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
  return getSignedUrl(
    s3Client(),
    new GetObjectCommand({ Bucket: s3Bucket(), Key: storagePath }),
    { expiresIn: ttl }
  );
}

async function s3Del(storagePath) {
  const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
  await s3Client().send(new DeleteObjectCommand({ Bucket: s3Bucket(), Key: storagePath }));
}

// ─── Public interface ────────────────────────────────────────────────────────

async function upload(storagePath, buffer, mimeType) {
  switch (PROVIDER()) {
    case 'local': return localUpload(storagePath, buffer);
    case 's3':    return s3Upload(storagePath, buffer, mimeType);
    default:      return supabaseUpload(storagePath, buffer, mimeType);
  }
}

async function download(storagePath) {
  switch (PROVIDER()) {
    case 'local': return localDownload(storagePath);
    case 's3':    return s3Download(storagePath);
    default:      return supabaseDownload(storagePath);
  }
}

async function getUrl(storagePath, ttl = 3600) {
  switch (PROVIDER()) {
    case 'local': return localGetUrl(storagePath, ttl);
    case 's3':    return s3GetUrl(storagePath, ttl);
    default:      return supabaseGetUrl(storagePath, ttl);
  }
}

async function del(storagePath) {
  switch (PROVIDER()) {
    case 'local': return localDel(storagePath);
    case 's3':    return s3Del(storagePath);
    default:      return supabaseDel(storagePath);
  }
}

module.exports = { upload, download, getUrl, del, validateLocalToken };

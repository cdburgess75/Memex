'use strict';
// Backup destination adapters. Each archive is first written to the local staging
// dir (lib/backup.js), then shipped to every enabled destination here. Each adapter
// implements put/list/remove so retention pruning works per destination.
//
//   local   { path }                              copy to a mounted path / NAS share
//   s3      { bucket, region, endpoint, force_path_style, access_key_id, secret_access_key, prefix }
//   gdrive  { folder_id }                          uses the shared google_service_account_key
//   webhook { url }                                artifact stays in staging; POST a notify payload
//
const fs = require('fs');
const path = require('path');
const settings = require('./settings');

const ARCHIVE_RE = /^memex-backup-.*\.tar\.gz$/;

// ---- local ----------------------------------------------------------------
const local = {
  async put(cfg, filePath, name) {
    if (!cfg.path) throw new Error('local destination needs a path');
    await fs.promises.mkdir(cfg.path, { recursive: true });
    await fs.promises.copyFile(filePath, path.join(cfg.path, name));
  },
  async list(cfg) {
    try {
      const names = (await fs.promises.readdir(cfg.path)).filter(n => ARCHIVE_RE.test(n));
      const out = [];
      for (const n of names) {
        const st = await fs.promises.stat(path.join(cfg.path, n)).catch(() => null);
        if (st) out.push({ name: n, ts: st.mtimeMs });
      }
      return out;
    } catch { return []; }
  },
  async remove(cfg, name) { await fs.promises.unlink(path.join(cfg.path, name)).catch(() => {}); },
};

// ---- s3-compatible --------------------------------------------------------
function s3Client(cfg) {
  const { S3Client } = require('@aws-sdk/client-s3');
  const conf = { region: cfg.region || 'us-east-1' };
  if (cfg.endpoint) conf.endpoint = cfg.endpoint;
  if (cfg.force_path_style === true || cfg.force_path_style === 'true') conf.forcePathStyle = true;
  if (cfg.access_key_id && cfg.secret_access_key) {
    conf.credentials = { accessKeyId: cfg.access_key_id, secretAccessKey: cfg.secret_access_key };
  }
  return new S3Client(conf);
}
function s3Key(cfg, name) { return (cfg.prefix ? cfg.prefix.replace(/\/+$/, '') + '/' : '') + name; }
const s3 = {
  async put(cfg, filePath, name) {
    if (!cfg.bucket) throw new Error('s3 destination needs a bucket');
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    await s3Client(cfg).send(new PutObjectCommand({
      Bucket: cfg.bucket, Key: s3Key(cfg, name), Body: fs.createReadStream(filePath),
    }));
  },
  async list(cfg) {
    const { ListObjectsV2Command } = require('@aws-sdk/client-s3');
    const prefix = cfg.prefix ? cfg.prefix.replace(/\/+$/, '') + '/' : '';
    const r = await s3Client(cfg).send(new ListObjectsV2Command({ Bucket: cfg.bucket, Prefix: prefix }));
    return (r.Contents || [])
      .filter(o => ARCHIVE_RE.test(o.Key.slice(prefix.length)))
      .map(o => ({ name: o.Key.slice(prefix.length), ts: o.LastModified ? new Date(o.LastModified).getTime() : 0 }));
  },
  async remove(cfg, name) {
    const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
    await s3Client(cfg).send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: s3Key(cfg, name) }));
  },
};

// ---- google drive ---------------------------------------------------------
async function driveClient() {
  const raw = await settings.getOrEnv('google_service_account_key');
  if (!raw) throw new Error('Google Drive backup needs google_service_account_key configured');
  const { google } = require('googleapis');
  const creds = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/drive'] });
  return google.drive({ version: 'v3', auth });
}
const gdrive = {
  async put(cfg, filePath, name) {
    const drive = await driveClient();
    await drive.files.create({
      requestBody: { name, parents: cfg.folder_id ? [cfg.folder_id] : undefined },
      media: { mimeType: 'application/gzip', body: fs.createReadStream(filePath) },
      fields: 'id',
    });
  },
  async list(cfg) {
    const drive = await driveClient();
    const q = [`name contains 'memex-backup-'`, 'trashed = false'];
    if (cfg.folder_id) q.push(`'${cfg.folder_id}' in parents`);
    const r = await drive.files.list({ q: q.join(' and '), fields: 'files(id,name,createdTime)', pageSize: 1000 });
    return (r.data.files || [])
      .filter(f => ARCHIVE_RE.test(f.name))
      .map(f => ({ name: f.name, ts: f.createdTime ? new Date(f.createdTime).getTime() : 0, id: f.id }));
  },
  async remove(cfg, name) {
    const drive = await driveClient();
    const found = (await this.list(cfg)).find(f => f.name === name);
    if (found?.id) await drive.files.delete({ fileId: found.id });
  },
};

// ---- webhook (pull + notify) ----------------------------------------------
// The artifact stays in staging (served via the signed download route); we POST
// a JSON notification so external tooling can pull it. Retention is handled by
// the staging dir, so list/remove are no-ops here.
const webhook = {
  async put(cfg, _filePath, name, meta = {}) {
    if (!cfg.url) throw new Error('webhook destination needs a url');
    const body = JSON.stringify({ event: 'memex.backup.ready', name, ...meta });
    const res = await fetch(cfg.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    if (!res.ok) throw new Error(`webhook returned HTTP ${res.status}`);
  },
  async list() { return []; },
  async remove() {},
};

const ADAPTERS = { local, s3, gdrive, webhook };

function adapter(type) {
  const a = ADAPTERS[type];
  if (!a) throw new Error(`Unknown backup destination type: ${type}`);
  return a;
}

module.exports = { adapter, ADAPTERS, ARCHIVE_RE };

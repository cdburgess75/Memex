'use strict';
// SMB / CIFS connector — a Windows or Samba file share, which is how an NTFS volume
// on a local file server is reached over the network. (Depot talks SMB; it does not
// read the NTFS on-disk format directly. Any NTFS volume shared from Windows, or a
// Samba export of one, is what this connects to.)
const { resolveWithinRoot } = require('./base');

// Lazy-required so the app boots without it — the same pattern storage.js uses for
// the AWS SDK. Only deployments that actually configure an SMB connector need the
// module present, and a missing one produces a clear message instead of a boot crash.
function SMB2() {
  try {
    return require('@marsaud/smb2');
  } catch {
    const e = new Error(
      'SMB support needs the "@marsaud/smb2" package. Install it in server/ and restart.'
    );
    e.status = 501;
    throw e;
  }
}

// SMB paths are backslash-separated. Our internal form is always forward-slash.
const toSmb = (p) => String(p || '').replace(/\//g, '\\');

function clientFor(cfg) {
  const Ctor = SMB2();
  const host = String(cfg.host || '').replace(/^\\+|\\+$/g, '').trim();
  const share = String(cfg.share || '').replace(/^\\+|\\+$/g, '').trim();
  if (!host || !share) throw new Error('SMB connector needs a server and a share');
  return new Ctor({
    share: `\\\\${host}\\${share}`,
    domain: cfg.domain || 'WORKGROUP',
    username: cfg.username || '',
    password: cfg.password || '',
    port: Number(cfg.port) || 445,
    // Don't hold a session open indefinitely between requests.
    autoCloseTimeout: 10000,
  });
}

// @marsaud/smb2 is callback-based; wrap one call and always dispose the session so a
// browse storm can't leak connections against the file server.
function call(cfg, method, args) {
  return new Promise((resolve, reject) => {
    let client;
    try { client = clientFor(cfg); } catch (e) { return reject(e); }
    client[method](...args, (err, out) => {
      try { client.disconnect(); } catch { /* best effort */ }
      if (err) return reject(err);
      resolve(out);
    });
  });
}

function entryFrom(name, st, parentPath) {
  const isDir = st && typeof st.isDirectory === 'function' ? st.isDirectory() : Boolean(st && st.isDirectory);
  return {
    name,
    path: parentPath ? `${parentPath}/${name}` : name,
    type: isDir ? 'dir' : 'file',
    size: st && st.size != null ? Number(st.size) : null,
    modified: st && st.mtime ? new Date(st.mtime).toISOString() : null,
  };
}

module.exports = {
  kind: 'smb',
  label: 'SMB / Windows file share',
  blurb: 'A Windows or Samba share — the usual way to reach an NTFS volume on a local file server.',
  caps: { write: true, remove: true, mkdir: true, range: true, move: true },

  fields: [
    { key: 'host', label: 'Server', type: 'text', required: true, placeholder: 'files.corp.local',
      help: 'Hostname or IP of the file server. No leading backslashes.' },
    { key: 'share', label: 'Share name', type: 'text', required: true, placeholder: 'Engineering',
      help: 'The share as published by the server, not the full UNC path.' },
    { key: 'rootPath', label: 'Folder within the share', type: 'text', placeholder: 'Projects/2026',
      help: 'Optional. Scopes the connection to a subfolder — nothing above it is reachable.' },
    { key: 'domain', label: 'Domain', type: 'text', placeholder: 'CORP', default: 'WORKGROUP' },
    { key: 'username', label: 'Username', type: 'text', hideWhen: 'delegated',
      help: 'Service-account username. Leave blank when "own network credentials" is on — each user supplies their own.' },
    { key: 'password', label: 'Password', type: 'password', secret: true, hideWhen: 'delegated',
      help: 'Service-account password. Not used when "own network credentials" is on.' },
    { key: 'port', label: 'Port', type: 'number', default: 445 },
    { key: 'delegated', label: 'Use each signed-in user’s own network credentials', type: 'bool',
      help: 'When on, each user unlocks this share with their own domain sign-in and sees only what NTFS grants them — instead of a shared service account. Depot holds those credentials only in memory for the session (never stored). The username/password above are not used in this mode.' },
  ],

  async test(cfg) {
    // Listing the configured root proves reachability, credentials, and that the
    // root actually exists — the three things that break in practice.
    const root = resolveWithinRoot(cfg.rootPath, '');
    const names = await call(cfg, 'readdir', [toSmb(root) || '\\']);
    return { ok: true, message: `Connected. ${names.length} item(s) at the configured root.` };
  },

  async list(cfg, path) {
    const abs = resolveWithinRoot(cfg.rootPath, path);
    // Ask for stats inline where the library supports it; fall back to names only,
    // which still renders a usable listing (type resolved on demand by stat()).
    let raw;
    try {
      raw = await call(cfg, 'readdir', [toSmb(abs) || '\\', { stats: true }]);
    } catch {
      raw = await call(cfg, 'readdir', [toSmb(abs) || '\\']);
    }
    return raw.map((item) =>
      typeof item === 'string'
        ? { name: item, path: path ? `${path}/${item}` : item, type: 'file', size: null, modified: null }
        : entryFrom(item.name ?? String(item), item, path)
    );
  },

  async stat(cfg, path) {
    const abs = resolveWithinRoot(cfg.rootPath, path);
    const st = await call(cfg, 'stat', [toSmb(abs)]);
    const name = String(path || '').split('/').pop() || '';
    return entryFrom(name, st, String(path || '').split('/').slice(0, -1).join('/'));
  },

  async read(cfg, path, opts = {}) {
    const abs = resolveWithinRoot(cfg.rootPath, path);
    const range = opts.range && Number.isFinite(opts.range.start)
      ? { start: opts.range.start, end: opts.range.end }
      : undefined;
    const stream = await call(cfg, 'createReadStream', range ? [toSmb(abs), range] : [toSmb(abs)]);
    return { stream };
  },

  async write(cfg, path, readable) {
    const abs = resolveWithinRoot(cfg.rootPath, path);
    const out = await call(cfg, 'createWriteStream', [toSmb(abs)]);
    await new Promise((resolve, reject) => {
      readable.on('error', reject);
      out.on('error', reject);
      out.on('finish', resolve);
      readable.pipe(out);
    });
  },

  async remove(cfg, path) {
    const abs = resolveWithinRoot(cfg.rootPath, path);
    await call(cfg, 'unlink', [toSmb(abs)]);
  },

  async mkdir(cfg, path) {
    const abs = resolveWithinRoot(cfg.rootPath, path);
    await call(cfg, 'mkdir', [toSmb(abs)]);
  },

  // Rename or move within the share (smb2's rename takes old + new full paths).
  async move(cfg, from, to) {
    await call(cfg, 'rename', [toSmb(resolveWithinRoot(cfg.rootPath, from)), toSmb(resolveWithinRoot(cfg.rootPath, to))]);
  },
};

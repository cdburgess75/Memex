'use strict';
// SharePoint document-library connector, over Microsoft Graph.
//
// App-only (client-credentials) auth, the same shape server/lib/email.js already uses
// for Graph mail. It needs an app registration in the customer tenant with the
// application permission Sites.Read.All (or Sites.ReadWrite.All for a writable mount)
// and admin consent granted.
//
// The same Graph drive model backs OneDrive and Teams file tabs, so an adapter for
// either is largely this file with a different site/drive resolution step.
const crypto = require('crypto');
const { resolveWithinRoot } = require('./base');

const GRAPH = 'https://graph.microsoft.com/v1.0';

// Token cache keyed by the credential triple, so many connectors (or many requests)
// against one tenant share a token instead of re-minting per call.
const _tokens = new Map();

async function token(cfg) {
  const tenant = String(cfg.tenantId || '').trim();
  const clientId = String(cfg.clientId || '').trim();
  const secret = String(cfg.clientSecret || '');
  if (!tenant || !clientId || !secret) throw new Error('SharePoint connector needs tenant, client id, and secret');

  const key = `${tenant}|${clientId}|${crypto.createHash('sha256').update(secret).digest('hex')}`;
  const hit = _tokens.get(key);
  if (hit && Date.now() < hit.exp - 120000) return hit.token;

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: secret,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });
  const r = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(10000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.access_token) {
    throw new Error(`graph token ${r.status}: ${data.error_description || data.error || 'no access_token'}`);
  }
  const tok = { token: data.access_token, exp: Date.now() + (Number(data.expires_in) || 3600) * 1000 };
  _tokens.set(key, tok);
  return tok.token;
}

async function graph(cfg, path, opts = {}) {
  const t = await token(cfg);
  const r = await fetch(`${GRAPH}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${t}`, ...(opts.headers || {}) },
    signal: opts.signal || AbortSignal.timeout(30000),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    const e = new Error(`graph ${r.status}: ${err?.error?.message || r.statusText}`);
    e.status = r.status === 404 ? 404 : r.status === 403 ? 403 : 502;
    throw e;
  }
  return r;
}

// A SharePoint site URL (https://contoso.sharepoint.com/sites/Engineering) has to be
// turned into a Graph site id before anything else can address it.
const _sites = new Map();
async function siteId(cfg) {
  const url = String(cfg.siteUrl || '').trim().replace(/\/+$/, '');
  if (!url) throw new Error('SharePoint connector needs a site URL');
  if (_sites.has(url)) return _sites.get(url);

  let host, sitePath;
  try {
    const u = new URL(url);
    host = u.hostname;
    sitePath = u.pathname.replace(/^\/+|\/+$/g, '');
  } catch {
    throw new Error(`"${url}" is not a valid site URL`);
  }
  const addr = sitePath ? `${host}:/${sitePath}` : host;
  const r = await graph(cfg, `/sites/${addr}`);
  const { id } = await r.json();
  if (!id) throw new Error('could not resolve that SharePoint site');
  _sites.set(url, id);
  return id;
}

// Graph addresses drive items by path with the `root:/a/b:` form; the empty path is
// the special-cased `root`. Segments must be encoded individually so a name with a
// space or '#' survives.
function itemRef(absPath) {
  const p = String(absPath || '');
  if (!p) return 'root';
  return `root:/${p.split('/').map(encodeURIComponent).join('/')}:`;
}

function entryFrom(item, parentPath) {
  return {
    name: item.name,
    path: parentPath ? `${parentPath}/${item.name}` : item.name,
    type: item.folder ? 'dir' : 'file',
    size: item.size != null ? Number(item.size) : null,
    modified: item.lastModifiedDateTime || null,
    // The item's SharePoint URL: opening it puts the user in their own
    // Microsoft 365 (web or desktop hand-off) with their identity, co-authoring
    // and versioning — the legitimate O365 editing path for connector files.
    openUrl: item.webUrl || null,
  };
}

module.exports = {
  kind: 'sharepoint',
  label: 'SharePoint document library',
  blurb: 'A SharePoint site\'s document library, via Microsoft Graph app-only auth.',
  caps: { write: true, remove: true, mkdir: true, range: true },

  fields: [
    { key: 'siteUrl', label: 'Site URL', type: 'text', required: true,
      placeholder: 'https://contoso.sharepoint.com/sites/Engineering',
      help: 'The site whose default document library you want to mount.' },
    { key: 'rootPath', label: 'Folder within the library', type: 'text', placeholder: 'Shared Documents/Projects',
      help: 'Optional. Scopes the connection to a subfolder.' },
    { key: 'tenantId', label: 'Directory (tenant) ID', type: 'text', required: true },
    { key: 'clientId', label: 'Application (client) ID', type: 'text', required: true },
    { key: 'clientSecret', label: 'Client secret', type: 'password', required: true, secret: true,
      help: 'From the app registration. Needs Sites.Read.All (or Sites.ReadWrite.All to write) with admin consent.' },
  ],

  async test(cfg) {
    const site = await siteId(cfg);
    const root = resolveWithinRoot(cfg.rootPath, '');
    const r = await graph(cfg, `/sites/${site}/drive/${itemRef(root)}/children?$top=1&$select=id`);
    const data = await r.json();
    return { ok: true, message: `Connected to the site's document library${root ? ` at "${root}"` : ''}.` };
  },

  async list(cfg, path) {
    const site = await siteId(cfg);
    const abs = resolveWithinRoot(cfg.rootPath, path);
    const out = [];
    // Graph pages large folders; follow @odata.nextLink so a 5,000-file library
    // doesn't silently truncate at the first page.
    let url = `/sites/${site}/drive/${itemRef(abs)}/children?$top=200&$select=name,size,folder,lastModifiedDateTime,webUrl`;
    while (url) {
      const r = await graph(cfg, url);
      const data = await r.json();
      for (const item of data.value || []) out.push(entryFrom(item, path));
      const next = data['@odata.nextLink'];
      url = next ? next.replace(GRAPH, '') : null;
    }
    return out;
  },

  async stat(cfg, path) {
    const site = await siteId(cfg);
    const abs = resolveWithinRoot(cfg.rootPath, path);
    const r = await graph(cfg, `/sites/${site}/drive/${itemRef(abs)}?$select=name,size,folder,lastModifiedDateTime,webUrl`);
    const item = await r.json();
    return entryFrom(item, String(path || '').split('/').slice(0, -1).join('/'));
  },

  async read(cfg, path, opts = {}) {
    const site = await siteId(cfg);
    const abs = resolveWithinRoot(cfg.rootPath, path);
    const headers = {};
    if (opts.range && Number.isFinite(opts.range.start)) {
      headers.Range = `bytes=${opts.range.start}-${Number.isFinite(opts.range.end) ? opts.range.end : ''}`;
    }
    const r = await graph(cfg, `/sites/${site}/drive/${itemRef(abs)}/content`, { headers });
    return {
      stream: r.body,
      size: Number(r.headers.get('content-length')) || null,
      mime: r.headers.get('content-type') || null,
    };
  },

  async write(cfg, path, readable) {
    const site = await siteId(cfg);
    const abs = resolveWithinRoot(cfg.rootPath, path);
    // Simple upload caps at 4 MB in Graph; beyond that an upload session is required.
    // Buffer first so we can pick the right path and report size honestly.
    const chunks = [];
    let total = 0;
    for await (const c of readable) {
      chunks.push(c);
      total += c.length;
      if (total > 4 * 1024 * 1024) {
        const e = new Error('Files over 4 MB need a Graph upload session, which this adapter does not implement yet.');
        e.status = 413;
        throw e;
      }
    }
    await graph(cfg, `/sites/${site}/drive/${itemRef(abs)}/content`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: Buffer.concat(chunks),
    });
  },

  async remove(cfg, path) {
    const site = await siteId(cfg);
    const abs = resolveWithinRoot(cfg.rootPath, path);
    await graph(cfg, `/sites/${site}/drive/${itemRef(abs)}`, { method: 'DELETE' });
  },

  async mkdir(cfg, path) {
    const site = await siteId(cfg);
    const abs = resolveWithinRoot(cfg.rootPath, path);
    const parent = abs.split('/').slice(0, -1).join('/');
    const name = abs.split('/').pop();
    await graph(cfg, `/sites/${site}/drive/${itemRef(parent)}/children`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }),
    });
  },

  _resetForTests() { _tokens.clear(); _sites.clear(); },
};

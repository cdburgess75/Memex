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
const { certAssertion } = require('../graphClientAssertion');

const GRAPH = 'https://graph.microsoft.com/v1.0';

// Token cache keyed by the credential triple, so many connectors (or many requests)
// against one tenant share a token instead of re-minting per call.
const _tokens = new Map();

async function token(cfg) {
  // Delegated mode: the route has already fetched the signed-in user's own Microsoft
  // Graph token (via Keycloak's broker endpoint) and put it on cfg.delegatedToken, so
  // this connection reads SharePoint with the USER's permissions, not the app's. Use
  // it directly — do NOT run the app-only client-credentials flow, and do NOT cache it
  // (it is per-user and per-request).
  if (cfg.delegated) {
    const dt = String(cfg.delegatedToken || '').trim();
    if (!dt) { const e = new Error('This SharePoint connection uses each user’s own Microsoft 365 sign-in, but no user token was available for this request.'); e.status = 401; throw e; }
    return dt;
  }
  const tenant = String(cfg.tenantId || '').trim();
  const clientId = String(cfg.clientId || '').trim();
  // Two credential shapes, mirroring lib/email.js: a client secret, or a
  // certificate (thumbprint + PEM private key, pasted or read from a path such
  // as the fleet's /secrets/graph.key.pem). A secret wins when both exist.
  const secret = String(cfg.clientSecret || '');
  const thumbprint = String(cfg.certThumbprint || '').replace(/[^a-fA-F0-9]/g, '');
  let privateKey = cfg.certKey || null;
  if (!privateKey && cfg.certKeyPath) {
    try { privateKey = require('fs').readFileSync(String(cfg.certKeyPath).trim(), 'utf8'); }
    catch { /* unreadable → no cert credential */ }
  }
  const hasSecret = !!secret;
  const hasCert = !!(thumbprint && privateKey);
  if (!tenant || !clientId || (!hasSecret && !hasCert)) {
    throw new Error('SharePoint connector needs tenant, client id, and a client secret or certificate (thumbprint + key)');
  }

  const cred = hasSecret ? 's:' + crypto.createHash('sha256').update(secret).digest('hex') : 'c:' + thumbprint;
  const key = `${tenant}|${clientId}|${cred}`;
  const hit = _tokens.get(key);
  if (hit && Date.now() < hit.exp - 120000) return hit.token;

  const body = new URLSearchParams({
    client_id: clientId,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });
  if (hasSecret) {
    body.set('client_secret', secret);
  } else {
    body.set('client_assertion_type', 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
    body.set('client_assertion', certAssertion({ tenant, clientId, thumbprint, privateKey }));
  }
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
  caps: { write: true, remove: true, mkdir: true, range: true, move: true, share: true, invite: true },

  fields: [
    { key: 'siteUrl', label: 'Site URL', type: 'text', required: true,
      placeholder: 'https://contoso.sharepoint.com/sites/Engineering',
      help: 'The site whose default document library you want to mount.' },
    { key: 'rootPath', label: 'Folder within the library', type: 'text', placeholder: 'Shared Documents/Projects',
      help: 'Optional. Scopes the connection to a subfolder.' },
    // These app-only credentials aren't used in delegated mode (the connection acts
    // as the signed-in user via their brokered token), so hideWhen collapses them in
    // the admin form when "delegated" is ticked — see connFieldHtml in index.html.
    { key: 'tenantId', label: 'Directory (tenant) ID', type: 'text', required: true, hideWhen: 'delegated' },
    { key: 'clientId', label: 'Application (client) ID', type: 'text', required: true, hideWhen: 'delegated' },
    { key: 'clientSecret', label: 'Client secret', type: 'password', secret: true, hideWhen: 'delegated',
      help: 'One credential is required: this secret, OR the certificate fields below (the fleet standard — the app registration then needs no secret at all). Consent the app Sites.Selected (grant per site) or Sites.Read.All / Sites.ReadWrite.All.' },
    { key: 'certThumbprint', label: 'Certificate thumbprint', type: 'text', hideWhen: 'delegated',
      help: 'SHA-1 thumbprint (hex) of the certificate uploaded to the app registration.' },
    { key: 'certKeyPath', label: 'Certificate key path', type: 'text', placeholder: '/secrets/graph.key.pem', hideWhen: 'delegated',
      help: 'Path inside the container to the PEM private key — fleet boxes mount it at /secrets/graph.key.pem. Keeps the key out of the database and backups.' },
    { key: 'certKey', label: 'Certificate private key (paste)', type: 'password', secret: true, hideWhen: 'delegated',
      help: 'Alternative to the path: paste the PEM private key; it is stored encrypted. A pasted key wins over the path.' },
    { key: 'delegated', label: 'Use each signed-in user’s own Microsoft 365 permissions', type: 'bool',
      help: 'When on, files are accessed as the signed-in user — SharePoint decides per file what each person can read or write, instead of the app’s shared service identity. Requires "Microsoft 365 Graph delegation" enabled under Sign-in methods, and each user to be signed in with Microsoft. The client secret / certificate above are not used in this mode.' },
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

  // Rename an item in place. Cross-folder moves would need the target folder's
  // driveItem id for parentReference — the UI only renames within a folder for now.
  async move(cfg, from, to) {
    const site = await siteId(cfg);
    const fromAbs = resolveWithinRoot(cfg.rootPath, from);
    const toAbs = resolveWithinRoot(cfg.rootPath, to);
    if (fromAbs.split('/').slice(0, -1).join('/') !== toAbs.split('/').slice(0, -1).join('/')) {
      const e = new Error('Moving between folders isn’t supported yet — rename keeps the item in its folder.'); e.status = 400; throw e;
    }
    await graph(cfg, `/sites/${site}/drive/${itemRef(fromAbs)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: toAbs.split('/').pop() }),
    });
  },

  // Create a SharePoint sharing link (Graph createLink) — Depot's simple stand-in
  // for SharePoint's own share panel. type: 'view'|'edit'. scope 'organization' =
  // anyone in the tenant with the link; the tenant may downgrade/deny 'anonymous',
  // which is 365 deciding and surfaces here as an error. In delegated mode the link
  // is minted AS the signed-in user, so it can only grant what they may already share.
  async share(cfg, path, opts = {}) {
    const type = opts.type === 'edit' ? 'edit' : 'view';
    const scope = opts.scope || 'organization';
    const site = await siteId(cfg);
    const abs = resolveWithinRoot(cfg.rootPath, path);
    const r = await graph(cfg, `/sites/${site}/drive/${itemRef(abs)}/createLink`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, scope }),
    });
    const data = await r.json();
    const url = data && data.link && data.link.webUrl;
    if (!url) { const e = new Error('SharePoint returned no sharing link (tenant policy may block it).'); e.status = 502; throw e; }
    return { url, type, scope: (data.link && data.link.scope) || scope };
  },

  // Grant named people access to a file. Graph's /invite adds a per-recipient
  // permission so the file surfaces in their "Shared with me" — the direct-share
  // SharePoint's own UI buries. The EMAIL notification, however, is sent from the
  // caller's mailbox, and an app-only identity has none: `sendInvitation:true`
  // fails app-only ("There was a problem sharing" / exchangeInvalidUser). So we
  // split on auth mode:
  //   • delegated (acting as the signed-in user) → sendInvitation:true, SharePoint
  //     emails natively as that user.
  //   • app-only → sendInvitation:false (the supported app-only path: grant, no
  //     mail) and return the item's webUrl so the CALLER can send the notification
  //     itself via Depot's own mailer.
  // Returns { invited, type, native, url }. native=true means the notification was
  // already sent by SharePoint; native=false means the caller must deliver `url`.
  async shareInvite(cfg, path, opts = {}) {
    const type = opts.type === 'edit' ? 'edit' : 'view';
    const roles = [type === 'edit' ? 'write' : 'read'];
    const emails = (Array.isArray(opts.emails) ? opts.emails : [])
      .map(e => String(e || '').trim()).filter(Boolean);
    if (!emails.length) { const e = new Error('At least one recipient email is required.'); e.status = 400; throw e; }
    const bad = emails.find(e => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
    if (bad) { const e = new Error(`"${bad}" is not a valid email address.`); e.status = 400; throw e; }
    const site = await siteId(cfg);
    const abs = resolveWithinRoot(cfg.rootPath, path);
    const ref = itemRef(abs);
    const recipients = emails.map(email => ({ email }));

    if (cfg.delegated) {
      await graph(cfg, `/sites/${site}/drive/${ref}/invite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipients, roles, requireSignIn: true, sendInvitation: true,
          ...(opts.message ? { message: String(opts.message).slice(0, 2000) } : {}),
        }),
      });
      return { invited: emails, type, native: true, url: null };
    }

    // App-only: grant silently (the notification is the caller's job).
    try {
      await graph(cfg, `/sites/${site}/drive/${ref}/invite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipients, roles, requireSignIn: true, sendInvitation: false }),
      });
    } catch (e) {
      // Make the failure actionable AND make sure it survives the route's fail(),
      // which drops e.message for status >= 500. graph() maps a Graph 400 to 502.
      //  • 403 = a real permission problem (app registration missing the write
      //    scope, or the item is restricted). Keep 403 (< 500 → message shown).
      //  • 400 (arrives as 502) = the app-only sharing limitation: existing
      //    users/guests are fine, but a brand-new external guest can't be minted.
      //    Demote to 400 so the guidance actually reaches the user.
      if (e && e.status === 403) {
        e.message = 'SharePoint refused the share — the connection’s app registration may be missing Sites.ReadWrite.All / Files.ReadWrite.All, or the item is restricted.';
      } else if (e && (e.status === 400 || e.status === 502)) {
        e.message = 'Could not grant access to one of those people. App-only connections can share with existing users and guests, but cannot add a brand-new external guest — add them in SharePoint first, or use a delegated connection.';
        e.status = 400;
      }
      throw e;
    }
    // A stable link for the notification email. Best-effort: the grant already
    // succeeded, so a webUrl hiccup shouldn't fail the whole share.
    let url = null;
    try {
      const r = await graph(cfg, `/sites/${site}/drive/${ref}?$select=webUrl,name`);
      const item = await r.json();
      url = (item && item.webUrl) || null;
    } catch { /* keep url null; caller degrades gracefully */ }
    return { invited: emails, type, native: false, url };
  },

  _resetForTests() { _tokens.clear(); _sites.clear(); },
};

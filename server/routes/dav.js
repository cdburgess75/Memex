'use strict';
// Depot as a drive: a WebDAV endpoint at /dav, for rclone (which keeps a copy of what you
// open, on Windows, Mac and Linux), Finder's Connect to Server, Explorer's Map network
// drive and Linux file managers.
//
//   /dav/                             the libraries the person can open, one folder each
//   /dav/<Library>/                   that library's root
//   /dav/<Library>/<folder>/<file>    its folders and files, as on the website
//
// Sign-in is an API token (Settings › You › API tokens), sent as the PASSWORD of HTTP
// Basic auth -- the username is not used -- or as a Bearer token (middleware/auth). A
// read-only token gives a read-only drive. The rules are the website's: listings use the
// same access predicate as every other query, and everything that changes a file is
// HANDED ON to the app's own route for it (ask, as routes/v1.js forwards), so one
// implementation holds the locks, the rights checks, the shared-folder markers, the
// versions and the audit entries. What this file owns is the translation: paths to
// libraries, folders and files; WebDAV's methods, headers and XML.
//
// Only the protocol's class 1 is needed by rclone. Class 2 (LOCK/UNLOCK) is answered too,
// because Finder and Explorer mount read-only without it: a lock is held in memory for
// the requested time and refuses other LOCK requests, which is what gives Word and Excel
// their "file in use" warning; it is not checked on PUT or DELETE.
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { pipeline } = require('stream/promises');
const router = express.Router();
const db = require('../lib/db');
const auth = require('../middleware/auth');
const documentAccess = require('../lib/documentAccess');
const libraries = require('../lib/libraries');
const storage = require('../lib/storage');
const shareOpens = require('../lib/shareOpens');
const { effectiveScope, scopeCovers } = require('../lib/apiTokens');
const { logEvent, logDocumentEvent } = require('../lib/fileEvents');
const { DOCUMENT_COLUMNS, prefixRange, destinationFolder, createDocumentRecord, fileSizeLabelForEvent } = require('../lib/documents');
const { sendFolderOpError, copyLanding } = require('../lib/folderOps');
const { serverError } = require('../lib/httpError');
const { makeRateLimiters } = require('../lib/rateLimiters');
const filesRouter = require('./files');
const foldersRouter = require('./files/folders');

const MOUNT = '/dav';
const METHODS = 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, COPY, MOVE, LOCK, UNLOCK';
const WRITES = new Set(['PUT', 'DELETE', 'MKCOL', 'COPY', 'MOVE', 'LOCK', 'UNLOCK', 'PROPPATCH']);
// What operating systems and Office drop beside files. Accepted and thrown away: never
// stored, listed, indexed or announced, so a computer that insists on writing them is
// not refused, and the website never shows them.
const JUNK = /(^|\/)(\.DS_Store|\._[^/]*|\.Spotlight-V100|\.Trashes|\.fseventsd|\.TemporaryItems|\.apdisk|\.localized|\.metadata_never_index|Thumbs\.db|desktop\.ini|~\$[^/]*|\.~lock\.[^/]*#)$/i;
const LOCK_DEFAULT_SECONDS = 30 * 60;
const LOCK_MAX_SECONDS = 60 * 60;

const parentOf = (name) => { const n = String(name || ''); const i = n.lastIndexOf('/'); return i < 0 ? '' : n.slice(0, i); };
const baseOf = (name) => String(name || '').split('/').pop();
const isKeep = (name) => /(^|\/)\.keep$/.test(String(name || ''));
const isJunk = (name) => JUNK.test(String(name || ''));
const xml = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// A drive path as a URL path: each segment encoded, collections ending in a slash.
const hrefOf = (segments, collection) => `${MOUNT}/${segments.filter(Boolean).flatMap(s => s.split('/')).map(encodeURIComponent).join('/')}${collection && segments.some(Boolean) ? '/' : ''}`;
// The name a file or folder must have to be stored as asked (routes/files cleanDisplayName,
// lib/documents safeDocName). The drive refuses a name Depot would change rather than
// store it under another: the computer would otherwise think the file had vanished.
const keepsName = (segment) => filesRouter.cleanDisplayName(segment) === segment;

// ---- paths ----

// '/Marketing/Reports/q1.pdf' -> { libraryName: 'Marketing', path: 'Reports/q1.pdf' }; the
// root -> { libraryName: null, path: '' }. null for a path no drive can hold.
function splitPath(urlPath) {
  let segs;
  try { segs = String(urlPath || '').split('/').map(s => decodeURIComponent(s)); } catch { return null; }
  segs = segs.filter(Boolean);
  if (segs.some(s => s === '.' || s === '..' || /[\\\u0000-\u001f]/.test(s))) return null;
  return { libraryName: segs[0] || null, path: segs.slice(1).join('/') };
}

// The libraries on the drive, each with the folder name it is shown as: the ones the
// person owns or that are shared with them, or that hold their own files, and not the
// put-away ones. Not the libraries an administrator can open only because they
// administer -- that is every library in the place, and the website is where they
// manage them. A name two libraries share, or one that cannot be a folder name, is told
// apart with the start of the library's id.
async function driveLibraries(user) {
  const libs = (await libraries.listLibraries(user)).filter(l => !l.archived_at && l.my_access && l.my_access !== 'admin');
  const nameOf = (l) => String(l.name || '').replace(/[\\/\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim() || 'Library';
  const counts = new Map();
  for (const l of libs) counts.set(nameOf(l), (counts.get(nameOf(l)) || 0) + 1);
  return libs.map(l => ({ ...l, driveName: counts.get(nameOf(l)) > 1 ? `${nameOf(l)} (${String(l.id).slice(0, 8)})` : nameOf(l) }));
}

// What a drive path names, as the caller may see it:
//   { kind: 'root' } | { kind: 'library', lib, path: '' } | { kind: 'folder', lib, path }
//   | { kind: 'file', lib, path, doc } | { kind: 'missing', lib, path } | null (no such library)
async function resolve(user, urlPath, libs) {
  const parts = splitPath(urlPath);
  if (!parts) return null;
  if (!parts.libraryName) return { kind: 'root' };
  const lib = libs.find(l => l.driveName === parts.libraryName);
  if (!lib) return null;
  if (!parts.path) return { kind: 'library', lib, path: '' };
  const p = documentAccess.userParams(user, 'read');
  const doc = await db.queryOne(
    `SELECT ${DOCUMENT_COLUMNS} FROM documents d WHERE d.deleted_at IS NULL AND d.library_id = $1 AND d.name = $2 AND ${documentAccess.condition('d', 3)} LIMIT 1`,
    [lib.id, parts.path, ...p]);
  if (doc && !isKeep(doc.name)) return { kind: 'file', lib, path: parts.path, doc };
  const under = await db.queryOne(
    `SELECT 1 FROM documents d WHERE d.deleted_at IS NULL AND d.library_id = $1 AND ${prefixRange('d', '$2')} AND ${documentAccess.condition('d', 3)} LIMIT 1`,
    [lib.id, parts.path, ...p]);
  return { kind: under ? 'folder' : 'missing', lib, path: parts.path };
}

// What is directly inside a folder ('' for the library's root): its files, and the names
// of its sub-folders. Folder markers (.keep) are not files.
async function children(user, lib, folder) {
  const p = documentAccess.userParams(user, 'read');
  const base = `d.deleted_at IS NULL AND d.library_id = $6 AND ${documentAccess.condition('d', 1)}`;
  const params = [...p, lib.id];
  let direct, subs;
  if (folder) {
    params.push(folder);
    const rest = `substr(d.name, char_length($7) + 2)`;
    direct = `${base} AND ${prefixRange('d', '$7')} AND strpos(${rest}, '/') = 0`;
    subs = `SELECT DISTINCT split_part(${rest}, '/', 1) AS name FROM documents d WHERE ${base} AND ${prefixRange('d', '$7')} AND strpos(${rest}, '/') > 0`;
  } else {
    direct = `${base} AND strpos(d.name, '/') = 0`;
    subs = `SELECT DISTINCT split_part(d.name, '/', 1) AS name FROM documents d WHERE ${base} AND strpos(d.name, '/') > 0`;
  }
  const files = (await db.query(`SELECT ${DOCUMENT_COLUMNS} FROM documents d WHERE ${direct} ORDER BY d.name`, params)).filter(d => !isKeep(d.name));
  const folders = (await db.query(subs, params)).map(r => r.name).filter(Boolean).sort();
  return { files, folders };
}

// ---- answering ----

// Hand a request on to one of the app's own routes (as routes/v1.js forward does) and
// collect its answer instead of sending it, so it can be put into WebDAV's terms -- or
// followed by a second step. The target sees the request as its own, already
// authenticated, with the url, body, query and headers that route expects.
function ask(req, res, target, { method, url, body, query, headers } = {}) {
  return new Promise((done) => {
    const own = { status: res.status, json: res.json, end: res.end, send: res.send };
    let code = 200;
    const restore = () => Object.assign(res, own);
    res.status = (c) => { code = c; return res; };
    res.json = (payload) => { restore(); done({ status: code, body: payload }); return res; };
    res.send = (payload) => { restore(); done({ status: code, body: payload }); return res; };
    res.end = () => { restore(); done({ status: code, body: null }); return res; };
    req._v1Forward = true;
    if (method) req.method = method;
    req.url = url;
    req.query = query || {};
    if (body !== undefined) { req.body = body; req._body = true; }
    if (headers) for (const [k, v] of Object.entries(headers)) { if (v == null) delete req.headers[k]; else req.headers[k] = String(v); }
    target(req, res, (err) => { restore(); done({ status: err?.status || 500, body: { error: err?.message || 'Server error' } }); });
  });
}
// The app's answer was a refusal: pass it on as it is.
const refused = (res, r) => res.status(r.status).json(r.body && typeof r.body === 'object' ? r.body : { error: String(r.body || 'Refused') });

// Read and discard a request body (a PROPFIND's, a junk file's) so the connection stays usable.
const drain = (req) => new Promise((done) => { if (req.readableEnded || req.complete) return done(); req.on('end', done); req.on('error', done); req.resume(); });

const multistatus = (responses) => `<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:">${responses.join('')}</D:multistatus>`;
const sendXml = (res, status, body) => { res.status(status).set('Content-Type', 'application/xml; charset=utf-8').send(body); };
const LOCKENTRY = '<D:supportedlock><D:lockentry><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry></D:supportedlock>';

// One <D:response> of a PROPFIND answer. Every property the clients read is given,
// whatever the request asked for; none is marked missing.
function propResponse({ href, name, collection, size, modified, created, etag, type }) {
  const props = [
    `<D:displayname>${xml(name)}</D:displayname>`,
    `<D:resourcetype>${collection ? '<D:collection/>' : ''}</D:resourcetype>`,
    modified ? `<D:getlastmodified>${new Date(modified).toUTCString()}</D:getlastmodified>` : '',
    created ? `<D:creationdate>${new Date(created).toISOString()}</D:creationdate>` : '',
    collection ? '' : `<D:getcontentlength>${Number(size) || 0}</D:getcontentlength>`,
    collection ? '' : `<D:getcontenttype>${xml(type || 'application/octet-stream')}</D:getcontenttype>`,
    etag ? `<D:getetag>"${xml(etag)}"</D:getetag>` : '',
    LOCKENTRY,
  ].filter(Boolean).join('');
  return `<D:response><D:href>${xml(href)}</D:href><D:propstat><D:prop>${props}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
}
// An ETag that changes when the bytes do: the content hash, or for a file stored before
// hashes were kept, its id and modified time.
const etagOf = (d) => d.content_hash || `${d.id}-${Date.parse(d.modified_at || d.created_at) || 0}`;
const fileResponse = (lib, d) => propResponse({ href: hrefOf([lib.driveName, d.name], false), name: baseOf(d.name), size: d.size, modified: d.modified_at || d.created_at, created: d.created_at, etag: etagOf(d), type: d.mime_type });
const folderResponse = (lib, folder) => propResponse({ href: hrefOf([lib.driveName, folder], true), name: folder ? baseOf(folder) : lib.driveName, collection: true, created: folder ? null : lib.created_at, modified: folder ? null : lib.created_at });

// ---- the methods ----

async function propfind(req, res, t, libs) {
  await drain(req);
  const depth = String(req.headers.depth ?? 'infinity').toLowerCase();
  const list = depth !== '0'; // infinity is answered as 1: nothing on the drive needs more
  const out = [];
  if (t.kind === 'root') {
    out.push(propResponse({ href: hrefOf([], true), name: 'Depot', collection: true }));
    if (list) for (const lib of libs) out.push(folderResponse(lib, ''));
  } else if (t.kind === 'file') {
    out.push(fileResponse(t.lib, t.doc));
  } else {
    out.push(folderResponse(t.lib, t.path));
    if (list) {
      const { files, folders } = await children(req.user, t.lib, t.path);
      for (const f of folders) out.push(folderResponse(t.lib, t.path ? `${t.path}/${f}` : f));
      for (const d of files) out.push(fileResponse(t.lib, d));
    }
  }
  sendXml(res, 207, multistatus(out));
}

async function get(req, res, t, libs) {
  if (t.kind !== 'file') {
    // A folder in a browser (which can sign in with a token at the password prompt): its names.
    const names = t.kind === 'root' ? libs.map(l => l.driveName + '/')
      : (({ files, folders }) => [...folders.map(f => f + '/'), ...files.map(d => baseOf(d.name))])(await children(req.user, t.lib, t.path));
    return res.status(200).type('text/plain; charset=utf-8').send(req.method === 'HEAD' ? '' : names.join('\n') + '\n');
  }
  const doc = t.doc;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('ETag', `"${etagOf(doc)}"`);
  res.setHeader('Last-Modified', new Date(doc.modified_at || doc.created_at).toUTCString());
  res.setHeader('Content-Type', doc.mime_type || 'application/octet-stream');
  if (req.method === 'HEAD') { res.setHeader('Content-Length', String(Number(doc.size) || 0)); return res.status(200).end(); }
  // One download entry per open, as the website makes: a client reading a big file in
  // pieces, or a preview reading its start, asks many times and the first asks from 0.
  const range = String(req.headers.range || '');
  if (!range || /^bytes=0-/.test(range)) {
    shareOpens.grantsOpened(req.user, doc);
    await logEvent(`download · ${doc.name}`, req.user.id, req.user.email);
    await logDocumentEvent(doc.id, 'downloaded', req.user.id, req.user.email, doc.name);
  }
  const dl = await storage.downloadStream(doc.storage_path, { rangeHeader: range || undefined });
  if (dl.unsatisfiable) { res.setHeader('Content-Range', `bytes */${dl.totalSize}`); return res.status(416).end(); }
  if (dl.range) { res.status(206); res.setHeader('Content-Range', `bytes ${dl.range.start}-${dl.range.end}/${dl.totalSize}`); }
  if (dl.length != null) res.setHeader('Content-Length', String(dl.length));
  await pipeline(dl.stream, res);
}

// A file or folder about to be made at `p` in `lib`: whether Depot would keep that name.
// Existing folders along the way are kept exactly (destinationFolder); only the new part
// and the file name itself must be names Depot stores as given.
async function nameRefusal(user, lib, p, { folder = false } = {}) {
  const dir = folder ? p : parentOf(p);
  if (dir && (await destinationFolder(dir, lib.id, user)) !== dir) return 'Depot would change that folder name. Use letters, digits, spaces, dots, dashes and underscores.';
  if (!folder && !keepsName(baseOf(p))) return 'Depot would change that file name. Use letters, digits, spaces, dots, dashes and underscores.';
  return null;
}

async function put(req, res, t) {
  if (t.kind === 'root' || t.kind === 'library') return res.status(405).set('Allow', METHODS).json({ error: 'Files go inside a library' });
  if (t.kind === 'folder') return res.status(409).json({ error: 'A folder is at that path' });
  if (isJunk(t.path)) { await drain(req); return res.status(201).end(); }
  if (isKeep(t.path)) { await drain(req); return res.status(403).json({ error: '.keep is Depot\'s own folder marker' }); }
  const why = t.kind === 'missing' ? await nameRefusal(req.user, t.lib, t.path) : null;
  if (why) { await drain(req); return res.status(409).json({ error: why }); }
  // Finder sends the size of a chunked body in its own header; the upload route reads it
  // as Content-Length for its free-space check.
  if (!req.headers['content-length'] && req.headers['x-expected-entity-length']) req.headers['content-length'] = req.headers['x-expected-entity-length'];
  const existing = t.kind === 'file' ? t.doc : null;
  const r = await ask(req, res, filesRouter, {
    method: 'POST', url: `/upload-stream?displayName=${encodeURIComponent(t.path)}`, query: { displayName: t.path },
    headers: { 'x-library-id': t.lib.id, 'x-file-name': t.path, 'x-replace-id': existing ? existing.id : null },
  });
  // The app answers "not found" to a change by someone who may only look; the drive, which
  // has just listed the file to them, says what is really the matter.
  if (r.status === 404 && existing) return res.status(403).json({ error: 'You can open that file but not change it' });
  if (r.status !== 200) return refused(res, r);
  if (r.body?.doc?.name && r.body.doc.name !== t.path) {
    // Belt and braces: the name check above should have refused this.
    console.warn(`dav: ${t.path} was stored as ${r.body.doc.name}`);
  }
  res.setHeader('ETag', `"${etagOf(r.body?.doc || existing || {})}"`);
  res.status(existing ? 204 : 201).end();
}

async function mkcol(req, res, t) {
  await drain(req);
  if (t.kind !== 'missing') return res.status(405).set('Allow', METHODS).json({ error: t.kind === 'root' || t.kind === 'library' ? 'Libraries are made on the website' : 'Something is already at that path' });
  if (isJunk(t.path)) return res.status(201).end();
  const why = await nameRefusal(req.user, t.lib, t.path, { folder: true });
  if (why) return res.status(409).json({ error: why });
  const r = await ask(req, res, foldersRouter, { method: 'POST', url: '/', body: { library_id: t.lib.id, path: t.path } });
  if (r.status !== 200) return refused(res, r);
  res.status(201).end();
}

async function del(req, res, t) {
  await drain(req);
  if (t.kind === 'root' || t.kind === 'library') return res.status(403).json({ error: 'Libraries are put away or deleted on the website' });
  if (t.kind === 'missing') return isJunk(t.path) ? res.status(204).end() : res.status(404).json({ error: 'Not found' });
  const r = t.kind === 'file'
    ? await ask(req, res, filesRouter, { method: 'DELETE', url: `/${encodeURIComponent(t.doc.id)}` })
    : await ask(req, res, foldersRouter, { method: 'POST', url: '/delete', body: { path: t.path }, headers: { 'x-library-id': t.lib.id } });
  if (r.status === 404 && t.kind === 'file') return res.status(403).json({ error: 'You can open that file but not delete it' });
  if (r.status !== 200) return refused(res, r);
  res.status(204).end();
}

// Where a COPY or MOVE is going: the Destination header, as a drive path. null when it
// points off the drive.
function destinationOf(req) {
  let pathname;
  try { pathname = new URL(String(req.headers.destination || ''), 'http://depot').pathname; } catch { return null; }
  if (pathname !== MOUNT && !pathname.startsWith(MOUNT + '/')) return null;
  return pathname.slice(MOUNT.length) || '/';
}
const overwriteAllowed = (req) => String(req.headers.overwrite || 'T').trim().toUpperCase() !== 'F';

// A file saved OVER another (MOVE or COPY with Overwrite onto an existing file): the
// destination keeps its id, place, shares, links and history and takes the source's bytes
// as a new version -- the way Word, Excel and most editors save, by writing a temporary
// file and renaming it over the original. Done the way the app's own replace does
// (routes/files replaceContent), from the source's stored bytes rather than a request body.
async function replaceWith(req, res, dest, src) {
  const writable = await documentAccess.getAccessibleDocument({ id: dest.id, user: req.user, required: 'write', columns: `${DOCUMENT_COLUMNS}, document_text`, deleted: 'active' });
  if (!writable) return { status: 403, body: { error: 'You can open that file but not change it' } };
  if (writable.content_hash && src.content_hash && writable.content_hash === src.content_hash) return { status: 200, body: { unchanged: true } };
  const source = await db.queryOne('SELECT document_text FROM documents WHERE id = $1', [src.id]);
  const storagePath = `documents/${Date.now()}-${path.basename(dest.name).replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  try {
    await storage.copy(src.storage_path, storagePath, src.mime_type);
    if (Number(writable.size) > 0) await filesRouter.saveDocumentVersion(writable, req.user, 'replace'); // an empty file holds nothing worth a version
    const mime = src.mime_type && src.mime_type !== 'application/octet-stream' ? src.mime_type : (writable.mime_type || src.mime_type);
    const updated = await db.queryOne(
      `UPDATE documents SET storage_path = $2, size = $3, mime_type = $4, document_text = $5, content_hash = $6, modified_at = NOW()
        WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
      [writable.id, storagePath, Number(src.size) || 0, mime, source?.document_text ?? null, src.content_hash || null]);
    if (!updated) { await storage.del(storagePath).catch(() => {}); return { status: 409, body: { error: 'The file went to the trash meanwhile' } }; }
    await storage.del(writable.storage_path).catch(() => {}); // the version kept above holds these bytes
    await logDocumentEvent(writable.id, 'replaced', req.user.id, req.user.email, `${fileSizeLabelForEvent(Number(src.size) || 0)} · replaced by ${baseOf(src.name)} from the drive`);
    await logEvent(`replace · ${writable.name}`, req.user.id, req.user.email);
    return { status: 200, body: { replaced: true } };
  } catch (e) {
    await storage.del(storagePath).catch(() => {});
    throw e;
  }
}

async function move(req, res, t, libs) {
  await drain(req);
  if (t.kind === 'root' || t.kind === 'library') return res.status(403).json({ error: 'Libraries are renamed on the website' });
  if (t.kind === 'missing') return isJunk(t.path) ? res.status(201).end() : res.status(404).json({ error: 'Not found' });
  const destPath = destinationOf(req);
  const dest = destPath && await resolve(req.user, destPath, libs);
  if (!dest || dest.kind === 'root' || dest.kind === 'library') return res.status(403).json({ error: 'The destination must be a path inside a library on this drive' });
  if (isJunk(dest.path)) return res.status(403).json({ error: 'That name is reserved for housekeeping files' });
  if (dest.kind === 'folder' || (dest.kind === 'file' && t.kind === 'folder')) return res.status(409).json({ error: 'Something is already at the destination' });
  if (dest.kind === 'file' && !overwriteAllowed(req)) return res.status(412).json({ error: 'A file is already at the destination' });
  if (dest.kind === 'missing') {
    const why = await nameRefusal(req.user, dest.lib, dest.path, { folder: t.kind === 'folder' });
    if (why) return res.status(409).json({ error: why });
  }
  const sameLibrary = String(t.lib.id) === String(dest.lib.id);
  if (t.kind === 'file') {
    if (dest.kind === 'file') {
      const r = await replaceWith(req, res, dest.doc, t.doc);
      if (r.status !== 200) return refused(res, r);
      const gone = await ask(req, res, filesRouter, { method: 'DELETE', url: `/${encodeURIComponent(t.doc.id)}` });
      if (gone.status !== 200) return refused(res, gone);
      return res.status(204).end();
    }
    if (!sameLibrary) {
      const r = await ask(req, res, filesRouter, { method: 'POST', url: '/library-transfer', body: { ids: [t.doc.id], libraryId: dest.lib.id, mode: 'move' } });
      if (r.status !== 200) return refused(res, r);
      if (r.body?.count !== 1) return res.status(403).json({ error: 'That file belongs to its library and stays there; copy it instead' });
    }
    if (sameLibrary || dest.path !== t.path) {
      const r = await ask(req, res, filesRouter, { method: 'PUT', url: `/${encodeURIComponent(t.doc.id)}/rename`, body: { name: dest.path } });
      if (r.status !== 200) return refused(res, r);
    }
    return res.status(201).end();
  }
  // A folder: to another library first (same path there), then into its new parent, then
  // its new name -- each the website's own operation, and shares follow as they do there.
  let at = t.path, lib = t.lib;
  if (!sameLibrary) {
    const r = await ask(req, res, foldersRouter, { method: 'POST', url: '/move', body: { path: t.path, library_id: dest.lib.id }, headers: { 'x-library-id': t.lib.id } });
    if (r.status !== 200) return refused(res, r);
    lib = dest.lib;
  }
  if (parentOf(dest.path) !== parentOf(at)) {
    const r = await ask(req, res, foldersRouter, { method: 'POST', url: '/reparent', body: { path: at, target: parentOf(dest.path) }, headers: { 'x-library-id': lib.id } });
    if (r.status !== 200) return refused(res, r);
    at = parentOf(dest.path) ? `${parentOf(dest.path)}/${baseOf(at)}` : baseOf(at);
  }
  if (baseOf(dest.path) !== baseOf(at)) {
    const r = await ask(req, res, foldersRouter, { method: 'POST', url: '/rename', body: { path: at, name: baseOf(dest.path) }, headers: { 'x-library-id': lib.id } });
    if (r.status !== 200) return refused(res, r);
  }
  res.status(201).end();
}

async function copy(req, res, t, libs) {
  await drain(req);
  if (t.kind === 'root' || t.kind === 'library') return res.status(403).json({ error: 'Copy folders or files, not a whole library' });
  if (t.kind === 'missing') return isJunk(t.path) ? res.status(201).end() : res.status(404).json({ error: 'Not found' });
  const destPath = destinationOf(req);
  const dest = destPath && await resolve(req.user, destPath, libs);
  if (!dest || dest.kind === 'root' || dest.kind === 'library') return res.status(403).json({ error: 'The destination must be a path inside a library on this drive' });
  if (isJunk(dest.path)) return res.status(403).json({ error: 'That name is reserved for housekeeping files' });
  if (dest.kind === 'folder' || (dest.kind === 'file' && t.kind === 'folder')) return res.status(409).json({ error: 'Something is already at the destination' });
  if (dest.kind === 'file' && !overwriteAllowed(req)) return res.status(412).json({ error: 'A file is already at the destination' });
  if (t.kind === 'folder') {
    // The website copies a folder to another library, at the same path; nothing else.
    if (String(t.lib.id) === String(dest.lib.id) || dest.path !== t.path) return res.status(403).json({ error: 'Depot copies a folder only to another library, at the same path' });
    const r = await ask(req, res, foldersRouter, { method: 'POST', url: '/copy', body: { path: t.path, library_id: dest.lib.id }, headers: { 'x-library-id': t.lib.id } });
    if (r.status !== 200) return refused(res, r);
    return res.status(201).end();
  }
  if (dest.kind === 'file') {
    const r = await replaceWith(req, res, dest.doc, t.doc);
    return r.status === 200 ? res.status(204).end() : refused(res, r);
  }
  const why = await nameRefusal(req.user, dest.lib, dest.path);
  if (why) return res.status(409).json({ error: why });
  // A new file from the source's stored bytes, as the website's copy makes one.
  const d = t.doc;
  const storagePath = `documents/${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${path.basename(d.name).replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  try {
    await storage.copy(d.storage_path, storagePath, d.mime_type);
    await createDocumentRecord({
      displayName: dest.path, storagePath, mimetype: d.mime_type, storedSize: Number(d.size) || 0, user: req.user, sourceDetail: 'copied',
      libraryId: dest.lib.id, resolve: copyLanding(req.user, dest.lib.id, dest.path),
    }).catch(async (e) => { if (e.notPlaced) await storage.del(storagePath).catch(() => {}); throw e; });
    res.status(201).end();
  } catch (e) {
    if (sendFolderOpError(res, e)) return;
    throw e;
  }
}

// ---- locks: held in memory, for the time asked, refusing other LOCK requests ----
const locks = new Map(); // "<library id>/<path>" -> { token, expires }
function sweepLocks() { const now = Date.now(); for (const [k, l] of locks) if (l.expires <= now) locks.delete(k); }
async function lock(req, res, t) {
  await drain(req);
  if (t.kind === 'root' || t.kind === 'library') return res.status(403).json({ error: 'Lock a file, not a library' });
  if (locks.size > 500) sweepLocks();
  const key = `${t.lib.id}/${t.path}`;
  const held = locks.get(key);
  const now = Date.now();
  const mine = held && held.expires > now && String(req.headers.if || '').includes(held.token);
  if (held && held.expires > now && !mine) return res.status(423).json({ error: 'That file is in use by someone else' });
  const asked = /Second-(\d+)/i.exec(String(req.headers.timeout || ''));
  const seconds = Math.min(asked ? Number(asked[1]) : LOCK_DEFAULT_SECONDS, LOCK_MAX_SECONDS) || LOCK_DEFAULT_SECONDS;
  const token = mine ? held.token : `opaquelocktoken:${crypto.randomUUID()}`;
  locks.set(key, { token, expires: now + seconds * 1000 });
  const href = hrefOf([t.lib.driveName, t.path], t.kind === 'folder');
  res.setHeader('Lock-Token', `<${token}>`);
  sendXml(res, 200, `<?xml version="1.0" encoding="utf-8"?>\n<D:prop xmlns:D="DAV:"><D:lockdiscovery><D:activelock><D:locktype><D:write/></D:locktype><D:lockscope><D:exclusive/></D:lockscope><D:depth>0</D:depth><D:timeout>Second-${seconds}</D:timeout><D:locktoken><D:href>${xml(token)}</D:href></D:locktoken><D:lockroot><D:href>${xml(href)}</D:href></D:lockroot></D:activelock></D:lockdiscovery></D:prop>`);
}
async function unlock(req, res, t) {
  await drain(req);
  if (t.lib) {
    const key = `${t.lib.id}/${t.path}`;
    const token = String(req.headers['lock-token'] || '').replace(/^<|>$/g, '');
    if (locks.get(key)?.token === token) locks.delete(key);
  }
  res.status(204).end();
}

// Clients set properties of their own after a save (Finder's dates, Windows' attributes).
// Nothing is kept; the answer says the request was understood.
async function proppatch(req, res, t) {
  await drain(req);
  const href = t.kind === 'root' ? hrefOf([], true) : hrefOf([t.lib.driveName, t.path], t.kind !== 'file');
  sendXml(res, 207, multistatus([`<D:response><D:href>${xml(href)}</D:href><D:propstat><D:prop/><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`]));
}

// ---- the router ----

// A refusal to sign in must say how to: without this, no client shows a password prompt.
router.use((_req, res, next) => {
  const status = res.status.bind(res);
  res.status = (code) => { if (code === 401) res.set('WWW-Authenticate', 'Basic realm="Depot", charset="UTF-8"'); return status(code); };
  next();
});
// What the drive speaks, asked before signing in: Explorer and Finder ask first.
router.use((req, res, next) => {
  if (req.method !== 'OPTIONS') return next();
  res.set({ DAV: '1, 2', Allow: METHODS, 'MS-Author-Via': 'DAV' });
  res.status(200).end();
});
router.use(auth);
router.use(makeRateLimiters().tokenLimiter);
router.use(async (req, res) => {
  try {
    if (WRITES.has(req.method) && !scopeCovers(effectiveScope(req.user, req.apiToken), 'write')) {
      await drain(req);
      return res.status(403).json({ error: req.apiToken ? 'This token is read only; the drive is read only with it' : 'You can look at files here, not change them' });
    }
    const libs = await driveLibraries(req.user);
    const t = await resolve(req.user, req.path, libs);
    if (!t) {
      await drain(req);
      // Finder and Windows write their housekeeping files at the top of the drive too, where
      // no library can hold them: accepted and discarded there as everywhere else, or rclone
      // would retry the write for ever.
      let name = ''; try { name = decodeURIComponent(req.path); } catch { /* not a path */ }
      if (isJunk(name)) {
        if (req.method === 'PUT' || req.method === 'MKCOL') return res.status(201).end();
        if (req.method === 'DELETE') return res.status(204).end();
      }
      return res.status(404).json({ error: 'No such library on this drive' });
    }
    switch (req.method) {
      case 'PROPFIND':
        if (t.kind === 'missing') { await drain(req); return res.status(404).json({ error: 'Not found' }); }
        return await propfind(req, res, t, libs);
      case 'GET': case 'HEAD':
        if (t.kind === 'missing') return res.status(404).json({ error: 'Not found' });
        return await get(req, res, t, libs);
      case 'PUT': return await put(req, res, t);
      case 'MKCOL': return await mkcol(req, res, t);
      case 'DELETE': return await del(req, res, t);
      case 'MOVE': return await move(req, res, t, libs);
      case 'COPY': return await copy(req, res, t, libs);
      case 'LOCK': return await lock(req, res, t);
      case 'UNLOCK': return await unlock(req, res, t);
      case 'PROPPATCH':
        if (t.kind === 'missing') return res.status(404).json({ error: 'Not found' });
        return await proppatch(req, res, t);
      default:
        await drain(req);
        return res.status(405).set('Allow', METHODS).json({ error: `${req.method} is not something the drive does` });
    }
  } catch (e) {
    if (!res.headersSent) serverError(res, e); else res.destroy(e);
  }
});

module.exports = router;
module.exports._forTests = { splitPath, driveLibraries, resolve, children, isJunk, keepsName, locks };

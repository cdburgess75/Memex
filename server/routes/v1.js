'use strict';
// The public API, version 1. Documented in lib/openapi.js and at /api/docs.
//
// Release 1 is files, folders, libraries, links, search, trash and activity; release 2
// adds people, groups, sharing and administration (the second half of this file).
//
// Every route takes an ordinary sign-in or a personal access token (middleware/auth),
// and names the scope it needs (middleware/requireScope). Listings are answered here with
// the same queries the app uses; anything that changes a file is HANDED ON to the app's
// own route for it (forward), so one implementation holds the locks, the rights checks,
// the shared-folder markers and the audit entries. Responses from those routes come back
// as they are.
//
// v1 only grows: a field or an endpoint may be added, nothing existing changes shape.
const express = require('express');
const router = express.Router();
const db = require('../lib/db');
const auth = require('../middleware/auth');
const requireScope = require('../middleware/requireScope');
const documentAccess = require('../lib/documentAccess');
const libraries = require('../lib/libraries');
const storage = require('../lib/storage');
const shareOpens = require('../lib/shareOpens');
const apiTokens = require('../lib/apiTokens');
const { logEvent, logDocumentEvent } = require('../lib/fileEvents');
const { DOCUMENT_COLUMNS, prefixRange } = require('../lib/documents');
const { serverError } = require('../lib/httpError');
const { makeRateLimiters } = require('../lib/rateLimiters');
const filesRouter = require('./files');
const foldersRouter = require('./files/folders');
const librariesRouter = require('./libraries');
const groupsRouter = require('./groups');
const accessRouter = require('./access');
const adminRouter = require('./admin');
const settingsRouter = require('./settings');
const editorRouter = require('./editor');
const connectorsRouter = require('./connectors');
const licenseRouter = require('./license');
const securityRouter = require('./security');
const tokensRouter = require('./tokens');
const settingsLib = require('../lib/settings');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (s) => UUID_RE.test(String(s || ''));
const parentOf = (name) => { const n = String(name || ''); const i = n.lastIndexOf('/'); return i < 0 ? '' : n.slice(0, i); };
const baseOf = (name) => String(name || '').split('/').pop();
const tidyPath = (p) => String(p || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/');
const isKeep = (name) => /(^|\/)\.keep$/.test(String(name || ''));

// One shape for a file, everywhere in v1.
function shapeFile(d) {
  return {
    id: d.id, name: baseOf(d.name), path: d.name, folder: parentOf(d.name),
    size: Number(d.size) || 0, mime_type: d.mime_type || null,
    library_id: d.library_id || null, library_content: !!d.library_scoped,
    uploaded_by: d.uploaded_by || null, uploaded_by_email: d.uploaded_by_email || null,
    created_at: d.created_at, deleted_at: d.deleted_at || null,
  };
}

// Hand a request on to one of the app's own routes. The target router sees it as its own
// request, already authenticated (auth's fast path), with the url, body, query and headers
// that route expects. Its answer goes straight back to the caller.
function forward(req, res, next, target, { method, url, body, query, headers } = {}) {
  req._v1Forward = true;
  if (method) req.method = method;
  req.url = url;
  req.query = query || {};
  if (body !== undefined) { req.body = body; req._body = true; }
  if (headers) for (const [k, v] of Object.entries(headers)) { if (v == null) delete req.headers[k]; else req.headers[k] = String(v); }
  return target(req, res, next);
}

router.use(auth);
router.use(makeRateLimiters().tokenLimiter);

// ---- who am I ----
router.get('/me', requireScope('read'), (req, res) => {
  res.json({
    user: { id: req.user.id, email: req.user.email, role: req.user.role },
    scope: apiTokens.effectiveScope(req.user, req.apiToken),
    token: req.apiToken ? { id: req.apiToken.id, name: req.apiToken.name, scope: req.apiToken.scope, expires_at: req.apiToken.expires_at } : null,
  });
});

// ---- libraries ----
router.get('/libraries', requireScope('read'), async (req, res) => {
  try { res.json({ libraries: await libraries.listLibraries(req.user) }); } catch (e) { serverError(res, e); }
});
router.post('/libraries', requireScope('write'), (req, res, next) =>
  forward(req, res, next, librariesRouter, { method: 'POST', url: '/', body: { name: req.body?.name } }));
router.get('/libraries/:id', requireScope('read'), async (req, res) => {
  try {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Library not found' });
    const lib = (await libraries.listLibraries(req.user)).find(l => String(l.id) === String(req.params.id));
    if (!lib) return res.status(404).json({ error: 'Library not found' });
    res.json(lib);
  } catch (e) { serverError(res, e); }
});
router.patch('/libraries/:id', requireScope('write'), (req, res, next) =>
  forward(req, res, next, librariesRouter, { method: 'PATCH', url: `/${encodeURIComponent(req.params.id)}`, body: { name: req.body?.name } }));

// ---- listing a folder ----
// GET /libraries/:id/files?folder=&recursive=&limit=&offset=
// The folder's own files (or, recursive, everything under it) and its sub-folders with
// how many files each holds. Folder markers (.keep) are not files.
router.get('/libraries/:id/files', requireScope('read'), async (req, res) => {
  try {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Library not found' });
    const libraryId = req.params.id;
    const folder = tidyPath(req.query.folder);
    const recursive = String(req.query.recursive || '') === 'true';
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 1000, 1), 5000);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const p = documentAccess.userParams(req.user, 'read');
    const where = [`d.deleted_at IS NULL`, documentAccess.condition('d', 1), `d.library_id = $6`, `d.name !~ '(^|/)\\.keep$'`];
    const params = [...p, libraryId];
    if (folder) {
      params.push(folder);
      where.push(recursive ? prefixRange('d', '$7') : `${prefixRange('d', '$7')} AND strpos(substr(d.name, char_length($7) + 2), '/') = 0`);
    } else if (!recursive) {
      where.push(`strpos(d.name, '/') = 0`);
    }
    const total = await db.queryOne(`SELECT count(*)::int AS n FROM documents d WHERE ${where.join(' AND ')}`, params);
    const rows = await db.query(
      `SELECT ${DOCUMENT_COLUMNS} FROM documents d WHERE ${where.join(' AND ')} ORDER BY d.name LIMIT ${limit} OFFSET ${offset}`, params);
    // Sub-folders, from the same index the app's rail uses.
    const dirs = await db.query(
      `WITH v AS MATERIALIZED (
         SELECT btrim(d.name, '/') AS name FROM documents d
          WHERE d.deleted_at IS NULL AND ${documentAccess.condition('d', 1)} AND d.library_id = $6 AND strpos(btrim(d.name, '/'), '/') > 0
       ), dirs AS (
         SELECT regexp_replace(name, '/[^/]*$', '') AS dir, count(*) FILTER (WHERE name !~ '(^|/)\\.keep$')::int AS n FROM v GROUP BY 1
       )
       SELECT array_to_string(parts[1:i], '/') AS path, sum(n)::int AS count
         FROM (SELECT string_to_array(dir, '/') AS parts, n FROM dirs) s, generate_series(1, array_length(parts, 1)) i
        GROUP BY 1 ORDER BY 1`, [...p, libraryId]);
    const prefix = folder ? folder + '/' : '';
    const folders = dirs
      .filter(r => (folder ? r.path.startsWith(prefix) : true) && (recursive || !r.path.slice(prefix.length).includes('/')))
      .map(r => ({ path: r.path, name: baseOf(r.path), count: r.count }));
    res.json({ library_id: libraryId, folder, recursive, folders, files: rows.map(shapeFile), total: total.n, limit, offset });
  } catch (e) { serverError(res, e); }
});

// ---- files ----
router.get('/files/:id', requireScope('read'), async (req, res) => {
  try {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'File not found' });
    const doc = await documentAccess.getAccessibleDocument({ id: req.params.id, user: req.user, required: 'read', columns: DOCUMENT_COLUMNS, deleted: 'active' });
    if (!doc) return res.status(404).json({ error: 'File not found' });
    res.json(shapeFile(doc));
  } catch (e) { serverError(res, e); }
});

// The bytes, as a download. Range requests are honoured, so a client can resume.
router.get('/files/:id/content', requireScope('read'), async (req, res) => {
  try {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'File not found' });
    const doc = await documentAccess.getAccessibleDocument({ id: req.params.id, user: req.user, required: 'read', columns: DOCUMENT_COLUMNS, deleted: 'active' });
    if (!doc) return res.status(404).json({ error: 'File not found' });
    shareOpens.grantsOpened(req.user, doc);
    await logEvent(`download · ${doc.name}`, req.user.id, req.user.email);
    await logDocumentEvent(doc.id, 'downloaded', req.user.id, req.user.email, doc.name);
    const dl = await storage.downloadStream(doc.storage_path, { rangeHeader: req.headers.range });
    const { stream, length, totalSize, range, unsatisfiable } = dl;
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Accept-Ranges', 'bytes');
    if (unsatisfiable) { res.setHeader('Content-Range', `bytes */${totalSize}`); return res.status(416).end(); }
    res.setHeader('Content-Type', doc.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${baseOf(doc.name).replace(/["\r\n]/g, '_')}"`);
    if (range) { res.status(206); res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${totalSize}`); }
    if (length != null) res.setHeader('Content-Length', String(length));
    const { pipeline } = require('stream/promises');
    await pipeline(stream, res);
  } catch (e) {
    if (!res.headersSent) serverError(res, e); else res.destroy(e);
  }
});

// PUT /libraries/:id/files/<path> — one request, the body is the file. A live file at that
// exact path already is a 409 with its id: delete or rename it first, or PUT another path.
router.put('/libraries/:id/files/*', requireScope('write'), async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Library not found' });
    const path = tidyPath(decodeURIComponent(req.params[0] || ''));
    if (!path || isKeep(path)) return res.status(400).json({ error: 'A file path is required, such as Reports/2026/q1.pdf' });
    const taken = await db.queryOne(
      `SELECT d.id FROM documents d WHERE d.deleted_at IS NULL AND d.library_id = $1 AND d.name = $2 AND ${documentAccess.condition('d', 3)} LIMIT 1`,
      [req.params.id, path, ...documentAccess.userParams(req.user, 'read')]);
    if (taken) return res.status(409).json({ error: 'A file is already at that path', existing_id: taken.id });
    return forward(req, res, next, filesRouter, {
      method: 'POST', url: `/upload-stream?displayName=${encodeURIComponent(path)}`,
      query: { displayName: path }, headers: { 'x-library-id': req.params.id, 'x-file-name': path },
    });
  } catch (e) { serverError(res, e); }
});

// Rename, or move to another folder of the same library.
router.patch('/files/:id', requireScope('write'), async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'File not found' });
    const doc = await documentAccess.getAccessibleDocument({ id: req.params.id, user: req.user, required: 'write', columns: DOCUMENT_COLUMNS, deleted: 'active' });
    if (!doc) return res.status(404).json({ error: 'File not found' });
    const name = req.body?.name != null ? String(req.body.name) : baseOf(doc.name);
    const folder = req.body?.folder != null ? tidyPath(req.body.folder) : parentOf(doc.name);
    if (!name || name.includes('/')) return res.status(400).json({ error: 'name is the file name only; use folder for where it goes' });
    return forward(req, res, next, filesRouter, { method: 'PUT', url: `/${encodeURIComponent(doc.id)}/rename`, body: { name: folder ? `${folder}/${name}` : name } });
  } catch (e) { serverError(res, e); }
});
router.delete('/files/:id', requireScope('write'), (req, res, next) =>
  forward(req, res, next, filesRouter, { method: 'DELETE', url: `/${encodeURIComponent(req.params.id)}` }));
router.post('/files/:id/restore', requireScope('write'), (req, res, next) =>
  forward(req, res, next, filesRouter, { method: 'POST', url: `/${encodeURIComponent(req.params.id)}/restore`, body: {} }));

// ---- trash ----
router.get('/trash', requireScope('write'), async (req, res) => {
  try {
    const rows = await db.query(
      `SELECT ${DOCUMENT_COLUMNS} FROM documents d WHERE d.deleted_at IS NOT NULL AND ${documentAccess.conditionInTrash('d', 1)} ORDER BY d.deleted_at DESC`,
      documentAccess.userParams(req.user, 'write'));
    res.json({ files: rows.filter(d => !isKeep(d.name)).map(shapeFile) });
  } catch (e) { serverError(res, e); }
});

// ---- search ----
router.get('/search', requireScope('read'), async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.status(400).json({ error: 'q is required' });
    const rows = await db.query(
      `SELECT ${DOCUMENT_COLUMNS},
              ts_headline('english', coalesce(d.document_text, ''), websearch_to_tsquery('english', $1), 'StartSel=<<, StopSel=>>, MaxFragments=2, MaxWords=18, MinWords=5') AS headline
         FROM documents d
        WHERE d.deleted_at IS NULL AND d.name !~ '(^|/)\\.keep$'
          AND (d.document_fts @@ websearch_to_tsquery('english', $1) OR d.name ILIKE '%' || $1 || '%')
          AND ${documentAccess.condition('d', 2)}
        ORDER BY ts_rank(d.document_fts, websearch_to_tsquery('english', $1)) DESC NULLS LAST, d.created_at DESC
        LIMIT 100`, [q, ...documentAccess.userParams(req.user, 'read')]);
    res.json({ q, files: rows.map(d => ({ ...shapeFile(d), headline: d.headline || null })) });
  } catch (e) { serverError(res, e); }
});

// ---- share links ----
router.get('/files/:id/links', requireScope('write'), (req, res, next) =>
  forward(req, res, next, filesRouter, { method: 'GET', url: `/${encodeURIComponent(req.params.id)}/shares` }));
router.post('/files/:id/links', requireScope('write'), (req, res, next) =>
  forward(req, res, next, filesRouter, { method: 'POST', url: `/${encodeURIComponent(req.params.id)}/shares`,
    body: { expiresInDays: req.body?.expires_in_days, neverExpires: !!req.body?.never_expires, password: req.body?.password || '' } }));
router.delete('/files/:id/links/:linkId', requireScope('write'), (req, res, next) =>
  forward(req, res, next, filesRouter, { method: 'DELETE', url: `/${encodeURIComponent(req.params.id)}/shares/${encodeURIComponent(req.params.linkId)}` }));

// ---- folders ----
router.post('/libraries/:id/folders', requireScope('write'), (req, res, next) =>
  forward(req, res, next, foldersRouter, { method: 'POST', url: '/', body: { library_id: req.params.id, path: req.body?.path } }));
router.post('/libraries/:id/folders/rename', requireScope('write'), (req, res, next) =>
  forward(req, res, next, foldersRouter, { method: 'POST', url: '/rename', body: { path: req.body?.path, name: req.body?.name }, headers: { 'x-library-id': req.params.id } }));
router.post('/libraries/:id/folders/move', requireScope('write'), (req, res, next) =>
  forward(req, res, next, foldersRouter, { method: 'POST', url: '/move', body: { path: req.body?.path, library_id: req.body?.to_library_id || req.params.id }, headers: { 'x-library-id': req.params.id } }));
router.delete('/libraries/:id/folders', requireScope('write'), (req, res, next) =>
  forward(req, res, next, foldersRouter, { method: 'POST', url: '/delete', body: { path: req.body?.path ?? req.query.path }, headers: { 'x-library-id': req.params.id } }));

// ---- resumable uploads, for big files or weak links ----
router.post('/uploads', requireScope('write'), (req, res, next) => {
  const b = req.body || {};
  const path = tidyPath(b.path || b.name);
  if (!path) return res.status(400).json({ error: 'path is required' });
  if (!isUuid(b.library_id)) return res.status(400).json({ error: 'library_id is required' });
  return forward(req, res, next, filesRouter, { method: 'POST', url: '/uploads',
    body: { displayName: path, size: b.size, mimeType: b.mime_type, chunkSize: b.chunk_size }, headers: { 'x-library-id': b.library_id } });
});
router.get('/uploads/:id', requireScope('write'), (req, res, next) =>
  forward(req, res, next, filesRouter, { method: 'GET', url: `/uploads/${encodeURIComponent(req.params.id)}` }));
router.put('/uploads/:id/chunks/:index', requireScope('write'), (req, res, next) =>
  forward(req, res, next, filesRouter, { method: 'PUT', url: `/uploads/${encodeURIComponent(req.params.id)}/chunks/${encodeURIComponent(req.params.index)}` }));
router.post('/uploads/:id/complete', requireScope('write'), (req, res, next) =>
  forward(req, res, next, filesRouter, { method: 'POST', url: `/uploads/${encodeURIComponent(req.params.id)}/complete`, body: req.body || {} }));
router.delete('/uploads/:id', requireScope('write'), (req, res, next) =>
  forward(req, res, next, filesRouter, { method: 'DELETE', url: `/uploads/${encodeURIComponent(req.params.id)}` }));

// ---- activity, to poll ----
// GET /activity?since=<ISO time>&limit= — what happened to files the caller can see, newest
// first. An administrator sees everything.
router.get('/activity', requireScope('read'), async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    let since = null;
    if (req.query.since) { since = new Date(String(req.query.since)); if (isNaN(since)) return res.status(400).json({ error: 'since must be a date' }); }
    const admin = req.user.role === 'admin';
    const params = admin ? [since, limit] : [since, limit, ...documentAccess.userParams(req.user, 'read')];
    const rows = await db.query(
      `SELECT de.id, de.event_type, de.actor_email, de.detail, de.created_at, de.document_id, d.name AS path, d.library_id
         FROM document_events de LEFT JOIN documents d ON d.id = de.document_id
        WHERE ($1::timestamptz IS NULL OR de.created_at > $1)
          ${admin ? '' : `AND d.id IS NOT NULL AND ${documentAccess.condition('d', 3)}`}
        ORDER BY de.created_at DESC LIMIT $2`, params);
    res.json({ since: since ? since.toISOString() : null, events: rows.map(r => ({ id: r.id, type: r.event_type, actor_email: r.actor_email, detail: r.detail, at: r.created_at, file_id: r.document_id, path: r.path || null, library_id: r.library_id || null })) });
  } catch (e) { serverError(res, e); }
});


// =====================================================================================
// Release 2: people, groups, sharing and administration. The same rule as above: lists
// are answered here, changes are handed on to the app's own route.
// =====================================================================================

// Hand on, and reshape a successful answer on its way back; errors pass as they are.
function forwardShaped(req, res, next, target, opts, shape) {
  const send = res.json.bind(res);
  res.json = (body) => send(res.statusCode < 300 ? shape(body) : body);
  return forward(req, res, next, target, opts);
}
// An id that is not a uuid is nothing the app's routes should be asked about.
const needUuid = (param, what) => (req, res, next) => (isUuid(req.params[param]) ? next() : res.status(404).json({ error: `${what} not found` }));
const enc = (v) => encodeURIComponent(String(v));
const idPath = (req) => `/${enc(req.params.id)}`;
const adminOnly = requireScope('admin');

// ---- people (administrators) ----
const USER_COLUMNS = 'user_id, email, role, assigned_at, disabled_at, disabled_reason';
// /users/{id} takes the account id, or the person's address.
async function accountIdFrom(req, res) {
  const key = String(req.params.id || '').trim();
  if (isUuid(key)) return key;
  if (key.includes('@')) {
    const rows = await db.query('SELECT user_id FROM user_roles WHERE lower(email) = $1 OR verified_email = $1', [key.toLowerCase()]);
    if (rows.length === 1) return rows[0].user_id;
    if (rows.length > 1) { res.status(409).json({ error: `More than one account uses ${key.toLowerCase()}; use the account id` }); return null; }
  }
  res.status(404).json({ error: 'No such account' });
  return null;
}
router.get('/users', adminOnly, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim().slice(0, 200);
    const rows = await db.query(
      `SELECT ${USER_COLUMNS} FROM user_roles WHERE $1 = '' OR email ILIKE $2 ORDER BY lower(email)`,
      [q, '%' + q.replace(/[\\%_]/g, (c) => '\\' + c) + '%']);
    res.json({ users: rows });
  } catch (e) { serverError(res, e); }
});
router.get('/users/:id', adminOnly, async (req, res) => {
  try {
    const id = await accountIdFrom(req, res); if (!id) return;
    const row = await db.queryOne(`SELECT ${USER_COLUMNS} FROM user_roles WHERE user_id = $1`, [id]);
    if (!row) return res.status(404).json({ error: 'No such account' });
    res.json(row);
  } catch (e) { serverError(res, e); }
});
router.get('/users/:id/departure', adminOnly, async (req, res, next) => {
  try { const id = await accountIdFrom(req, res); if (id) forward(req, res, next, adminRouter, { method: 'GET', url: `/users/${id}/departure` }); }
  catch (e) { serverError(res, e); }
});
router.put('/users/:id/role', adminOnly, async (req, res, next) => {
  try {
    const id = await accountIdFrom(req, res); if (!id) return;
    // The app's route makes a row for an id it has not seen (accounts arrive from the
    // sign-in server); a script's mistyped id must not.
    if (!(await db.queryOne('SELECT 1 FROM user_roles WHERE user_id = $1', [id]))) return res.status(404).json({ error: 'No such account' });
    forward(req, res, next, adminRouter, { method: 'PUT', url: `/users/${id}/role`, body: { role: req.body?.role } });
  } catch (e) { serverError(res, e); }
});
router.put('/users/:id/disabled', adminOnly, async (req, res, next) => {
  try {
    const id = await accountIdFrom(req, res); if (!id) return;
    forward(req, res, next, adminRouter, { method: 'PUT', url: `/users/${id}/disabled`, body: { disabled: req.body?.disabled === true, reason: req.body?.reason } });
  } catch (e) { serverError(res, e); }
});

// ---- groups ----
// Whoever makes a group owns it; members see it; an administrator sees every group.
router.get('/groups', requireScope('read'), (req, res, next) => forward(req, res, next, groupsRouter, { method: 'GET', url: '/' }));
router.post('/groups', requireScope('write'), (req, res, next) => forward(req, res, next, groupsRouter, { method: 'POST', url: '/', body: { name: req.body?.name } }));
router.get('/groups/:id', requireScope('read'), needUuid('id', 'Group'), (req, res, next) => forward(req, res, next, groupsRouter, { method: 'GET', url: idPath(req) }));
router.patch('/groups/:id', requireScope('write'), needUuid('id', 'Group'), (req, res, next) => forward(req, res, next, groupsRouter, { method: 'PUT', url: idPath(req), body: { name: req.body?.name } }));
router.delete('/groups/:id', requireScope('write'), needUuid('id', 'Group'), (req, res, next) => forward(req, res, next, groupsRouter, { method: 'DELETE', url: idPath(req) }));
router.get('/groups/:id/members', requireScope('read'), needUuid('id', 'Group'), (req, res, next) => forward(req, res, next, groupsRouter, { method: 'GET', url: `${idPath(req)}/members` }));
router.post('/groups/:id/members', requireScope('write'), needUuid('id', 'Group'), (req, res, next) => forward(req, res, next, groupsRouter, { method: 'POST', url: `${idPath(req)}/members`, body: { email: req.body?.email } }));
router.delete('/groups/:id/members/:memberId', requireScope('write'), needUuid('id', 'Group'), needUuid('memberId', 'Member'), (req, res, next) => forward(req, res, next, groupsRouter, { method: 'DELETE', url: `${idPath(req)}/members/${enc(req.params.memberId)}` }));
router.put('/groups/:id/owner', requireScope('write'), needUuid('id', 'Group'), (req, res, next) => forward(req, res, next, groupsRouter, { method: 'PUT', url: `${idPath(req)}/owner`, body: { email: req.body?.email } }));

// ---- sharing: libraries and folders with people and groups; single files with people ----
router.get('/shared-with-me', requireScope('read'), (req, res, next) => forward(req, res, next, accessRouter, { method: 'GET', url: '/shared-with-me' }));
router.get('/libraries/:id/shares', requireScope('read'), needUuid('id', 'Library'), (req, res, next) =>
  forward(req, res, next, librariesRouter, { method: 'GET', url: `${idPath(req)}/shares`, query: req.query.folder ? { path: String(req.query.folder) } : {} }));
router.post('/libraries/:id/shares', requireScope('write'), needUuid('id', 'Library'), (req, res, next) => {
  const b = req.body || {};
  return forward(req, res, next, librariesRouter, { method: 'POST', url: `${idPath(req)}/shares`, body: { email: b.email, group_id: b.group_id, permission: b.permission, folder_path: b.folder } });
});
router.patch('/libraries/:id/shares/:shareId', requireScope('write'), needUuid('id', 'Library'), needUuid('shareId', 'Share'), (req, res, next) =>
  forward(req, res, next, librariesRouter, { method: 'PUT', url: `${idPath(req)}/shares/${enc(req.params.shareId)}`, body: { permission: req.body?.permission } }));
router.delete('/libraries/:id/shares/:shareId', requireScope('write'), needUuid('id', 'Library'), needUuid('shareId', 'Share'), (req, res, next) =>
  forward(req, res, next, librariesRouter, { method: 'DELETE', url: `${idPath(req)}/shares/${enc(req.params.shareId)}` }));
router.post('/libraries/:id/shares/:shareId/resend', requireScope('write'), needUuid('id', 'Library'), needUuid('shareId', 'Share'), (req, res, next) =>
  forward(req, res, next, librariesRouter, { method: 'POST', url: `${idPath(req)}/shares/${enc(req.params.shareId)}/resend`, body: {} }));
router.get('/libraries/:id/access', requireScope('read'), needUuid('id', 'Library'), (req, res, next) =>
  forward(req, res, next, accessRouter, { method: 'GET', url: `/libraries${idPath(req)}`, query: req.query.folder !== undefined ? { folder: String(req.query.folder) } : {} }));
router.get('/files/:id/access', requireScope('read'), needUuid('id', 'File'), (req, res, next) => forward(req, res, next, accessRouter, { method: 'GET', url: `/files${idPath(req)}` }));
router.get('/files/:id/grants', requireScope('read'), needUuid('id', 'File'), (req, res, next) => forward(req, res, next, filesRouter, { method: 'GET', url: `${idPath(req)}/access` }));
router.put('/files/:id/grants', requireScope('write'), needUuid('id', 'File'), (req, res, next) =>
  forward(req, res, next, filesRouter, { method: 'PUT', url: `${idPath(req)}/access`, body: { email: req.body?.email, permission: req.body?.permission } }));
router.delete('/files/:id/grants/:grantId', requireScope('write'), needUuid('id', 'File'), needUuid('grantId', 'Grant'), (req, res, next) =>
  forward(req, res, next, filesRouter, { method: 'DELETE', url: `${idPath(req)}/access/${enc(req.params.grantId)}` }));
router.post('/files/:id/grants/resend', requireScope('write'), needUuid('id', 'File'), (req, res, next) =>
  forward(req, res, next, filesRouter, { method: 'POST', url: `${idPath(req)}/access/resend`, body: { email: req.body?.email } }));

// ---- libraries: putting one away, giving it an owner, taking over a leaver's ----
router.put('/libraries/:id/archived', adminOnly, needUuid('id', 'Library'), (req, res, next) =>
  forward(req, res, next, librariesRouter, { method: 'PUT', url: `${idPath(req)}/archived`, body: { archived: req.body?.archived === true } }));
router.post('/libraries/:id/owner', adminOnly, needUuid('id', 'Library'), (req, res, next) =>
  forward(req, res, next, librariesRouter, { method: 'POST', url: `${idPath(req)}/owner`, body: { owner_email: req.body?.owner_email } }));
router.post('/libraries/:id/reassign', adminOnly, needUuid('id', 'Library'), (req, res, next) =>
  forward(req, res, next, librariesRouter, { method: 'POST', url: `${idPath(req)}/reassign`, body: { owner_email: req.body?.owner_email } }));
router.post('/libraries/:id/adopt', requireScope('write'), needUuid('id', 'Library'), (req, res, next) =>
  forward(req, res, next, librariesRouter, { method: 'POST', url: `${idPath(req)}/adopt`, body: { path: req.body?.folder } }));

// ---- administration ----
// Four things are changed in Depot itself and never here: the storage encryption key,
// the sign-in methods, backup destinations and the updater.
const APP_ONLY_SETTING = (k) => k === 'storage_encryption_key' || k === 'confirm_key_change' || /^login_/.test(k) || /^backup_/.test(k);
router.get('/admin/settings', adminOnly, (req, res, next) =>
  forwardShaped(req, res, next, settingsRouter, { method: 'GET', url: '/' }, (body) => Object.fromEntries(Object.entries(body).filter(([k]) => !APP_ONLY_SETTING(k)))));
router.patch('/admin/settings', adminOnly, (req, res, next) => {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const keys = Object.keys(body);
  if (!keys.length) return res.status(400).json({ error: 'Send an object of the settings to change' });
  const held = keys.filter(APP_ONLY_SETTING);
  if (held.length) return res.status(400).json({ error: `Changed in Depot itself, not through the API: ${held.join(', ')}` });
  const unknown = keys.filter((k) => !(k in settingsLib.ENV_MAP));
  if (unknown.length) return res.status(400).json({ error: `Not a setting: ${unknown.join(', ')}` });
  return forward(req, res, next, settingsRouter, { method: 'PUT', url: '/', body });
});
router.get('/admin/editor', adminOnly, (req, res, next) => forward(req, res, next, editorRouter, { method: 'GET', url: '/' }));
router.put('/admin/editor', adminOnly, (req, res, next) => forward(req, res, next, editorRouter, { method: 'PUT', url: '/', body: { enabled: req.body?.enabled } }));
router.get('/admin/files', adminOnly, (req, res, next) => forward(req, res, next, adminRouter, { method: 'GET', url: '/files', query: req.query }));
router.get('/admin/stats', adminOnly, (req, res, next) => forward(req, res, next, adminRouter, { method: 'GET', url: '/stats' }));
router.get('/admin/usage', adminOnly, (req, res, next) => forward(req, res, next, adminRouter, { method: 'GET', url: '/usage' }));
router.get('/admin/activity', adminOnly, (req, res, next) => forward(req, res, next, adminRouter, { method: 'GET', url: '/activity', query: req.query }));
router.get('/admin/activity.csv', adminOnly, (req, res, next) => forward(req, res, next, adminRouter, { method: 'GET', url: '/activity.csv', query: req.query }));
router.get('/admin/compliance', adminOnly, (req, res, next) => forward(req, res, next, adminRouter, { method: 'GET', url: '/compliance' }));
router.patch('/admin/compliance', adminOnly, (req, res, next) => forward(req, res, next, adminRouter, { method: 'PUT', url: '/compliance', body: { enabled: req.body?.enabled } }));
router.post('/admin/compliance/probe', adminOnly, (req, res, next) => forward(req, res, next, adminRouter, { method: 'POST', url: '/compliance/probe', body: {} }));
router.put('/admin/compliance/attest', adminOnly, (req, res, next) =>
  forward(req, res, next, adminRouter, { method: 'PUT', url: '/compliance/attest', body: { control_id: req.body?.control_id, met: req.body?.met, note: req.body?.note } }));
router.get('/admin/compliance/audit-verify', adminOnly, (req, res, next) => forward(req, res, next, adminRouter, { method: 'GET', url: '/compliance/audit-verify' }));
router.get('/admin/compliance/evidence', adminOnly, (req, res, next) => forward(req, res, next, adminRouter, { method: 'GET', url: '/compliance/evidence' }));
router.get('/admin/compliance/evidence.md', adminOnly, (req, res, next) => forward(req, res, next, adminRouter, { method: 'GET', url: '/compliance/evidence.md' }));
router.get('/admin/access-review', adminOnly, (req, res, next) => forward(req, res, next, adminRouter, { method: 'GET', url: '/access-review' }));
router.get('/admin/access-review.csv', adminOnly, (req, res, next) => forward(req, res, next, adminRouter, { method: 'GET', url: '/access-review.csv' }));
router.get('/admin/tokens', adminOnly, (req, res, next) => forward(req, res, next, tokensRouter, { method: 'GET', url: '/all' }));
router.delete('/admin/tokens/:id', adminOnly, needUuid('id', 'Token'), (req, res, next) => forward(req, res, next, tokensRouter, { method: 'DELETE', url: `/all${idPath(req)}` }));
router.get('/admin/connectors', adminOnly, (req, res, next) => forward(req, res, next, connectorsRouter, { method: 'GET', url: '/' }));
router.get('/admin/connectors/kinds', adminOnly, (req, res, next) => forward(req, res, next, connectorsRouter, { method: 'GET', url: '/kinds' }));
router.post('/admin/connectors', adminOnly, (req, res, next) => forward(req, res, next, connectorsRouter, { method: 'POST', url: '/', body: req.body || {} }));
router.patch('/admin/connectors/:id', adminOnly, needUuid('id', 'Connection'), (req, res, next) => forward(req, res, next, connectorsRouter, { method: 'PUT', url: idPath(req), body: req.body || {} }));
router.delete('/admin/connectors/:id', adminOnly, needUuid('id', 'Connection'), (req, res, next) => forward(req, res, next, connectorsRouter, { method: 'DELETE', url: idPath(req) }));
router.post('/admin/connectors/:id/test', adminOnly, needUuid('id', 'Connection'), (req, res, next) => forward(req, res, next, connectorsRouter, { method: 'POST', url: `${idPath(req)}/test`, body: {} }));
router.get('/admin/license', adminOnly, (req, res, next) => forward(req, res, next, licenseRouter, { method: 'GET', url: '/' }));
router.get('/admin/security', adminOnly, (req, res, next) => forward(req, res, next, securityRouter, { method: 'GET', url: '/status' }));

router.use((_req, res) => res.status(404).json({ error: 'No such endpoint. The reference is at /api/docs' }));
// eslint-disable-next-line no-unused-vars
router.use((err, _req, res, _next) => { if (!res.headersSent) res.status(err?.status || 500).json({ error: err?.message || 'Server error' }); });

module.exports = router;

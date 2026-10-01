// Fixture overrides for "What the people you share with see" (id recipient).
//
// This chapter shows the public pages an outside recipient lands on: /s/<token> (one file,
// lib/exchangePage.js) and /f/<token> (a folder, lib/folderPage.js). Those pages are plain
// HTML the real server renders, not the SPA — demo/server.js already serves them for any
// token (see the /s/ and /f/ handlers there) and they call the API paths mocked below.
//
// File links reuse base.js's world.LINKS as-is (same tokens "My links" already shows), so
// this chapter stays consistent with that one: Northfield Clinic proposal (active, can send
// files back), Harbor Point Dental proposal (password), Team offsite photo (expired).
//
// Folder links add one to base.js's world.FOLDER_LINKS: alongside the existing link to just
// the "Site photos" subfolder, Jordan also gave Dana Whitfield a live link to the whole
// Northfield Clinic folder, so this chapter can show a folder link with a subfolder inside
// it, and "Add your files", in the same picture. Nothing else reads this extra link, so it
// cannot conflict with the "My links" chapter's own fixture.
'use strict';
const { world } = require('./base');
const { F, FILES, LINKS, FOLDER_LINKS, ME, ahead, DAY } = world;

// The default an administrator has not changed (server/lib/externalChunks.js DEFAULTS.link_upload_max_mb).
const MAX_UPLOAD_MB = 10240;
// Shown only as the locked prompt in this chapter and never actually typed, so it is made
// up fresh each run: nothing that looks like a password is kept in the repository.
const DEMO_PASSWORD = require('crypto').randomBytes(12).toString('base64url');

const NC_TOKEN = 'demo-folder-northfield-clinic';
const NC_ROOT_FILES = [F['Kickoff agenda'], F['Project schedule'], F['Floor plan']];
const NC_SUB_FILES = [F['Reception'], F['Waiting room']];
const NC_NAME = 'Northfield Clinic';
const NC_EXPIRES = ahead(60 * DAY);

const fileLink = (token) => LINKS.find((l) => l.token === token) || null;
const folderLink = (token) => FOLDER_LINKS.find((l) => l.token === token) || null;
const basename = (n) => String(n).split('/').pop();
const sumSize = (docs) => docs.reduce((n, d) => n + (d ? d.size : 0), 0);

function fileInfo(l, req) {
  const needsPassword = !!l.password;
  const supplied = req.headers['x-share-password'];
  const unlocked = !needsPassword || supplied === DEMO_PASSWORD;
  return {
    name: unlocked ? basename(l.doc.name) : null,
    size: unlocked ? l.doc.size : null,
    sentBy: unlocked ? ME.email : null,
    expiresAt: l.expires,
    needsPassword,
    unlocked,
    allowUpload: unlocked ? !!l.allow_upload : false,
    maxUploadMb: MAX_UPLOAD_MB,
  };
}

function ncFolderInfo(sub) {
  const atRoot = !sub;
  const files = (atRoot ? NC_ROOT_FILES : NC_SUB_FILES).map((f) => ({ id: f.id, name: basename(f.name), size: f.size }));
  const folders = atRoot
    ? [{ name: 'Site photos', path: 'Site photos', files: NC_SUB_FILES.length, bytes: sumSize(NC_SUB_FILES) }]
    : [];
  return {
    name: NC_NAME, needsPassword: false, unlocked: true, expiresAt: NC_EXPIRES,
    sentBy: ME.email, path: sub || '', live: true, folders, files,
    allowUpload: true, maxUploadMb: MAX_UPLOAD_MB,
    bytes: sumSize(NC_ROOT_FILES) + sumSize(NC_SUB_FILES), count: NC_ROOT_FILES.length + NC_SUB_FILES.length,
    zip: { allowed: true, limitMb: 500 },
  };
}

function genericFolderInfo(l) {
  const docs = l.docs.map((id) => FILES.find((f) => f.id === id)).filter(Boolean);
  return {
    name: basename(l.path), needsPassword: false, unlocked: true, expiresAt: l.expires,
    sentBy: ME.email, path: '', live: !!l.live, folders: [],
    files: docs.map((d) => ({ id: d.id, name: basename(d.name), size: d.size })),
    allowUpload: !!l.allow_upload, maxUploadMb: MAX_UPLOAD_MB,
    bytes: sumSize(docs), count: docs.length,
    zip: { allowed: true, limitMb: 500 },
  };
}

exports.routes = {
  // ---- /s/<token> — one file (server/routes/files.js loadExchangeLink + /info) ----
  'GET /api/files/share/:token/info': ({ params, req }) => {
    const l = fileLink(params.token);
    if (!l) return { __status: 404, body: { error: 'not_found' } };
    if (l.state === 'revoked') return { __status: 404, body: { error: 'not_found' } };
    if (l.state === 'expired') return { __status: 410, body: { error: 'expired' } };
    return fileInfo(l, req);
  },
  'POST /api/files/share/:token/opened': ({ params }) => (fileLink(params.token) ? { ok: true } : { __status: 404, body: { error: 'not_found' } }),
  'POST /api/files/share/:token/ticket': ({ params, req }) => {
    const l = fileLink(params.token);
    if (!l) return { __status: 404, body: { error: 'not_found' } };
    if (l.password && req.headers['x-share-password'] !== DEMO_PASSWORD) return { __status: 401, body: { error: 'Password required' } };
    return { ticket: 'demo-ticket' };
  },
  'POST /api/files/share/:token/upload': { ok: true, done: true, received: 1 },

  // ---- /f/<token> — a folder (server/routes/files/folders.js) ----
  'GET /api/files/folder/share/:token/info': ({ params, query }) => {
    if (params.token === NC_TOKEN) return ncFolderInfo(query.path || '');
    const l = folderLink(params.token);
    if (!l) return { __status: 404, body: { error: 'Share link not found' } };
    if (l.state === 'expired') return { __status: 410, body: { error: 'Share link expired' } };
    return genericFolderInfo(l);
  },
  'POST /api/files/folder/share/:token/opened': ({ params }) =>
    (params.token === NC_TOKEN || folderLink(params.token)) ? { ok: true } : { __status: 404, body: { error: 'Share link not found' } },
  'POST /api/files/folder/share/:token/ticket': { ticket: 'demo-ticket' },
  'GET /api/files/folder/share/:token/zip': { ok: true },
  'GET /api/files/folder/share/:token/file/:docId': { ok: true },
  'POST /api/files/folder/share/:token/upload': { ok: true, done: true, name: 'demo.pdf' },
};

exports.NC_TOKEN = NC_TOKEN;
